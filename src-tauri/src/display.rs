//! Display resolution + refresh rate enumeration and dynamic mode change.
//!
//! Uses `EnumDisplaySettingsExW` with no flags (i.e. not `EDS_RAWMODE`) so
//! the list matches what Windows Settings shows — monitor-compatible
//! modes only, current orientation only. The driver returns each
//! width×height×refresh combination once per call; we deduplicate by
//! (width, height) and collect every distinct refresh rate.
//!
//! `ChangeDisplaySettingsExW` with **no flags** applies a *dynamic* mode
//! change: the new resolution sticks for this session and reverts at the
//! next sign-out / reboot / graphics-adapter restart. That matches our
//! UX (10-second Keep/Revert) — we don't want to silently mutate the
//! user's registry-persisted resolution just because they were
//! experimenting in Moonblast.
//!
//! Multi-monitor: `list_monitors` enumerates active GDI adapters with
//! `EnumDisplayDevicesW`, returning each adapter's `DeviceName`
//! (`\\.\DISPLAY1`, `\\.\DISPLAY2`, …) and friendly `DeviceString`.
//! Every mode / apply command takes a `device_name` so the user can
//! target a specific monitor instead of the always-primary default.

use std::collections::HashMap;
use std::sync::Mutex;

use windows_sys::Win32::Graphics::Gdi::{
    ChangeDisplaySettingsExW, EnumDisplayDevicesW, EnumDisplaySettingsExW, DEVMODEW,
    DISPLAY_DEVICEW, ENUM_CURRENT_SETTINGS,
};

use crate::moonblast_log;

// DISPLAY_DEVICE_STATE_FLAGS bit values.
//   0x1 = DISPLAY_DEVICE_ACTIVE     — display is part of the virtual desktop
//   0x4 = DISPLAY_DEVICE_PRIMARY_DEVICE
// (DISPLAY_DEVICE_ATTACHED = 0x2 is checked elsewhere but not relied on
// for filtering — some drivers / RDP sessions don't set it.)
const DISPLAY_DEVICE_ACTIVE: u32 = 0x0000_0001;
const DISPLAY_DEVICE_PRIMARY_DEVICE: u32 = 0x0000_0004;

