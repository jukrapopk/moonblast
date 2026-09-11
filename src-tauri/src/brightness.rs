//! Read/write monitor brightness via WMI's `WmiMonitorBrightness` /
//! `WmiMonitorBrightnessMethods` classes.
//!
//! Windows exposes these only for **internal laptop panels** (the
//! `MonitorClass` driver reports them). External monitors don't show
//! up here — DDC/CI is the alternative, but it's unreliable in
//! long-lived processes and not exposed through WMI. So on a desktop
//! or a laptop connected only to externals, `supported = false` and
//! the frontend hides the slider.
//!
//! **No push events.** Windows doesn't broadcast brightness changes
//! to user-mode processes (there's no `GUID_BRIGHTNESS` under
//! `RegisterPowerSettingNotification`), so the frontend polls
//! `CurrentBrightness` every 500 ms while the modal is open.
//!
//! All PowerShell calls run with `CREATE_NO_WINDOW` (0x0800_0000) so
//! no console flashes while the user is dragging the slider.

use serde::{Deserialize, Serialize};

use crate::moonblast_log;

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
pub struct BrightnessStatus {
    /// `true` when `WmiMonitorBrightness` exists for at least one
    /// adapter. The frontend hides the slider when this is `false`
    /// (desktop, all-external setups).
    pub supported: bool,
    /// `true` when at least one instance reports `Active = true` or
    /// a valid `Level[]`. Currently identical to `supported`, but
    /// kept separate so we can distinguish "class exists, no panel
    /// reports brightness" if a driver ever reports that.
    pub available: bool,
    /// Current brightness percent (0–100), or `None` if unknown.
    pub current: Option<u8>,
    /// Lowest level in the panel's discrete level set (almost always 0).
    pub min: u8,
    /// Highest level in the panel's discrete level set (almost always 100).
    pub max: u8,
    /// Number of discrete levels (e.g. 101 for 0–100 in 1 % steps).
    /// Frontend uses this to compute the slider `step` so values snap
    /// to allowed levels.
    pub levels_count: u32,
}

impl Default for BrightnessStatus {
    fn default() -> Self {
        Self {
            supported: false,
            available: false,
            current: None,
            min: 0,
            max: 0,
            levels_count: 0,
        }
    }
}

/// Read the current brightness state. Runs on `spawn_blocking` from the
/// caller because PowerShell cold-start is ~100 ms.
pub fn read_brightness() -> BrightnessStatus {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    // Inline PowerShell: enumerate WmiMonitorBrightness, pick the
    // Active instance (or fall back to the first), emit a compact
    // JSON object. `s/a/c/min/max/h` are short field names to keep
    // the script tiny (the field name is what the script source
    // string is — the JSON parser just maps them back).
    //
    // NB: single physical line — PowerShell's `-Command` parses on
    // newlines.
    let script = r#"$b = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue; if ($b) { $active = $b | Where-Object { $_.Active } | Select-Object -First 1; if (-not $active) { $active = $b | Select-Object -First 1 }; $lvls = @($active.Level); [PSCustomObject]@{s=$true;a=$true;c=[int]$active.CurrentBrightness;min=[int]($lvls | Measure-Object -Minimum).Minimum;max=[int]($lvls | Measure-Object -Maximum).Maximum;h=[int]$lvls.Count} | ConvertTo-Json -Compress } else { '{"s":false,"a":false,"c":null,"min":0,"max":0,"h":0}' }"#;
    let Ok(out) = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(0x0800_0000)
        .output()
    else {
        return BrightnessStatus::default();
    };
    if !out.status.success() {
        moonblast_log!(
            "brightness: powershell exited {:?} stderr={}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        );
        return BrightnessStatus::default();
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return BrightnessStatus::default();
    }
    // Parse the compact JSON. Field names are single chars to keep
    // the script short.
    let v: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return BrightnessStatus::default(),
    };
    BrightnessStatus {
        supported: v.get("s").and_then(|x| x.as_bool()).unwrap_or(false),
        available: v.get("a").and_then(|x| x.as_bool()).unwrap_or(false),
        current: v.get("c").and_then(|x| x.as_u64()).map(|n| n.min(255) as u8),
        min: v.get("min").and_then(|x| x.as_u64()).map(|n| n.min(255) as u8).unwrap_or(0),
        max: v.get("max").and_then(|x| x.as_u64()).map(|n| n.min(255) as u8).unwrap_or(0),
        levels_count: v.get("h").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
    }
}

/// Set the monitor brightness in percent (0–100). `fade_sec` is the
/// OS-driven fade duration in seconds; pass `0` for an instant set
/// (matches what the slider wants — immediate response during drag).
pub fn set_brightness(level: u8, fade_sec: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    let level = level.min(100);
    let script = format!(
        r#"Invoke-CimMethod -Namespace root\wmi -ClassName WmiMonitorBrightnessMethods -MethodName WmiSetBrightness -Arguments @{{ Timeout = {fade_sec}; Brightness = {level} }} | Out-Null"#
    );
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("powershell spawn: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        moonblast_log!(
            "set_brightness: powershell exited {:?} stderr={} stdout={}",
            out.status.code(),
            stderr,
            stdout
        );
        return Err(format!("set_brightness failed: {stderr}"));
    }
    Ok(())
}
