//! Detect and toggle Windows Advanced Color (HDR) on the primary display.
//!
//! Uses `DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO` /
//! `DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE` to read + write the
//! `advancedColorEnabled` state on the first active display path.
//!
//! GET packet's u32 bitfield (verified against the SudoMaker Virtual
//! Display Adapter / NVIDIA RTX 3080 Ti driver on Windows 11 24H2):
//!   bit 0: advancedColorSupported       — panel + driver advertise HDR
//!   bit 1: advancedColorEnabled         — driver-reported HDR state
//!   bit 2: wideColorEnforced            — reserved 0 on this driver
//!   bit 3: advancedColorForceDisabled   — system policy disables HDR
//!
//! SET packet's `value` bit 0 is `enableAdvancedColor` per the SDK docs
//! (and per the probe): value=1 enables HDR, value=0 disables it.
//!
//! ## `enabled` field: process-lifetime cache of last-set state
//!
//! On multi-monitor setups (e.g. RTX 3080 Ti + secondary display),
//! the NVIDIA driver can return `advancedColorEnabled = 1` regardless of
//! whether HDR is actually on — the bit then reflects capability rather
//! than the active mode — so it is not trusted on its own.
//!
//! `set_hdr` therefore records the requested state into a
//! process-lifetime `AtomicBool`. After the first `set_hdr` call in
//! this session, `hdr_status` returns that cached state. Before it, the
//! cold-start state is resolved from the per-display `EnableHDR` value
//! Windows HDR Settings writes when it exists, and otherwise from the
//! driver's bit gated on a >= 10-bit scanout (see `hdr_status_for`). The
//! frontend re-reads `hdr_status` on window focus so a Windows-Settings
//! toggle in another window is picked up the next time the user
//! alt-tabs back.

use std::sync::atomic::{AtomicBool, Ordering};
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, DisplayConfigSetDeviceInfo, GetDisplayConfigBufferSizes,
    QueryDisplayConfig, DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
    DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE, DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO,
    DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE,
    QDC_ONLY_ACTIVE_PATHS,
};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
use winreg::RegKey;

use crate::moonblast_log;

#[derive(serde::Serialize, Clone, Copy)]
pub struct HdrStatus {
    /// `true` when the active target's driver + panel advertise HDR support.
    pub supported: bool,
    /// `true` when HDR is currently on.
    pub enabled: bool,
    /// `true` when the OS has locked the toggle (system policy forces HDR off).
    /// The HDR row is shown but disabled when this is set.
    pub locked: bool,
}

impl Default for HdrStatus {
    fn default() -> Self {
        Self { supported: false, enabled: false, locked: false }
    }
}

/// `DisplayConfigGetDeviceInfo` / `DisplayConfigSetDeviceInfo` return the
/// raw HRESULT as `i32`. Zero is ERROR_SUCCESS.
const fn hr_ok(hr: i32) -> bool {
    hr == 0
}

/// Last HDR state written by `set_hdr` in this process. `None` until the
/// first successful `set_hdr` call — initial reads fall back to the
/// driver's `advancedColorEnabled` bit.
static LAST_SET_ENABLED: AtomicBool = AtomicBool::new(false);
static LAST_SET_INITIALIZED: AtomicBool = AtomicBool::new(false);

/// Look up the first active display path. Returns `(adapter_id, target_id)`
/// or `None` if there are no active paths / the API call fails.
fn first_active_path() -> Option<(windows::Win32::Foundation::LUID, u32)> {
    unsafe {
        let mut num_paths: u32 = 0;
        let mut num_modes: u32 = 0;
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut num_paths, &mut num_modes).0 != 0
            || num_paths == 0
        {
            return None;
        }
        let mut paths: Vec<DISPLAYCONFIG_PATH_INFO> = vec![std::mem::zeroed(); num_paths as usize];
        let mut modes: Vec<DISPLAYCONFIG_MODE_INFO> = vec![std::mem::zeroed(); num_modes as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut num_paths,
            paths.as_mut_ptr(),
            &mut num_modes,
            modes.as_mut_ptr(),
            None,
        )
        .0 != 0
            || num_paths == 0
        {
            return None;
        }
        let p = &paths[0];
        Some((p.targetInfo.adapterId, p.targetInfo.id))
    }
}