#[derive(serde::Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct DisplayMode {
    pub width: u32,
    pub height: u32,
    pub refresh_rate: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayOption {
    pub width: u32,
    pub height: u32,
    pub refresh_rates: Vec<u32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentDisplay {
    pub width: u32,
    pub height: u32,
    pub refresh_rate: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    /// `\\.\DISPLAY1`, `\\.\DISPLAY2`, … — the GDI device name. Pass to
    /// `display_modes` / `current_display` / `apply_display_mode` to
    /// target this monitor for resolution changes.
    pub device_name: String,
    /// Friendly name from `DISPLAY_DEVICE.DeviceString`, trimmed.
    pub friendly_name: String,
    /// `DISPLAY_DEVICE_PRIMARY_DEVICE` flag — the OS's primary monitor.
    pub primary: bool,
    /// `true` when the display is attached but not part of the virtual
    /// desktop (laptop screen off via Win+P, etc.). The frontend shows
    /// it in the picker but disables it.
    pub disabled: bool,
}

/// Last applied (but uncommitted) mode change per monitor, plus the
/// prior mode to revert to. Keyed by device name so two pending changes
/// on two different monitors don't stomp each other.
static PENDING_REVERT: Mutex<Option<(String, DisplayMode, DisplayMode)>> = Mutex::new(None);

fn hr_ok(hr: i32) -> bool {
    hr == 0 || hr == 1
    // DISP_CHANGE_SUCCESSFUL = 0, DISP_CHANGE_RESTART = 1 — both are
    // success for the dynamic path.
}

fn current_display_raw(device_name: Option<&str>) -> Option<DisplayMode> {
    // Build the wide-string once and keep it alive across the FFI call.
    let wide = device_name.map(device_name_to_wide);
    unsafe {
        let mut dm: DEVMODEW = std::mem::zeroed();
        dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        let target = wide.as_ref().map_or(std::ptr::null(), |w| w.as_ptr());
        let ok = EnumDisplaySettingsExW(target, ENUM_CURRENT_SETTINGS, &mut dm, 0);
        if ok == 0 {
            return None;
        }
        Some(DisplayMode {
            width: dm.dmPelsWidth,
            height: dm.dmPelsHeight,
            refresh_rate: dm.dmDisplayFrequency,
        })
    }
}

/// Enumerate every (width, height, refresh) the named monitor reports as
/// monitor-compatible. Deduped by resolution; refresh rates sorted
/// ascending. Pass `None` for the primary monitor.
pub fn display_modes_for(device_name: Option<&str>) -> Vec<DisplayOption> {
    use std::collections::BTreeMap;
    let mut by_res: BTreeMap<(u32, u32), Vec<u32>> = BTreeMap::new();
    // Bind the wide string up front so its pointer stays valid for the
    // whole enumeration loop.
    let wide = device_name.map(device_name_to_wide);
    let target = wide.as_ref().map_or(std::ptr::null(), |w| w.as_ptr());
    let mut i: u32 = 0;
    loop {
        let mut dm: DEVMODEW = unsafe { std::mem::zeroed() };
        dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        let ok = unsafe { EnumDisplaySettingsExW(target, i, &mut dm, 0) };
        if ok == 0 {
            break;
        }
        // Skip degenerate entries (driver may report 0×0 in some slots).
        if dm.dmPelsWidth > 0 && dm.dmPelsHeight > 0 && dm.dmDisplayFrequency > 0 {
            by_res
                .entry((dm.dmPelsWidth, dm.dmPelsHeight))
                .or_default()
                .push(dm.dmDisplayFrequency);
        }
        i += 1;
    }
    by_res
        .into_iter()
        .map(|((width, height), mut rates)| {
            rates.sort_unstable();
            rates.dedup();
            DisplayOption { width, height, refresh_rates: rates }
        })
        .collect()
}

pub fn current_display_for(device_name: Option<&str>) -> Result<CurrentDisplay, String> {
    let m = current_display_raw(device_name)
        .ok_or_else(|| "Could not read current display".to_string())?;
    Ok(CurrentDisplay {
        width: m.width,
        height: m.height,
        refresh_rate: m.refresh_rate,
    })
}

/// Apply a new resolution + refresh dynamically (no registry write).
/// Records the prior mode so `revert_display_mode` can roll back.
pub fn apply_display_mode_for(
    device_name: Option<&str>,
    width: u32,
    height: u32,
    refresh_rate: u32,
) -> Result<(), String> {
    let wide = device_name.map(device_name_to_wide);
    let target = wide.as_ref().map_or(std::ptr::null(), |w| w.as_ptr());
    let prior = current_display_raw(device_name)
        .ok_or_else(|| "Could not read current display".to_string())?;
    let hr = unsafe {
        let mut dm: DEVMODEW = std::mem::zeroed();
        dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        // DM_PELSWIDTH (0x00080000) | DM_PELSHEIGHT (0x00100000) | DM_DISPLAYFREQUENCY (0x00400000)
        dm.dmFields = 0x00580000;
        dm.dmPelsWidth = width;
        dm.dmPelsHeight = height;
        dm.dmDisplayFrequency = refresh_rate;
        ChangeDisplaySettingsExW(target, &dm, std::ptr::null_mut(), 0, std::ptr::null())
    };
    if !hr_ok(hr) {
        return Err(format!("ChangeDisplaySettingsEx failed ({hr})"));
    }
    // Key the pending revert by device name so concurrent changes on
    // different monitors don't clobber each other. `device_name` is "" for
    // the primary display (we passed None).
    let key = device_name.unwrap_or("").to_string();
    *PENDING_REVERT.lock().unwrap() = Some((
        key,
        DisplayMode { width, height, refresh_rate },
        prior,
    ));
    Ok(())
}

/// Roll back the mode that was active before the last `apply_display_mode`
/// for the named monitor. No-op when no change is pending for it.
pub fn revert_display_mode_for(device_name: Option<&str>) -> Result<(), String> {
    let key = device_name.unwrap_or("").to_string();
    let mut slot = PENDING_REVERT.lock().unwrap();
    let pending = slot.take();
    let Some((pending_key, _current, prior)) = pending else {
        return Ok(());
    };
    if pending_key != key {
        // Different monitor's pending change — put it back and bail.
        *slot = Some((pending_key, _current, prior));
        return Ok(());
    }
    let target_wide = device_name.map(device_name_to_wide);
    let target = target_wide.as_ref().map_or(std::ptr::null(), |w| w.as_ptr());
    let hr = unsafe {
        let mut dm: DEVMODEW = std::mem::zeroed();
        dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        dm.dmFields = 0x00580000;
        dm.dmPelsWidth = prior.width;
        dm.dmPelsHeight = prior.height;
        dm.dmDisplayFrequency = prior.refresh_rate;
        ChangeDisplaySettingsExW(target, &dm, std::ptr::null_mut(), 0, std::ptr::null())
    };
    if !hr_ok(hr) {
        return Err(format!("Revert failed ({hr})"));
    }
    Ok(())
}

/// Confirm the last applied mode on the named monitor — clears the
/// pending revert so the 10s auto-revert timer no longer fires for it.
pub fn keep_display_mode_for(device_name: Option<&str>) -> Result<(), String> {
    let key = device_name.unwrap_or("").to_string();
    let mut slot = PENDING_REVERT.lock().unwrap();
    let pending = slot.take();
    let Some((pending_key, current, prior)) = pending else {
        return Ok(());
    };
    if pending_key != key {
        // Different monitor's pending change — put it back unchanged.
        *slot = Some((pending_key, current, prior));
        return Ok(());
    }
    // Keep = drop the prior so revert becomes a no-op for this monitor.
    *slot = Some((pending_key, current, current));
    Ok(())
}

/// List every attached GDI adapter. Each entry's `device_name` is the
/// `\\.\DISPLAYn` string the OS uses to identify the adapter — pass it
/// back to `display_modes` / `current_display` / `apply_display_mode`.
///
/// List every connected monitor — same model Windows Settings uses for
/// its "Rearrange your displays" page. We enumerate GDI adapters via
/// `EnumDisplayDevicesW(NULL, i, ...)`, then for each adapter grab
/// monitor 0 (the connected display). The resulting list is what the
/// user sees physically attached; multi-head GPU clones that report the
/// same monitor under several `\\.\DISPLAYn` aliases collapse to one
/// entry because we dedupe by the monitor's `DeviceID`
/// (`MONITOR\XXX\...`).
///
/// Each entry's `device_name` is the **adapter's** `\\.\DISPLAYn` string
/// — passed back to `display_modes` / `current_display` /
/// `apply_display_mode` to target the right output.
pub fn list_monitors() -> Vec<Monitor> {
    // Resolve friendly names from WMI (EDID-derived model names) once
    // per call. Falls back gracefully if PowerShell / WMI is missing.
    let name_map = wmi_monitor_names();
    let mut out: Vec<Monitor> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    unsafe {
        for i in 0..16 {
            let mut adapter_dev = DISPLAY_DEVICEW {
                cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
                ..std::mem::zeroed()
            };
            // `EnumDisplayDevicesW` returns `BOOL` (i32 in windows-sys
            // 0.59); nonzero means success.
            if EnumDisplayDevicesW(std::ptr::null(), i, &mut adapter_dev, 0) == 0 {
                break;
            }
            let adapter_name = wstr_trim(&adapter_dev.DeviceName);
            let adapter_friendly = wstr_trim(&adapter_dev.DeviceString);
            let adapter_name_wide = crate::cmd::to_wide(&adapter_name);

            // Enumerate ALL monitor slots on this adapter. A multi-head
            // GPU exposes multiple physical displays under the same
            // `\\.\DISPLAYn` (one per slot), and we want each one in
            // the list. Each slot has a unique `DeviceID`, so we dedupe
            // across adapters by that key.
            for mon_slot in 0..16 {
                let mut mon_dev = DISPLAY_DEVICEW {
                    cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
                    ..std::mem::zeroed()
                };
                if EnumDisplayDevicesW(adapter_name_wide.as_ptr(), mon_slot, &mut mon_dev, 0) == 0 {
                    break;
                }
                // `DeviceID` is the monitor's `MONITOR\XXX\...` instance
                // path — unique per physical display. Multi-head GPUs
                // that report the same monitor under several `\\.\DISPLAYn`
                // aliases share this ID, so we use it to collapse dupes.
                let monitor_id = wstr_trim(&mon_dev.DeviceID);
                if !seen.insert(monitor_id.clone()) {
                    continue;
                }
                let mon_friendly = wstr_trim(&mon_dev.DeviceString);
                // `DeviceID` carries the EDID vendor code (e.g. `BNQ7F76`
                // for a BenQ panel); look up the friendly model name from
                // the WMI map populated above. Fall back to the monitor
                // string (often "Generic PnP Monitor") then the GPU
                // adapter name.
                let friendly_name = edid_vendor_code_from_device_id(&monitor_id)
                    .and_then(|code| name_map.get(&code).cloned())
                    .or_else(|| {
                        if mon_friendly.is_empty() || mon_friendly == "Generic PnP Monitor" {
                            None
                        } else {
                            Some(mon_friendly.clone())
                        }
                    })
                    .unwrap_or(adapter_friendly.clone());
                let flags = mon_dev.StateFlags;
                let disabled = flags & DISPLAY_DEVICE_ACTIVE == 0;
                let primary = flags & DISPLAY_DEVICE_PRIMARY_DEVICE != 0;
                out.push(Monitor {
                    device_name: adapter_name.clone(),
                    friendly_name,
                    primary,
                    disabled,
                });
            }
        }
    }
    // Sort: active (non-disabled) first alphabetical, then disabled
    // alphabetical. Within each group, primary comes before non-primary
    // so the user's main screen is always at the top.
    out.sort_by(|a, b| {
        a.disabled
            .cmp(&b.disabled) // false (active) sorts before true (disabled)
            .then(b.primary.cmp(&a.primary)) // primary first
            .then(
                a.friendly_name
                    .to_lowercase()
                    .cmp(&b.friendly_name.to_lowercase()),
            )
    });
    out
}

/// Trim trailing NULs and convert a fixed-size UTF-16 buffer to a Rust
/// `String`. Mirrors the pattern the rest of the codebase uses for
/// reading `DISPLAY_DEVICEW.DeviceString`.
fn wstr_trim(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end]).trim().to_string()
}

