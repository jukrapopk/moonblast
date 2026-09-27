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

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
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

/// Native (typed-COM) read of the internal panel's brightness. Cheap enough to
/// poll — unlike a PowerShell-per-tick, which is what made earlier poll-based
/// attempts unusable. `WmiMonitorBrightness.CurrentBrightness` is the same
/// value the OS brightness slider reads, so it tracks the hardware keys too.
mod wmi {
    use windows::core::{w, BSTR, GUID};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Variant::{VARIANT, VT_I4, VT_UI1};
    use windows::Win32::System::Wmi::{
        IEnumWbemClassObject, IWbemClassObject, IWbemContext, IWbemLocator, IWbemServices,
        WBEM_FLAG_FORWARD_ONLY, WBEM_INFINITE,
    };

    /// {4590F811-1D3A-11D0-891F-00AA004B2E24}
    const CLSID_WBEM_LOCATOR: GUID = GUID::from_u128(0x4590f811_1d3a_11d0_891f_00aa004b2e24);

    /// Current brightness (0–100) of the first controllable internal panel, or
    /// `None` when there's no such panel / WMI is unavailable.
    pub fn read_current() -> Option<u32> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let locator: IWbemLocator =
                CoCreateInstance(&CLSID_WBEM_LOCATOR, None, CLSCTX_INPROC_SERVER).ok()?;
            let services: IWbemServices = locator
                .ConnectServer(
                    &BSTR::from("ROOT\\WMI"),
                    &BSTR::new(),
                    &BSTR::new(),
                    &BSTR::new(),
                    0,
                    &BSTR::new(),
                    None::<&IWbemContext>,
                )
                .ok()?;
            let lang = BSTR::from("WQL");
            let query = BSTR::from("SELECT CurrentBrightness FROM WmiMonitorBrightness");
            let enumerator: IEnumWbemClassObject = services
                .ExecQuery(&lang, &query, WBEM_FLAG_FORWARD_ONLY, None::<&IWbemContext>)
                .ok()?;
            let mut objects: [Option<IWbemClassObject>; 1] = [None];
            let mut returned = 0u32;
            let _ = enumerator.Next(WBEM_INFINITE, &mut objects, &mut returned);
            let object = objects[0].take()?;
            let mut value = VARIANT::default();
            object
                .Get(w!("CurrentBrightness"), 0, &mut value, None, None)
                .ok()?;
            variant_u32(&value)
        }
    }

    fn variant_u32(v: &VARIANT) -> Option<u32> {
        unsafe {
            let inner = &v.Anonymous.Anonymous;
            if inner.vt == VT_UI1 {
                Some(inner.Anonymous.bVal as u32)
            } else if inner.vt == VT_I4 {
                Some(inner.Anonymous.lVal as u32)
            } else {
                None
            }
        }
    }
}

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

// --- change watcher --------------------------------------------------------
//
// There is no push API for brightness, so detecting the *hardware* brightness
// keys (which produce no standard virtual key) means polling. To keep that
// cheap and bounded, watch only [`wmi::read_current`] (a native WMI read,
// ~1 ms) and only while it's needed: the Display modal is open (live slider)
// and/or Immersive Mode is active (OSD for the hardware keys). Nothing runs
// otherwise.

static WATCH_APP: Mutex<Option<AppHandle>> = Mutex::new(None);
static WATCH_IMMERSIVE: AtomicBool = AtomicBool::new(false);
static WATCH_MODAL: AtomicBool = AtomicBool::new(false);
static WATCH_STOP: AtomicBool = AtomicBool::new(false);
static WATCH_RUNNING: AtomicBool = AtomicBool::new(false);
/// Last observed value; -1 = not seeded yet.
static LAST_VALUE: AtomicI32 = AtomicI32::new(-1);

const POLL_TICK: u64 = 400;

#[derive(Clone, serde::Serialize)]
struct BrightnessChanged {
    value: u32,
}

/// Store the app handle. Called once from `setup`.
pub fn init(app: AppHandle) {
    if let Ok(mut g) = WATCH_APP.lock() {
        *g = Some(app);
    }
}

/// Watch while Immersive Mode is active — this drives the OSD for the hardware
/// brightness keys (Explorer's own flyout is gone then).
pub fn set_immersive_watch(on: bool) {
    WATCH_IMMERSIVE.store(on, Ordering::SeqCst);
    reconcile();
}

/// Watch while the Display modal is open — keeps its slider in sync with
/// changes made elsewhere (hardware keys, Windows Settings).
pub fn set_modal_watch(on: bool) {
    WATCH_MODAL.store(on, Ordering::SeqCst);
    reconcile();
}

fn reconcile() {
    let want = WATCH_IMMERSIVE.load(Ordering::SeqCst) || WATCH_MODAL.load(Ordering::SeqCst);
    if want {
        start_watch();
    } else {
        WATCH_STOP.store(true, Ordering::SeqCst);
    }
}

fn start_watch() {
    if WATCH_RUNNING.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    WATCH_STOP.store(false, Ordering::SeqCst);
    std::thread::spawn(|| {
        // Seed so the first poll doesn't read as a change.
        LAST_VALUE.store(
            wmi::read_current().map(|v| v as i32).unwrap_or(-1),
            Ordering::SeqCst,
        );
        loop {
            for _ in 0..(POLL_TICK / 100) {
                if WATCH_STOP.load(Ordering::SeqCst) {
                    WATCH_RUNNING.store(false, Ordering::SeqCst);
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let Some(value) = wmi::read_current() else {
                continue;
            };
            if LAST_VALUE.swap(value as i32, Ordering::SeqCst) == value as i32 {
                continue;
            }
            let app = WATCH_APP.lock().ok().and_then(|g| g.clone());
            if let Some(app) = app {
                let _ = app.emit("brightness-changed", BrightnessChanged { value });
                // The Windows flyout only needs replacing while Explorer is
                // suppressed; in windowed mode Windows draws its own.
                if WATCH_IMMERSIVE.load(Ordering::SeqCst) {
                    crate::osd::show_brightness(&app, value, 0, 100);
                }
            }
        }
    });
}
