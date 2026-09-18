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
//!   - Radio on/off (`radio_status` / `set_radio`) — via the shared
//!     `Windows.Devices.Radios` helper in `radio.rs` (also used by `wifi.rs`).
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

use crate::radio::{self, win_err};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use windows::core::{Ref, HSTRING};
use windows::Devices::Bluetooth::{
    BluetoothConnectionStatus, BluetoothDevice, BluetoothLEDevice, BluetoothMajorClass,
};
use windows::Devices::Enumeration::{
    DeviceInformation, DeviceInformationCustomPairing, DeviceInformationUpdate,
    DevicePairingKinds, DevicePairingRequestedEventArgs, DeviceWatcher,
};
use windows::Devices::Radios::{Radio, RadioKind, RadioState};
use windows::Foundation::TypedEventHandler;

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
    match radio::find_radio(RadioKind::Bluetooth) {
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
    radio::set_radio(RadioKind::Bluetooth, on)
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
    radio::ensure_winrt();
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
    radio::ensure_winrt();
    let hid = HSTRING::from(id);
    let info = DeviceInformation::CreateFromIdAsync(&hid)
        .map_err(win_err)?
        .get()
        .map_err(win_err)?;
    let pairing = info.Pairing().map_err(win_err)?;
    if !pairing.IsPaired().unwrap_or(false) {
        return Ok(());
    }
    let result = pairing.UnpairAsync().map_err(win_err)?.get().map_err(win_err)?;
    // Trust `UnpairAsync`'s own result status rather than re-reading
    // `pairing.IsPaired()` afterward — `pairing`/`info` are a snapshot
    // from `CreateFromIdAsync` and don't refresh in place, so a
    // successful unpair could still read back stale "still paired"
    // data here and get misreported as a failure.
    use windows::Devices::Enumeration::DeviceUnpairingResultStatus as S;
    let status = result.Status().map_err(win_err)?;
    if status == S::Unpaired || status == S::AlreadyUnpaired {
        Ok(())
    } else {
        Err(format!("Windows could not forget this device ({status:?})"))
    }
}