/// Spawn `Get-CimInstance Win32/WmiMonitorID` to get the friendly name
/// per EDID vendor code (e.g. `BNQ7F76` → "BenQ EX2780Q"). `DISPLAY_DEVICE`
/// only exposes "Generic PnP Monitor" — the actual model name lives in
/// the WMI monitor-identity classes, parsed from the EDID.
///
/// Returns an empty map if PowerShell isn't available, the WMI call
/// errors out, or no monitors are connected. Failures here are
/// non-fatal: callers fall back to the GDI adapter name.
fn wmi_monitor_names() -> HashMap<String, String> {
    // Inline PowerShell script: enumerate WmiMonitorID instances, extract
    // the EDID vendor code from `InstanceName` (e.g. `DISPLAY\BNQ7F76\...`),
    // and emit `[{"c":"BNQ7F76","n":"BenQ EX2780Q"}, ...]` as compact JSON.
    // `UserFriendlyName` is a packed UTF-16 byte array (16-bit chars);
    // decode to ASCII and trim trailing NULs.
    //
    // NB: this MUST be a single physical line. PowerShell's `-Command`
    // argument parses on newlines — a multiline script aborts after
    // the first line and we get no output.
    let script = "$m = Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID | ForEach-Object { $n = [System.Text.Encoding]::ASCII.GetString($_.UserFriendlyName).Trim([char]0); if ($_.InstanceName -match '^DISPLAY\\\\([^&]+)\\\\') { [PSCustomObject]@{c=$Matches[1];n=$n} } }; if ($m) { $m | ConvertTo-Json -Compress } else { '[]' }";
    let output = crate::cmd::run_output(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
    );
    let Ok(out) = output else { return HashMap::new() };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        moonblast_log!(
            "wmi_monitor_names: powershell exited {:?} stderr={}",
            out.status.code(),
            stderr
        );
        return HashMap::new();
    }
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let trimmed = stdout.trim();
    if trimmed.is_empty() || trimmed == "null" || trimmed == "[]" {
        return HashMap::new();
    }
    // The JSON can be either an object (one monitor) or an array.
    let parsed: Result<Vec<serde_json::Value>, _> = serde_json::from_str(trimmed);
    let arr = match parsed {
        Ok(arr) => arr,
        Err(_) => {
            // Try single-object form.
            match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(v) => vec![v],
                Err(_) => return HashMap::new(),
            }
        }
    };
    let mut out = HashMap::new();
    for v in arr {
        // The PowerShell script uses short field names `c` and `n`
        // (compact JSON output — saves bytes vs `code`/`name`).
        let code = v.get("c").and_then(|c| c.as_str()).unwrap_or("");
        let name = v.get("n").and_then(|n| n.as_str()).unwrap_or("");
        if !code.is_empty() && !name.is_empty() {
            out.insert(code.to_string(), name.to_string());
        }
    }
    out
}

/// Extract the EDID-derived vendor code from a `DISPLAY_DEVICEW.DeviceID`.
/// The ID looks like `MONITOR\BNQ7F76\{4d36e96e-...}\0027` — we want
/// the `BNQ7F76` segment (5-char code derived from the manufacturer
/// name in the EDID block) to look up the friendly name in
/// `WmiMonitorID`.
fn edid_vendor_code_from_device_id(device_id: &str) -> Option<String> {
    let rest = device_id.strip_prefix("MONITOR\\")?;
    let code = rest.split('\\').next()?;
    if code.is_empty() {
        None
    } else {
        Some(code.to_string())
    }
}

/// Build a wide-string pointer that lives as long as `_wide` is in scope.
/// Caller pattern:
/// ```ignore
/// let wide = device_name_to_wide(s);
/// call_api(wide.as_ptr());
/// ```
/// Avoids the temporary-into-pointer anti-pattern that the compiler
/// warns about when using `.map(|s| wide(s).as_ptr())` inline.
fn device_name_to_wide(device_name: &str) -> Vec<u16> {
    crate::cmd::to_wide(device_name)
}
