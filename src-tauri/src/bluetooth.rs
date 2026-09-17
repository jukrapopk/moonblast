//! Bluetooth access for Moonblast, via the WinRT `Windows.Devices.Bluetooth`
//! / `Windows.Devices.Enumeration` / `Windows.Devices.Radios` APIs.
//!
//! Unlike WiFi, Windows has no `netsh`-equivalent CLI for Bluetooth — there
//! is no supported shell-out path for discovery or pairing. The WinRT APIs
//! are what Windows' own Bluetooth Settings page and Quick Settings flyout
//! are built on, so that's what we drive here (via the `windows` crate,
//! already a dependency for `hdr.rs`).
//!
//! Scope, deliberately kept modest:
//!   - Radio on/off (`radio_status` / `set_radio`) — reliable and simple,
//!     unlike the WiFi radio situation that pushed that module to defer to
//!     OS settings.
//!   - Paired-device list with live connected state + a best-effort device
//!     kind (from the classic Bluetooth class-of-device; LE-only devices
//!     fall back to a generic kind since BLE has no equivalent field).
//!   - Forget (unpair).
//!   - Discovery (`scan`) + pairing (`pair`) for devices Windows hasn't
//!     seen before.
//!
//! Pairing uses the *default* `DeviceInformationPairing::PairAsync()` —
//! i.e. no custom pairing handler. This succeeds silently for "Just Works"
//! devices (the overwhelming majority of modern Bluetooth peripherals:
//! audio, mice, keyboards, phones). Devices that require a PIN prompt or
//! numeric-comparison confirmation fail with a clear error instead of
//! hanging — same "handle the common case in-app, fall back to OS
//! settings for the exotic one" shape as WiFi's Enterprise-auth fallback.
//! A custom `DeviceInformationCustomPairing` handler (to support PIN /
//! numeric-comparison flows in-app) is a possible future enhancement, not
//! implemented here — it needs a mid-pairing round trip to the frontend
//! for user input, which is a lot of additional surface for a niche case.

#![cfg(windows)]

use windows::core::{Error as WinError, Ref, HSTRING};
use windows::Devices::Bluetooth::{
    BluetoothConnectionStatus, BluetoothDevice, BluetoothLEDevice, BluetoothMajorClass,
};
use windows::Devices::Enumeration::{DeviceInformation, DeviceInformationUpdate, DeviceWatcher};
use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};
use windows::Foundation::TypedEventHandler;

fn win_err(e: WinError) -> String {
    e.message()
}