pub fn hdr_status_for(adapter_low: u32, adapter_high: i32, target_id: u32) -> HdrStatus {
    unsafe {
        let adapter_id = windows::Win32::Foundation::LUID {
            LowPart: adapter_low,
            HighPart: adapter_high,
        };
        let mut info: DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO = std::mem::zeroed();
        info.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO;
        info.header.size = std::mem::size_of::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>() as u32;
        info.header.adapterId = adapter_id;
        info.header.id = target_id;
        let hr = DisplayConfigGetDeviceInfo(&mut info.header);
        if !hr_ok(hr) {
            moonblast_log!("hdr_status: GetDeviceInfo failed hr={hr}");
            return HdrStatus::default();
        }
        let bits = info.Anonymous.value;
        let supported = (bits & 0x1) != 0;
        let driver_enabled = (bits & 0x2) != 0;
        let force_disabled = (bits & 0x8) != 0;
        let locked = force_disabled;
        // `bitsPerColorChannel` rides in the same (v2) packet as the flags:
        // it is the *active scanout's* color depth. Advanced color is 10-bit
        // or deeper, so this is a real counter-check against a driver whose
        // bit 1 lies — it must be consulted before trusting that bit.
        let bits_per_color = info.bitsPerColorChannel;
        // Prefer the cached last-set state if `set_hdr` has been called
        // at least once in this process — the driver's `advancedColorEnabled`
        // bit is unreliable on some multi-monitor NVIDIA setups (it reflects
        // "HDR is supported" rather than "HDR is currently active").
        //
        // On the very first read of a fresh process there is no cache, so the
        // cold-start state resolves from, in order:
        //   1. the per-display `EnableHDR` value Windows HDR Settings writes
        //      (the user-facing truth) when it exists, else
        //   2. the driver's bit, gated on the scanout actually being wide
        //      (>= 10 bits per channel) whenever the driver reports a depth
        //      at all — so an 8-bit SDR mode is never read as HDR even when
        //      bit 1 is stuck on, while a driver that leaves the v2 depth
        //      field empty (0) still falls back to the bit.
        // A missing registry value must *not* mean "off": Windows HDR
        // Settings only writes it after its page has been opened for a
        // display, so treating absence as off threw away the only signal we
        // had and reported a genuinely-on HDR display as off (until the user
        // happened to flip our toggle, which seeds the cache). The registry is
        // read at most once per call and its result reused for the log too — a
        // second read inside the log would double the enumeration cost on
        // every `hdr_status` IPC (focus, visibility, modal open, after
        // `set_hdr`).
        let initialized = LAST_SET_INITIALIZED.load(Ordering::Acquire);
        let reg_enabled = if initialized { None } else { read_os_hdr_state_from_registry() };
        let enabled = if initialized {
            LAST_SET_ENABLED.load(Ordering::Acquire)
        } else {
            match reg_enabled {
                Some(reg) => reg,
                None => driver_enabled && (bits_per_color == 0 || bits_per_color >= 10),
            }
        };
        moonblast_log!(
            "hdr_status: bits=0x{:x} supported={supported} driver_enabled={driver_enabled} cached_enabled={} reg_enabled={reg_enabled:?} color_encoding={:?} bits_per_color={bits_per_color} enabled={enabled} forceDisabled={force_disabled} locked={locked}",
            bits,
            LAST_SET_ENABLED.load(Ordering::Acquire),
            info.colorEncoding,
        );
        HdrStatus { supported, enabled, locked }
    }
}

