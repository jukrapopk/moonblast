//! Per-monitor display brightness.
//!
//! Internal laptop panels are controlled through the WMI `root\wmi` classes
//! (`WmiMonitorBrightness` for the current value,
//! `WmiMonitorBrightnessMethods.WmiSetBrightness` to change it); external
//! monitors through DDC/CI (`dxva2`'s `GetMonitorBrightness` /
//! `SetMonitorBrightness`).
//!
//! Unlike volume, brightness has **no push-notification API** on Windows and
//! the hardware brightness keys don't produce a standard virtual key, so there
//! is deliberately **no polling** here: the Display modal reads on open /
//! monitor switch and writes through a throttled setter. The OSD is only shown
//! for changes made through Moonblast.
//!
//! The WMI path shells out to PowerShell (the same pattern `display.rs` already
//! uses for monitor names) because it is only hit on demand, never in a loop —
//! a per-tick PowerShell spawn was exactly the thing that made earlier
//! poll-based attempts miserable, and there is none of that here.

use std::time::Duration;

use serde::Serialize;
use windows_sys::Win32::Devices::Display::{
    DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR,
    GetPhysicalMonitorsFromHMONITOR, SetMonitorBrightness, PHYSICAL_MONITOR,
};
use windows_sys::Win32::Foundation::{BOOL, LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, DISPLAY_DEVICEW, HDC, HMONITOR,
    MONITORINFOEXW,
};

use crate::moonblast_log;

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BrightnessKind {
    /// Internal panel via WMI (0–100).
    Wmi,
    /// External monitor via DDC/CI (`min`/`max` come from the monitor).
    Ddc,
    /// No brightness control (desktop, or a monitor that reports neither).
    None,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Brightness {
    pub value: u32,
    pub min: u32,
    pub max: u32,
    pub kind: BrightnessKind,
}

impl Brightness {
    fn none() -> Self {
        Self { value: 0, min: 0, max: 100, kind: BrightnessKind::None }
    }
}

/// Read the brightness of `device_name` (`\\.\DISPLAYn`). Tries WMI first
/// (internal panel), then DDC/CI (external monitor).
pub fn get_for(device_name: Option<&str>) -> Brightness {
    let Some(device) = device_name.filter(|s| !s.is_empty()) else {
        return Brightness::none();
    };
    if let Some(code) = edid_code_for_device(device) {
        if let Some(value) = wmi_read(&code) {
            return Brightness {
                value: value.min(100),
                min: 0,
                max: 100,
                kind: BrightnessKind::Wmi,
            };
        }
    }
    if let Some(hmon) = hmonitor_for(device) {
        if let Some((min, cur, max)) = ddc_read(hmon) {
            return Brightness { value: cur, min, max, kind: BrightnessKind::Ddc };
        }
    }
    Brightness::none()
}

/// Set the brightness of `device_name`. `kind` is the value returned by
/// `get_for` (the frontend passes it back so we don't re-resolve per write).
pub fn set_for(device_name: Option<&str>, value: u32, kind: &str) -> Result<(), String> {
    let Some(device) = device_name.filter(|s| !s.is_empty()) else {
        return Err("No display selected".to_string());
    };
    match kind {
        "wmi" => {
            let code = edid_code_for_device(device)
                .ok_or_else(|| "Could not identify the display".to_string())?;
            wmi_set(&code, value.min(100))
        }
        "ddc" => {
            let hmon = hmonitor_for(device)
                .ok_or_else(|| "Could not locate the display".to_string())?;
            ddc_set(hmon, value)
        }
        // "none" (or an unknown kind) — nothing to control.
        _ => Ok(()),
    }
}

// --- identity --------------------------------------------------------------

/// Extract the EDID hardware id (`BNQ7F76`) for the GDI device `\\.\DISPLAYn`
/// by finding its adapter and reading monitor slot 0's `DeviceID`
/// (`MONITOR\BNQ7F76\…`). That id is the same segment WMI uses in its
/// `DISPLAY\BNQ7F76\…` instance names.
fn edid_code_for_device(device_name: &str) -> Option<String> {
    unsafe {
        for i in 0..16 {
            let mut dev: DISPLAY_DEVICEW = std::mem::zeroed();
            dev.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
            if EnumDisplayDevicesW(std::ptr::null(), i, &mut dev, 0) == 0 {
                break;
            }
            let adapter = wstr(&dev.DeviceName);
            if !adapter.eq_ignore_ascii_case(device_name) {
                continue;
            }
            let adapter_wide = crate::cmd::to_wide(&adapter);
            let mut mon: DISPLAY_DEVICEW = std::mem::zeroed();
            mon.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
            if EnumDisplayDevicesW(adapter_wide.as_ptr(), 0, &mut mon, 0) == 0 {
                return None;
            }
            let id = wstr(&mon.DeviceID);
            return crate::display::edid_vendor_code_from_device_id(&id);
        }
    }
    None
}

struct MonitorSearch {
    target: String,
    found: HMONITOR,
}

unsafe extern "system" fn monitor_search_proc(
    hmon: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let ctx = &mut *(data as *mut MonitorSearch);
    let mut mi: MONITORINFOEXW = std::mem::zeroed();
    mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(hmon, &mut mi.monitorInfo) != 0 {
        let name = wstr(&mi.szDevice);
        if name.eq_ignore_ascii_case(&ctx.target) {
            ctx.found = hmon;
            return 0; // stop enumerating
        }
    }
    1 // continue
}

/// The `HMONITOR` whose `szDevice` matches `\\.\DISPLAYn`.
fn hmonitor_for(device_name: &str) -> Option<HMONITOR> {
    let mut ctx = MonitorSearch { target: device_name.to_string(), found: std::ptr::null_mut() };
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(monitor_search_proc),
            &mut ctx as *mut MonitorSearch as LPARAM,
        );
    }
    if ctx.found.is_null() {
        None
    } else {
        Some(ctx.found)
    }
}