/// Discover nearby devices Windows hasn't paired with yet. Uses a
/// `DeviceWatcher` (not a one-shot `FindAllAsync`) — that's what actually
/// triggers a fresh classic inquiry + LE advertisement scan, same as
/// Windows' own "Add device" flyout. Runs for a fixed window (classic
/// inquiry is slow to populate) then stops and returns whatever it found.
///
/// `deadline` bounds the *entire* call — the inquiry window AND the
/// per-device `FromIdAsync(...).get()` lookups that follow. Returns
/// whatever was found so far when the budget expires. Without this
/// bound, a wedged WinRT call on a wedged Bluetooth stack would
/// pin the calling `spawn_blocking` worker indefinitely.
pub fn scan(seconds: u64, deadline: std::time::Instant) -> Vec<BluetoothDeviceEntry> {
    radio::ensure_winrt();
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
        // Bounded inquiry window — bail early if the surrounding deadline
        // passes, so the watcher can't pin the worker past the budget.
        let _ = crate::cmd::bounded_sleep_until(deadline, seconds * 1000);
        let _ = watcher.Stop();

        let infos = found.lock().unwrap().clone();
        let mut out = Vec::with_capacity(infos.len());
        for info in infos {
            // Bail on deadline so a wedged `describe_device` (which calls
            // WinRT `FromIdAsync(...).get()`) can't pin the worker. Whatever
            // we've collected so far is returned.
            if std::time::Instant::now() >= deadline {
                break;
            }
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

/// Pair with a discovered device by id.
///
/// A bare `DeviceInformationPairing::PairAsync()` (no custom handler)
/// reliably fails with `Failed` even for "Just Works" devices that need
/// no user interaction at all — per Microsoft's own pairing-ceremony
/// docs, the protocol stack won't complete pairing unless *some* pairing
/// handler is registered, even one that just accepts immediately. So we
/// register a minimal custom handler and only declare support for
/// `ConfirmOnly` (the ceremony with nothing to show/type — covers the
/// overwhelming majority of modern peripherals): the handler
/// auto-accepts it, and `PairAsync` is called with only that kind, so
/// Windows fails the negotiation itself (rather than us guessing from an
/// opaque status) for devices that need a PIN or numeric-comparison
/// prompt. That's a deliberate scope cut — see the module doc comment.
pub fn pair(id: &str) -> Result<(), String> {
    radio::ensure_winrt();
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
    let custom = pairing.Custom().map_err(win_err)?;
    let token = custom
        .PairingRequested(&TypedEventHandler::new(
            |_sender: Ref<'_, DeviceInformationCustomPairing>,
             args: Ref<'_, DevicePairingRequestedEventArgs>| {
                if let Some(args) = args.as_ref() {
                    let is_confirm_only = args
                        .PairingKind()
                        .map(|k| k == DevicePairingKinds::ConfirmOnly)
                        .unwrap_or(false);
                    if is_confirm_only {
                        let _ = args.Accept();
                    }
                    // Any other kind: don't accept — PairAsync below only
                    // declared ConfirmOnly support, so leaving this
                    // un-accepted surfaces as a normal pairing failure.
                }
                Ok(())
            },
        ))
        .map_err(win_err)?;
    let result = custom
        .PairAsync(DevicePairingKinds::ConfirmOnly)
        .map_err(win_err)?
        .get()
        .map_err(win_err)?;
    let _ = custom.RemovePairingRequested(token);
    let status = result.Status().map_err(win_err)?;
    use windows::Devices::Enumeration::DevicePairingResultStatus as S;
    if status == S::Paired || status == S::AlreadyPaired {
        Ok(())
    } else {
        Err("This device needs a PIN or confirmation — pair it from Windows Bluetooth settings instead".to_string())
    }
}

// --- push notifications -----------------------------------------------------
// Subscribe to `Radio::StateChanged` for the Bluetooth radio and emit
// `bluetooth-radio-changed` so the frontend's chip re-reads even when the
// toggle happened outside Moonblast (Windows Quick Settings flyout, OS
// settings, hardware kill switch, group-policy flip). Mirrors audio.rs's
// `WATCH` static + `ensure_watch` pattern, minus the COM vtable — the
// `windows` typed bindings already expose `Radio::StateChanged` as a
// regular `TypedEventHandler` event.
//
// Process-lifetime subscription: we deliberately don't store the
// `EventRegistrationToken` (the type isn't re-exported by the `windows`
// crate's bindings anyway). The Radio handle keeps the delegate alive
// for the duration of the process, and process exit handles the
// unsubscribe — same shape as the `DeviceWatcher::Added/Updated`
// subscriptions in `scan()`, which also discard their tokens.
//
// Idempotent: calling `ensure_watch` repeatedly is a no-op once the
// first call arms.

struct WatchState {
    app: AppHandle,
    #[allow(dead_code)]
    radio: Radio,
}

// Tauri requires `Send` for state stored in `tauri::State` and for many of
// its own internals; the `windows` crate's Radio and AppHandle are both
// `Send` already (Radio wraps an `IInspectable` COM pointer which is
// apartment-aware, but our subscription fires on the WinRT thread pool
// and we don't touch the COM pointer from outside the callback, so the
// constraint is safe).
unsafe impl Send for WatchState {}
unsafe impl Sync for WatchState {}

static WATCH: Mutex<Option<WatchState>> = Mutex::new(None);

fn emit_bluetooth_radio_changed() {
    if let Some(app) = WATCH.lock().ok().and_then(|g| g.as_ref().map(|s| s.app.clone())) {
        let _ = app.emit("bluetooth-radio-changed", ());
    }
}

/// Subscribe to the Bluetooth radio's `StateChanged` event. Idempotent:
/// calling on every read command is fine — the first call arms, subsequent
/// calls no-op until the radio handle changes (which it doesn't on a
/// single machine). Failures (no radio, WinRT hiccup) are logged and
/// swallowed — the chip falls back to focus/visibility refreshes.
pub fn ensure_watch(app: AppHandle) {
    // Fast path: if we already hold a watch, the radio hasn't changed
    // (and we have no equivalent of audio.rs's `device_default_changed`
    // callback to tear us down on radio hot-swap — see the comment on
    // the dead-USB-adapter scenario above). Skip the WinRT enumeration
    // (`Radio::GetRadiosAsync()` is an async WinRT op that marshals
    // and can yield the worker thread) — on a busy session this saves
    // a round-trip per chip read / focus / visibility event.
    //
    // Mirrors audio.rs's `ensure_watch` fast path (added in e6ed532).
    if let Ok(guard) = WATCH.lock() {
        if guard.is_some() {
            return;
        }
    }
    let radio = match radio::find_radio(RadioKind::Bluetooth) {
        Ok(Some(r)) => r,
        _ => return, // no bluetooth radio at all — chip stays hidden
    };
    let mut guard = match WATCH.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    // Defense in depth: if the watch survived (lock-poison recovery or
    // re-entry between the fast-path lock-release and this re-acquire),
    // no-op — the previous registration is still live.
    if guard.is_some() {
        return;
    }
    let token = match radio.StateChanged(&TypedEventHandler::new(
        |_sender: Ref<'_, Radio>, _args| {
            // WinRT calls us on its own thread. We don't touch any audio
            // state — just emit, and the frontend's `read(true)` does the
            // single bounded `bluetooth_radio_status` IPC. Collapse window
            // absorbs bursts (e.g. multiple transitions from a flaky
            // airplane-mode toggle).
            emit_bluetooth_radio_changed();
            Ok(())
        },
    )) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[bluetooth] failed to subscribe StateChanged: {e}");
            return;
        }
    };
    // We deliberately don't store or use the token — this is a
    // process-lifetime subscription, mirroring the existing watcher
    // subscription in `scan()` (which also discards the Added/Updated
    // tokens). The Radio handle keeps the delegate alive; tearing down
    // on process exit handles the unsubscribe.
    let _ = token;
    *guard = Some(WatchState {
        app,
        radio,
    });
}