/// Convenience wrapper: HDR always targets the first active display path.
/// The Settings Monitor dropdown is for the resolution picker only — HDR
/// has no per-monitor targeting because the GDI-name-to-DisplayConfig-
/// adapterId mapping isn't exposed by any public Win32 API.
pub fn hdr_status() -> HdrStatus {
    let Some((adapter_id, target_id)) = first_active_path() else {
        moonblast_log!("hdr_status: no active path");
        return HdrStatus::default();
    };
    hdr_status_for(adapter_id.LowPart, adapter_id.HighPart, target_id)
}

/// Read the user-facing HDR state from the Windows registry.
///
/// On multi-monitor NVIDIA setups the `advancedColorEnabled` bit of
/// the DisplayConfig packet is unreliable — it returns `1` regardless
/// of whether HDR is actually on. The Settings → System → Display
/// "Use HDR" toggle, however, always writes a per-display `EnableHDR`
/// DWORD under
/// `HKCU\Software\Microsoft\Windows\CurrentVersion\VideoSettings\<subkey>`.
/// That subkey is the OS-level truth: read it and we know what the
/// user sees in Windows Settings, which is also what they expect
/// Moonblast to show.
///
/// Returns:
///   - `Some(true)` if any subkey has `EnableHDR = 1` (most setups
///     have a single HDR display; if multiple disagree we take the
///     "on" reading — the user just clicked it on somewhere).
///   - `Some(false)` if at least one subkey has `EnableHDR = 0` and
///     none are `1`.
///   - `None` if no `EnableHDR` values exist (the HDR Settings page has
///     never been opened for any display) — the caller then falls back
///     to the driver's bit, gated on a wide scanout.
fn read_os_hdr_state_from_registry() -> Option<bool> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(root) = hkcu.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\VideoSettings",
        KEY_READ,
    ) else {
        return None;
    };
    let subkeys: Vec<String> = root.enum_keys().filter_map(|k| k.ok()).collect();
    if subkeys.is_empty() {
        return None;
    }
    let mut saw_any = false;
    let mut any_on = false;
    for name in &subkeys {
        let Ok(sub) = root.open_subkey(name) else {
            continue;
        };
        if let Ok(v) = sub.get_value::<u32, _>("EnableHDR") {
            saw_any = true;
            if v != 0 {
                any_on = true;
            }
        }
    }
    if !saw_any {
        None
    } else {
        Some(any_on)
    }
}

pub fn set_hdr_for(
    adapter_low: u32,
    adapter_high: i32,
    target_id: u32,
    enabled: bool,
) -> Result<(), String> {
    unsafe {
        let adapter_id = windows::Win32::Foundation::LUID {
            LowPart: adapter_low,
            HighPart: adapter_high,
        };
        let mut packet: DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE = std::mem::zeroed();
        packet.header.r#type = DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE;
        packet.header.size = std::mem::size_of::<DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE>() as u32;
        packet.header.adapterId = adapter_id;
        packet.header.id = target_id;
        // Per the SDK docs + verified by probe: value bit 0 is
        // `enableAdvancedColor`. 1 = enable, 0 = disable.
        packet.Anonymous.value = if enabled { 1 } else { 0 };
        let hr = DisplayConfigSetDeviceInfo(&packet.header);
        moonblast_log!(
            "set_hdr(enabled={enabled}): value=0x{:x} hr={hr}",
            packet.Anonymous.value
        );
        if !hr_ok(hr) {
            return Err(format!("DisplayConfigSetDeviceInfo failed (hr={hr})"));
        }
        // Record the requested state so subsequent reads return what
        // we actually set, not the (unreliable) driver's bit 1.
        LAST_SET_ENABLED.store(enabled, Ordering::Release);
        LAST_SET_INITIALIZED.store(true, Ordering::Release);
        Ok(())
    }
}

/// Convenience wrapper — see `hdr_status`.
pub fn set_hdr(enabled: bool) -> Result<(), String> {
    let (adapter_id, target_id) =
        first_active_path().ok_or_else(|| "No active display path found".to_string())?;
    set_hdr_for(adapter_id.LowPart, adapter_id.HighPart, target_id, enabled)
}
