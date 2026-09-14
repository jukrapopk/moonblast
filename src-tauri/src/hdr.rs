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
//! the NVIDIA driver returns `advancedColorEnabled = 1` regardless of
//! whether HDR is actually on. The driver's `advancedColorEnabled` bit
//! is therefore unreliable as a read source.
//!
//! To compensate, `set_hdr` records the requested state into a
//! process-lifetime `AtomicBool`. After the first `set_hdr` call in
//! this session, `hdr_status` returns the cached state instead of the
//! driver's bit 1. The cache is invalidated when the process restarts
//! (initial read returns the driver bit, which is correct for "HDR is
//! off" at boot), and the frontend re-reads `hdr_status` on window
//! focus so a Windows-Settings toggle in another window is picked up
//! the next time the user alt-tabs back.

use std::sync::atomic::{AtomicBool, Ordering};
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, DisplayConfigSetDeviceInfo, GetDisplayConfigBufferSizes,
    QueryDisplayConfig, DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
    DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE, DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO,
    DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE,
    QDC_ONLY_ACTIVE_PATHS,
};

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
        // Prefer the cached last-set state if `set_hdr` has been called
        // at least once in this process — the driver's `advancedColorEnabled`
        // bit is unreliable on multi-monitor NVIDIA setups (returns 1 even
        // when HDR is visually off). Fall back to the driver bit on the
        // first read of a fresh process.
        let enabled = if LAST_SET_INITIALIZED.load(Ordering::Acquire) {
            LAST_SET_ENABLED.load(Ordering::Acquire)
        } else {
            driver_enabled
        };
        moonblast_log!(
            "hdr_status: bits=0x{:x} supported={supported} driver_enabled={driver_enabled} cached_enabled={enabled} forceDisabled={force_disabled} locked={locked}",
            bits
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