/// Ensure the calling thread has a WinRT apartment. All commands in this
/// module run on a `spawn_blocking` worker thread, and WinRT calls need
/// `RoInitialize` on each such thread before any `Devices::*` call — the
/// pool doesn't guarantee the same thread across calls, and skipping this
/// makes the first call on a fresh thread fail with `CO_E_NOTINITIALIZED`.
/// Multithreaded (MTA) rather than STA: nothing here touches UI, and MTA
/// is a superset of what these APIs need. Errors (e.g. "already
/// initialized in a different mode") are ignored — either way COM/WinRT
/// is live on this thread afterward.
fn ensure_winrt() {
    use std::cell::Cell;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
    thread_local! {
        static INITED: Cell<bool> = const { Cell::new(false) };
    }
    INITED.with(|f| {
        if !f.get() {
            let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
            f.set(true);
        }
    });
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothRadioStatus {
    /// False when the machine has no Bluetooth radio at all — the UI hides
    /// the chip in that case, mirroring the battery/WiFi "no hardware"
    /// convention.
    pub supported: bool,
    pub on: bool,
    /// True when at least one paired device is currently connected —
    /// drives the chip's "connected" glyph. Always false when `!on`.
    pub connected: bool,
}

/// Read the Bluetooth radio's on/off state via `Windows.Devices.Radios` —
/// the same API Windows' own Quick Settings toggle uses — plus whether
/// any paired device is currently connected (for the chip's glyph).
pub fn radio_status() -> BluetoothRadioStatus {
    ensure_winrt();
    match find_bluetooth_radio() {
        Ok(Some(radio)) => match radio.State() {
            Ok(state) => {
                let on = state == RadioState::On;
                let connected = on && paired_devices().iter().any(|d| d.connected);
                BluetoothRadioStatus { supported: true, on, connected }
            }
            Err(_) => BluetoothRadioStatus { supported: false, on: false, connected: false },
        },
        _ => BluetoothRadioStatus { supported: false, on: false, connected: false },
    }
}

/// Turn the Bluetooth radio on or off.
pub fn set_radio(on: bool) -> Result<(), String> {
    ensure_winrt();
    let radio = find_bluetooth_radio()
        .map_err(win_err)?
        .ok_or_else(|| "No Bluetooth radio found".to_string())?;
    let state = if on { RadioState::On } else { RadioState::Off };
    let status = radio
        .SetStateAsync(state)
        .map_err(win_err)?
        .get()
        .map_err(win_err)?;
    if status == RadioAccessStatus::Allowed {
        Ok(())
    } else {
        Err(format!("Windows denied the request ({status:?})"))
    }
}

fn find_bluetooth_radio() -> windows::core::Result<Option<Radio>> {
    let radios = Radio::GetRadiosAsync()?.get()?;
    let size = radios.Size()?;
    for i in 0..size {
        let radio = radios.GetAt(i)?;
        if radio.Kind()? == RadioKind::Bluetooth {
            return Ok(Some(radio));
        }
    }
    Ok(None)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothDeviceEntry {
    /// Opaque WinRT device id — stable, used for pair/forget lookups.
    pub id: String,
    pub name: String,
    pub connected: bool,
    /// "audio" | "input" | "phone" | "computer" | "other". Only classic
    /// (BR/EDR) devices expose a class-of-device; LE-only devices always
    /// come back "other" (BLE has no equivalent field), which just means
    /// a generic glyph in the UI instead of a specific one.
    pub kind: String,
}

fn major_class_to_kind(c: BluetoothMajorClass) -> &'static str {
    match c {
        BluetoothMajorClass::AudioVideo => "audio",
        BluetoothMajorClass::Peripheral => "input",
        BluetoothMajorClass::Phone => "phone",
        BluetoothMajorClass::Computer => "computer",
        _ => "other",
    }
}

/// Best-effort connected+kind lookup for a device id. Tries the classic
/// (BR/EDR) API first (it's the only one with a class-of-device), falling
/// back to the LE API for connected state only.
fn describe_device(id: &HSTRING) -> (bool, String) {
    if let Ok(op) = BluetoothDevice::FromIdAsync(id) {
        if let Ok(dev) = op.get() {
            let connected = dev
                .ConnectionStatus()
                .map(|s| s == BluetoothConnectionStatus::Connected)
                .unwrap_or(false);
            let kind = dev
                .ClassOfDevice()
                .and_then(|c| c.MajorClass())
                .map(major_class_to_kind)
                .unwrap_or("other");
            return (connected, kind.to_string());
        }
    }
    if let Ok(op) = BluetoothLEDevice::FromIdAsync(id) {
        if let Ok(dev) = op.get() {
            let connected = dev
                .ConnectionStatus()
                .map(|s| s == BluetoothConnectionStatus::Connected)
                .unwrap_or(false);
            return (connected, "other".to_string());
        }
    }
    (false, "other".to_string())
}

/// Dual-mode devices (most modern audio/input peripherals) show up as
/// *two* separate `DeviceInformation` entries with the same name — one
/// from the classic (BR/EDR) selector, one from the LE selector, each
/// with its own id. `combined_selector` ORs the two selectors together
/// precisely so discovery/pairing catches LE-only devices too, but that
/// means every dual-mode device is naturally duplicated in the raw
/// result. Collapse by case-insensitive trimmed name, keeping whichever
/// duplicate is connected / has a specific kind over a generic one.
fn dedupe_by_name(entries: Vec<BluetoothDeviceEntry>) -> Vec<BluetoothDeviceEntry> {
    let mut by_name: Vec<(String, BluetoothDeviceEntry)> = Vec::with_capacity(entries.len());
    for entry in entries {
        let key = entry.name.trim().to_lowercase();
        if let Some((_, existing)) = by_name.iter_mut().find(|(k, _)| *k == key) {
            let better = (entry.connected, entry.kind != "other")
                > (existing.connected, existing.kind != "other");
            if better {
                *existing = entry;
            }
        } else {
            by_name.push((key, entry));
        }
    }
    by_name.into_iter().map(|(_, e)| e).collect()
}

/// AQS selector matching both classic and LE devices in a given pairing
/// state. WinRT's `FindAllAsync`/`CreateWatcher` only accept one selector
/// string, so the two device-family selectors are OR'd together — the
/// standard pattern for "any Bluetooth device" enumeration.
fn combined_selector(paired: bool) -> windows::core::Result<HSTRING> {
    let classic = BluetoothDevice::GetDeviceSelectorFromPairingState(paired)?;
    let le = BluetoothLEDevice::GetDeviceSelectorFromPairingState(paired)?;
    Ok(HSTRING::from(format!("({classic}) OR ({le})")))
}

/// Already-paired devices, for the modal's "Paired" section.
pub fn paired_devices() -> Vec<BluetoothDeviceEntry> {
    ensure_winrt();
    (|| -> windows::core::Result<Vec<BluetoothDeviceEntry>> {
        let filter = combined_selector(true)?;
        let devices = DeviceInformation::FindAllAsyncAqsFilter(&filter)?.get()?;
        let size = devices.Size()?;
        let mut out = Vec::with_capacity(size as usize);
        for i in 0..size {
            let info = devices.GetAt(i)?;
            let id = info.Id()?;
            let name = info.Name()?.to_string();
            let (connected, kind) = describe_device(&id);
            out.push(BluetoothDeviceEntry {
                id: id.to_string(),
                name,
                connected,
                kind,
            });
        }
        let mut out = dedupe_by_name(out);
        // Connected first, then alphabetical — mirrors the WiFi list's
        // "connected/known first" ordering.
        out.sort_by(|a, b| {
            b.connected
                .cmp(&a.connected)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    })()
    .unwrap_or_default()
}

/// Forget (unpair) a device by id. Idempotent — already-unpaired is
/// treated as success.
pub fn forget(id: &str) -> Result<(), String> {
    ensure_winrt();
    let hid = HSTRING::from(id);
    let info = DeviceInformation::CreateFromIdAsync(&hid)
        .map_err(win_err)?
        .get()
        .map_err(win_err)?;
    let pairing = info.Pairing().map_err(win_err)?;
    if !pairing.IsPaired().unwrap_or(false) {
        return Ok(());
    }
    let _ = pairing.UnpairAsync().map_err(win_err)?.get();
    if pairing.IsPaired().unwrap_or(false) {
        Err("Windows could not forget this device".to_string())
    } else {
        Ok(())
    }
}

/// Discover nearby devices Windows hasn't paired with yet. Uses a
/// `DeviceWatcher` (not a one-shot `FindAllAsync`) — that's what actually
/// triggers a fresh classic inquiry + LE advertisement scan, same as
/// Windows' own "Add device" flyout. Runs for a fixed window (classic
/// inquiry is slow to populate) then stops and returns whatever it found.
pub fn scan(seconds: u64) -> Vec<BluetoothDeviceEntry> {
    ensure_winrt();
    (|| -> windows::core::Result<Vec<BluetoothDeviceEntry>> {
        use std::sync::{Arc, Mutex};
        let filter = combined_selector(false)?;
        let watcher = DeviceInformation::CreateWatcherAqsFilter(&filter)?;
        let found: Arc<Mutex<Vec<DeviceInformation>>> = Arc::new(Mutex::new(Vec::new()));

        let added = found.clone();
        watcher.Added(&TypedEventHandler::new(
            move |_watcher: Ref<'_, DeviceWatcher>, info: Ref<'_, DeviceInformation>| {
                if let Some(info) = info.as_ref() {
                    added.lock().unwrap().push(info.clone());
                }
                Ok(())
            },
        ))?;
        // Devices can update (e.g. name resolves after the initial
        // advertisement) — treat Updated the same as Added by id so we
        // don't miss a device whose first sighting had a blank name.
        let updated = found.clone();
        watcher.Updated(&TypedEventHandler::new(
            move |_watcher: Ref<'_, DeviceWatcher>, update: Ref<'_, DeviceInformationUpdate>| {
                if let Some(update) = update.as_ref() {
                    if let Ok(id) = update.Id() {
                        let mut list = updated.lock().unwrap();
                        if let Some(existing) =
                            list.iter_mut().find(|d| d.Id().map(|i| i == id).unwrap_or(false))
                        {
                            let _ = existing.Update(update);
                        }
                    }
                }
                Ok(())
            },
        ))?;

        watcher.Start()?;
        std::thread::sleep(std::time::Duration::from_secs(seconds));
        let _ = watcher.Stop();

        let infos = found.lock().unwrap().clone();
        let mut out = Vec::with_capacity(infos.len());
        for info in infos {
            let id = info.Id()?;
            let name = info.Name().map(|n| n.to_string()).unwrap_or_default();
            if name.trim().is_empty() {
                continue; // unnamed devices aren't useful to show/pair with
            }
            let (connected, kind) = describe_device(&id);
            out.push(BluetoothDeviceEntry {
                id: id.to_string(),
                name,
                connected,
                kind,
            });
        }
        let mut out = dedupe_by_name(out);
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    })()
    .unwrap_or_default()
}

/// Pair with a discovered device by id. Uses the default (non-custom)
/// pairing flow — see the module doc comment for why. Returns a
/// human-readable error on failure, including the "needs a PIN" case so
/// the UI can suggest falling back to Windows' Bluetooth settings.
pub fn pair(id: &str) -> Result<(), String> {
    ensure_winrt();
    let hid = HSTRING::from(id);
    let info = DeviceInformation::CreateFromIdAsync(&hid)
        .map_err(win_err)?
        .get()
        .map_err(win_err)?;
    let pairing = info.Pairing().map_err(win_err)?;
    if pairing.IsPaired().unwrap_or(false) {
        return Ok(());
    }
    if !pairing.CanPair().unwrap_or(false) {
        return Err("This device can't be paired from here".to_string());
    }
    let result = pairing
        .PairAsync()
        .map_err(win_err)?
        .get()
        .map_err(win_err)?;
    let status = result.Status().map_err(win_err)?;
    // `DevicePairingResultStatus::Paired` is the only success value;
    // everything else (including the PIN/numeric-comparison cases we
    // deliberately don't drive) is surfaced as an error.
    use windows::Devices::Enumeration::DevicePairingResultStatus as S;
    if status == S::Paired || status == S::AlreadyPaired {
        Ok(())
    } else if status == S::ConnectionRejected
        || status == S::AuthenticationFailure
        || status == S::RejectedByHandler
    {
        Err("This device needs a PIN or confirmation — pair it from Windows Bluetooth settings instead".to_string())
    } else {
        Err(format!("Pairing failed ({status:?})"))
    }
}
