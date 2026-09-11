//! Detect and toggle Windows Advanced Color (HDR) on the primary display.
//!
//! Windows exposes HDR as a per-target capability through `DisplayConfig*`.
//! We enumerate the active paths, pick the first one, and use the
//! `DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO` /
//! `DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE` packets to read + flip the
//! state.
//!
//! **Empirical note (this hardware/driver combo):**
//! The GET packet's u32 packs four 1-bit flags and 28 reserved bits. On
//! this NVIDIA driver the bitfields decode as:
//!   bit 0: advancedColorSupported         — panel + driver advertise HDR
//!   bit 1: advancedColorEnabled           — read-only capability flag (the
//!                                           OS reports it as "on" whenever
//!                                           the monitor supports HDR, even
//!                                           when the OS has actually dropped
//!                                           to SDR — so it doesn't reflect
//!                                           the user-visible state)
//!   bit 2: wideColorEnforced              — the user-visible "HDR/wide
//!                                           color gamut" mode the OS is
//!                                           currently running. This is the
//!                                           bit that actually moves on
//!                                           SET, so we use it as the
//!                                           toggle's "enabled" value.
//!   bit 3: advancedColorForceDisabled     — system policy disables HDR
//!
//! The SET packet's u32 bit 0 acts as "wide color off" on this driver
//! (value=1 toggles `wideColorEnforced` from true→false; value=0 sets it
//! true when currently false, or no-ops when already true). The MS docs
//! call this `enableAdvancedColor`, but the observable behavior treats it
//! as a toggle of the wide-color / HDR-bundle state. We invert the user
//! intent: "turn HDR on" → send value=0, "turn HDR off" → send value=1.
//!
//! `advancedColorForceDisabled = 1` (system policy) still wins over user
//! toggles — we surface that as `locked = true` so the UI can disable the
//! switch.

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
    /// `true` when HDR is currently on (we derive this from `wideColorEnforced`
    /// since `advancedColorEnabled` doesn't reflect the user-visible state on
    /// every driver).
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

/// Look up the first active display path. Returns `(adapter_id, target_id)`
/// or `None` if there are no active paths / the API call fails.
///
/// `GetDisplayConfigBufferSizes` and `QueryDisplayConfig` both return
/// `WIN32_ERROR(0)` (= ERROR_SUCCESS) on success — any nonzero value is
/// treated as "no path".
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
        // With QDC_ONLY_ACTIVE_PATHS every returned path is by construction
        // active — just take the first.
        let p = &paths[0];
        Some((p.targetInfo.adapterId, p.targetInfo.id))
    }
}

/// `DisplayConfigGetDeviceInfo` returns the raw HRESULT as `i32`. Zero is
/// ERROR_SUCCESS; anything else is treated as "unsupported".
const fn hr_ok(hr: i32) -> bool {
    hr == 0
}

pub fn hdr_status() -> HdrStatus {
    unsafe {
        let Some((adapter_id, target_id)) = first_active_path() else {
            moonblast_log!("hdr_status: no active path");
            return HdrStatus::default();
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
        moonblast_log!(
            "hdr_status: adapter={:?} target={} bits=0x{:x}",
            adapter_id, target_id, bits
        );
        let supported = (bits & 0x1) != 0;
        // We use `wideColorEnforced` as the visible-state indicator because
        // `advancedColorEnabled` (bit 1) doesn't reflect the user-visible
        // mode on every driver — it's reported as "on" even when the OS
        // has dropped to SDR. `wideColorEnforced` is what the SET packet
        // actually toggles.
        let enabled = (bits & 0x4) != 0;
        let force_disabled = (bits & 0x8) != 0;
        let locked = force_disabled;
        moonblast_log!(
            "hdr_status: supported={supported} enabled(wideColor)={enabled} forceDisabled={force_disabled} locked={locked}"
        );
        HdrStatus { supported, enabled, locked }
    }
}

pub fn set_hdr(enabled: bool) -> Result<(), String> {
    unsafe {
        let (adapter_id, target_id) =
            first_active_path().ok_or_else(|| "No active display path found".to_string())?;
        let mut packet: DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE = std::mem::zeroed();
        packet.header.r#type = DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE;
        packet.header.size = std::mem::size_of::<DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE>() as u32;
        packet.header.adapterId = adapter_id;
        packet.header.id = target_id;
        // Empirically (this driver): value bit 0 = "wide color off". So to
        // turn HDR ON, we send 0; to turn HDR OFF, we send 1. The SDK
        // documents bit 0 as `enableAdvancedColor` which would suggest the
        // opposite, but the observable state on Windows 11 24H2 / NVIDIA
        // RTX 3080 Ti inverts that — see the module-level doc comment.
        packet.Anonymous.value = if enabled { 0 } else { 1 };
        let hr = DisplayConfigSetDeviceInfo(&packet.header);
        moonblast_log!(
            "set_hdr(enabled={enabled}): adapter={:?} target={} value=0x{:x} hr={hr}",
            adapter_id, target_id, packet.Anonymous.value
        );
        if !hr_ok(hr) {
            return Err(format!("DisplayConfigSetDeviceInfo failed (hr={hr})"));
        }
        Ok(())
    }
}
