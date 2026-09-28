//! The persistent always-on-top status overlay (the "notch").
//!
//! A second, frameless, transparent, topmost Tauri window pinned to the
//! top-center of the launcher's monitor. While `settings.overlay.enabled` is
//! on it shows a thin status notch (time / battery / battery usage). Like the
//! volume OSD (`osd.rs`) it:
//! - never takes focus (`focusable(false)`), so it can't steal a stream's
//!   keyboard focus,
//! - stays out of Alt+Tab / the taskbar (`skip_taskbar`) and is click-through,
//! - is created lazily the first time the user enables it, then hidden /
//!   re-shown on later toggles so we don't rebuild the webview each time.
//!
//! Unlike the OSD it is *persistent* (no debounced hide) — it stays up for as
//! long as the setting is on. Window creation must **not** run on the main
//! thread (Tauri deadlocks there on Windows — see `WebviewWindowBuilder::build`
//! docs), so callers spawn a thread, mirroring `mediakeys::set_active`.

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

use crate::moonblast_log;

/// Window label; the frontend branches on it to render the overlay instead of
/// the launcher, and the capability file lists it for event access.
pub const LABEL: &str = "overlay";

/// Serializes `apply` calls. Toggles spawn a thread each, so a fast off→on
/// could otherwise interleave and leave the window in the wrong state (or
/// double-build the same label).
static APPLY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Generous enough for the widest readout (time + battery + watts); the
/// transparent area around the notch is invisible.
const WIDTH: f64 = 300.0;
/// Clears the notch card; extra space below it is transparent, so this only
/// needs to be tall enough for the tallest padding/type combination.
const HEIGHT: f64 = 32.0;

/// Create the overlay window (hidden) if it doesn't exist yet. Idempotent.
pub fn ensure_window(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    match WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Moonblast Overlay")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .focusable(false)
        .visible(false)
        .build()
    {
        Ok(win) => {
            // Click-through: the notch must never eat a click meant for
            // whatever is underneath it (usually a stream window).
            let _ = win.set_ignore_cursor_events(true);
            moonblast_log!("overlay: window created");
        }
        Err(e) => moonblast_log!("overlay: window creation failed: {e}"),
    }
}

/// Show or hide the overlay. Must run off the main thread (see module docs);
/// callers spawn a thread.
pub fn apply(app: &AppHandle, enabled: bool) {
    let _guard = APPLY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !enabled {
        if let Some(win) = app.get_webview_window(LABEL) {
            let _ = win.hide();
        }
        return;
    }
    ensure_window(app);
    if let Some(win) = app.get_webview_window(LABEL) {
        position(app, &win);
        let _ = win.show();
        // Re-assert topmost in case another topmost window grabbed z-order.
        let _ = win.set_always_on_top(true);
    }
}

/// Top-center of the launcher's monitor, flush with the top edge so the notch
/// hangs from the top of the screen.
fn position(app: &AppHandle, win: &tauri::WebviewWindow) {
    let main = app.get_webview_window("main");
    let monitor = main
        .as_ref()
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| {
            main.as_ref()
                .and_then(|m| m.primary_monitor().ok().flatten())
        })
        .or_else(|| win.current_monitor().ok().flatten());
    let Some(m) = monitor else {
        return;
    };
    let scale = m.scale_factor();
    let w = (WIDTH * scale).round() as i32;
    let x = m.position().x + ((m.size().width as i32 - w) / 2).max(0);
    let y = m.position().y;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}
