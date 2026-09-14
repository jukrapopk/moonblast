//! Windows theme detection — app-mode (light/dark) + accent color,
//! with push events so the Appearance "Auto" theme + "Auto" color can
//! live-follow the OS.
//!
//! Two detection paths, both keyed off the user's HKCU hive:
//!
//! - **App mode** (`HKCU\...\Themes\Personalize\AppsUseLightTheme`,
//!   DWORD) → drives the `theme = "auto"` mirror of light/dark.
//! - **Accent color** — `DwmGetColorizationColor` (DWM, the active
//!   colorization color, including the auto-picked one on Win11
//!   22H2+ where the user picked "Automatically pick an accent from
//!   my background").
//!
//! ## Change tracking
//!
//! Ideally we'd hook `WM_SETTINGCHANGE` with lpszSection =
//! `"ImmersiveColorSet"` — Windows broadcasts it on every light/dark
//! or accent toggle. Subclassing the main WebView2 window from Rust
//! is fragile and racy with the WebView2 message loop, so instead we
//! poll both values every 3 seconds. The user changes either rarely
//! (Settings → Personalization → Colors) and a few seconds of lag
//! is invisible.
//!
//! ## Failure path
//!
//! Any non-Windows or registry/DWM-unavailable failure returns
//! `Dark` / `null` so the UI always renders something. The fallback
//! matches Moonblast's historical defaults — a user who picked dark
//! shouldn't be pushed into light because the OS query failed.

use std::sync::atomic::{AtomicU8, AtomicU32, Ordering};
use tauri::{AppHandle, Emitter};

/// 0 = unknown (failed to read), 1 = dark, 2 = light.
static LAST_MODE: AtomicU8 = AtomicU8::new(0);
/// Pack the accent as `0x00RRGGBB` (CSS-style hex). 0 = unknown.
static LAST_ACCENT: AtomicU32 = AtomicU32::new(0);

/// Read the user's current Windows app-mode setting.
///
/// Returns `"dark"` or `"light"`. Falls back to `"dark"` if the
/// registry read fails (no user hive, pre-Vista, locked down).
pub fn windows_app_mode() -> &'static str {
    mode_str(read_mode())
}

/// Read the user's current Windows accent color (DWM colorization).
///
/// Returns the CSS-style hex (`#rrggbb`) the OS is currently
/// rendering with — including the auto-picked variant on Win11
/// 22H2+. Returns `None` if the API is unavailable (pre-Vista).
pub fn windows_accent_color() -> Option<String> {
    read_accent().map(colorref_to_hex)
}

pub(crate) fn read_mode() -> Option<bool> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };

    let key_w = crate::cmd::to_wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    let name_w = crate::cmd::to_wide("AppsUseLightTheme");

    let mut hkey: HKEY = std::ptr::null_mut();
    // SAFETY: `key_w` is a valid null-terminated UTF-16 string;
    // `hkey` is a valid out-param.
    let open_ok = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_w.as_ptr(),
            0,
            KEY_READ,
            &mut hkey,
        )
    };
    if open_ok != 0 {
        return None;
    }

    let mut data: u32 = 0;
    let mut len: u32 = std::mem::size_of::<u32>() as u32;
    let mut kind: u32 = 0;

    // SAFETY: `name_w` is null-terminated; `data` is a 4-byte stack
    // buffer that's exactly the size of a REG_DWORD.
    let q_ok = unsafe {
        RegQueryValueExW(
            hkey,
            name_w.as_ptr(),
            std::ptr::null(),
            &mut kind,
            &mut data as *mut _ as *mut u8,
            &mut len,
        )
    };
    unsafe { RegCloseKey(hkey) };

    if q_ok != 0 || kind != 4 {
        return None;
    }
    // AppsUseLightTheme == 1 → light, == 0 → dark.
    Some(data == 1)
}

pub(crate) fn read_accent() -> Option<u32> {
    use windows_sys::Win32::Graphics::Dwm::DwmGetColorizationColor;
    // DWM colorization is a COLORREF (0x00BBGGRR) — the DWM takes the
    // legacy Win32 byte order and we re-pack it as CSS-style 0x00RRGGBB.
    let mut color: u32 = 0;
    let mut opaque: windows_sys::Win32::Foundation::BOOL = 0;
    // SAFETY: both out-params are 4-byte locals; HRESULT return is
    // checked below.
    let hr = unsafe { DwmGetColorizationColor(&mut color, &mut opaque) };
    if hr < 0 {
        return None;
    }
    Some(colorref_to_rgb_u32(color))
}

fn colorref_to_rgb_u32(c: u32) -> u32 {
    // 0x00BBGGRR -> 0x00RRGGBB
    let r = c & 0xFF;
    let g = (c >> 8) & 0xFF;
    let b = (c >> 16) & 0xFF;
    (r << 16) | (g << 8) | b
}

fn colorref_to_hex(c: u32) -> String {
    let rgb = colorref_to_rgb_u32(c);
    format!("#{:06x}", rgb)
}

fn mode_str(v: Option<bool>) -> &'static str {
    match v {
        Some(true) => "light",
        _ => "dark",
    }
}

fn mode_to_u8(v: Option<bool>) -> u8 {
    match v {
        Some(true) => 2,
        Some(false) => 1,
        None => 0,
    }
}

/// Read once and broadcast both values. Called from `setup` so the
/// frontend has values immediately after mount (no waiting for the
/// first poll tick).
pub fn publish_initial(app: &AppHandle) {
    let mode = read_mode();
    LAST_MODE.store(mode_to_u8(mode), Ordering::SeqCst);
    let _ = app.emit("windows-theme-changed", mode_str(mode));

    let accent = read_accent();
    LAST_ACCENT.store(accent.unwrap_or(0), Ordering::SeqCst);
    if let Some(hex) = accent.map(colorref_to_hex) {
        let _ = app.emit("windows-accent-changed", hex);
    }
}

/// Spawn a daemon thread that polls every `POLL_SECS` and emits
/// `windows-theme-changed` / `windows-accent-changed` whenever either
/// value flips. Cheap — a single 4-byte registry read + DWM call
/// every few seconds.
pub fn install_watcher(app: AppHandle) {
    const POLL_SECS: u64 = 3;
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(POLL_SECS));

        // App mode.
        let new_mode = mode_to_u8(read_mode());
        let prev_mode = LAST_MODE.load(Ordering::SeqCst);
        if prev_mode != new_mode {
            LAST_MODE.store(new_mode, Ordering::SeqCst);
            let label = match new_mode {
                2 => "light",
                _ => "dark",
            };
            let _ = app.emit("windows-theme-changed", label);
        }

        // Accent.
        let new_accent = read_accent().unwrap_or(0);
        let prev_accent = LAST_ACCENT.load(Ordering::SeqCst);
        if prev_accent != new_accent && new_accent != 0 {
            LAST_ACCENT.store(new_accent, Ordering::SeqCst);
            let _ = app.emit(
                "windows-accent-changed",
                colorref_to_hex(new_accent),
            );
        }
    });
}