// --- DDC/CI (external monitors) --------------------------------------------

fn ddc_read(hmon: HMONITOR) -> Option<(u32, u32, u32)> {
    unsafe {
        let mut count = 0u32;
        if GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut count) == 0 || count == 0 {
            return None;
        }
        let mut monitors: Vec<PHYSICAL_MONITOR> =
            vec![std::mem::zeroed(); count as usize];
        if GetPhysicalMonitorsFromHMONITOR(hmon, count, monitors.as_mut_ptr()) == 0 {
            return None;
        }
        let handle = monitors[0].hPhysicalMonitor;
        let (mut min, mut cur, mut max) = (0u32, 0u32, 0u32);
        let ok = GetMonitorBrightness(handle, &mut min, &mut cur, &mut max);
        DestroyPhysicalMonitors(count, monitors.as_ptr());
        if ok == 0 {
            None
        } else {
            Some((min, cur, max))
        }
    }
}

fn ddc_set(hmon: HMONITOR, value: u32) -> Result<(), String> {
    unsafe {
        let mut count = 0u32;
        if GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut count) == 0 || count == 0 {
            return Err("No physical monitor".to_string());
        }
        let mut monitors: Vec<PHYSICAL_MONITOR> =
            vec![std::mem::zeroed(); count as usize];
        if GetPhysicalMonitorsFromHMONITOR(hmon, count, monitors.as_mut_ptr()) == 0 {
            return Err("Could not open the monitor".to_string());
        }
        let handle = monitors[0].hPhysicalMonitor;
        let ok = SetMonitorBrightness(handle, value);
        DestroyPhysicalMonitors(count, monitors.as_ptr());
        if ok == 0 {
            Err("The monitor rejected the brightness change".to_string())
        } else {
            Ok(())
        }
    }
}

// --- WMI (internal panels) -------------------------------------------------

fn wmi_read(code: &str) -> Option<u32> {
    let script = format!(
        "$m = Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBrightness | Where-Object {{ $_.InstanceName -like 'DISPLAY\\{code}\\*' }}; if ($m) {{ $m.CurrentBrightness }} else {{ '' }}"
    );
    powershell(&script)?.parse::<u32>().ok()
}

fn wmi_set(code: &str, value: u32) -> Result<(), String> {
    let script = format!(
        "$m = Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBrightnessMethods | Where-Object {{ $_.InstanceName -like 'DISPLAY\\{code}\\*' }}; if ($m) {{ [void]$m.WmiSetBrightness(0, {value}); 'ok' }} else {{ 'none' }}"
    );
    match powershell(&script).as_deref() {
        Some("ok") => Ok(()),
        Some(_) => Err("This display's brightness isn't controllable via WMI".to_string()),
        None => Err("Could not set brightness".to_string()),
    }
}

/// Run a one-shot PowerShell script (no window) and return trimmed stdout.
/// Bounded so a hung WMI call can't stall the command forever.
fn powershell(script: &str) -> Option<String> {
    let out = crate::cmd::run_output_bounded(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
        Duration::from_secs(5),
    )
    .ok()?;
    if !out.status.success() {
        moonblast_log!(
            "brightness: powershell exited {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Trim trailing NULs and convert a fixed-size UTF-16 buffer to a `String`.
fn wstr(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end]).trim().to_string()
}
