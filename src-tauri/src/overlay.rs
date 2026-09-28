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
//! **Autohide.** With `overlay.autohide` set to a duration the notch starts
//! hidden and a watcher thread reveals it while the cursor is inside the
//! hotspot at the top edge (which tracks the chosen left / center / right
//! position), hiding it again once the pointer has been away for the timeout.
//! The watcher polls `GetCursorPos` instead of installing a `WH_MOUSE_LL`
//! hook: Windows stops delivering low-level hooks while a Chromium-family
//! window (i.e. our own WebView2, or a browser) is focused (see
//! `mediakeys.rs`), and the cursor position is a global, focus-independent
//! read — a cheap `GetCursorPos` every `AUTOHIDE_POLL_MS` is plenty.
//!
//! Window creation must **not** run on the main thread (Tauri deadlocks there
//! on Windows — see `WebviewWindowBuilder::build` docs), so callers spawn a
//! thread, mirroring `mediakeys::set_active`.

use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

use crate::moonblast_log;

/// Window label; the frontend branches on it to render the overlay instead of
/// the launcher, and the capability file lists it for event access.
pub const LABEL: &str = "overlay";

/// Serializes `apply` calls. Toggles spawn a thread each, so a fast off→on
/// could otherwise interleave and leave the window in the wrong state (or
/// double-build the same label).
static APPLY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Clears the notch card; extra space below it is transparent, so this only
/// needs to be tall enough for the tallest padding/type combination.
const WIDTH: f64 = 300.0;
const HEIGHT: f64 = 32.0;

/// Autohide watcher poll interval.
const AUTOHIDE_POLL_MS: u64 = 120;
/// Hotspot for autohide, in logical px: a wide, shallow strip along the top of
/// the monitor, tracking the notch's left / center / right position.
const HOTSPOT_W: f64 = 420.0;
const HOTSPOT_H: f64 = 90.0;

/// Current autohide timeout (0 = off). Read by the watcher each tick so a
/// timeout change is picked up without restarting it.
static AUTOHIDE_MS: AtomicU64 = AtomicU64::new(0);
/// `0` = left, `1` = center, `2` = right. Read by `position` so the watcher's
/// `show` (which has no settings access) places the notch correctly.
static POSITION: AtomicU8 = AtomicU8::new(1);
static WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);
static WATCHER_STOP: AtomicBool = AtomicBool::new(false);
/// Whether the notch is currently shown — lets `show`/`hide` be no-ops when
/// the state hasn't changed.
static VISIBLE: AtomicBool = AtomicBool::new(false);

/// Parse the `overlay.autohide` setting (`"off"` | `"3s"` | `"10s"`) into
/// milliseconds, `0` meaning off.
pub fn autohide_ms(value: &str) -> u64 {
    match value {
        "3s" => 3_000,
        "10s" => 10_000,
        _ => 0,
    }
}

/// Parse the `overlay.position` setting into the `POSITION` code.
fn position_code(value: &str) -> u8 {
    match value {
        "left" => 0,
        "right" => 2,
        _ => 1,
    }
}

/// Monotonic milliseconds since the first call. `Instant` can't live in a
/// `static` directly, so anchor it in a `OnceLock`.
fn now_ms() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64
}

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

/// Show/hide the overlay and (dis)arm the autohide watcher.
///
/// `autohide_ms == 0` keeps the notch permanently visible; a non-zero value
/// hands visibility to the cursor watcher (starting hidden). `position` is
/// `"left"` | `"center"` | `"right"`. Must run off the main thread (see module
/// docs); callers spawn a thread.
pub fn apply(app: &AppHandle, enabled: bool, autohide_ms: u64, position: &str) {
    let _guard = APPLY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    POSITION.store(position_code(position), Ordering::SeqCst);
    if !enabled {
        stop_watcher();
        hide(app);
        return;
    }
    ensure_window(app);
    if autohide_ms == 0 {
        stop_watcher();
        // Re-place even if already visible so a position change is applied.
        position_if_visible(app);
        show(app);
        return;
    }
    AUTOHIDE_MS.store(autohide_ms, Ordering::SeqCst);
    if WATCHER_RUNNING.load(Ordering::SeqCst) {
        position_if_visible(app);
        return; // already watching; the timeout above was just refreshed
    }
    hide(app); // start hidden until the cursor comes near
    start_watcher(app.clone());
}

/// Re-place the window if it's currently shown. `show` is a no-op when the
/// notch is already visible, so a position change while visible needs its own
/// re-place or the window would stay where it was.
fn position_if_visible(app: &AppHandle) {
    if !VISIBLE.load(Ordering::SeqCst) {
        return;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        position(app, &win);
    }
}

/// Show the notch (no-op if already visible), re-asserting topmost.
fn show(app: &AppHandle) {
    if VISIBLE.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        position(app, &win);
        let _ = win.show();
        // Re-assert topmost in case another topmost window grabbed z-order.
        let _ = win.set_always_on_top(true);
    }
}

/// Hide the notch (no-op if already hidden).
fn hide(app: &AppHandle) {
    if !VISIBLE.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}

/// Bring up the single autohide watcher while one isn't already running.
fn start_watcher(app: AppHandle) {
    if WATCHER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    WATCHER_STOP.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let mut last_inside = now_ms();
        loop {
            if WATCHER_STOP.load(Ordering::SeqCst) {
                break;
            }
            if cursor_in_hotspot(&app) {
                last_inside = now_ms();
                // Re-check: a concurrent `stop_watcher` (autohide turned off)
                // must not be undone by a late `show`.
                if !WATCHER_STOP.load(Ordering::SeqCst) {
                    show(&app);
                }
            } else {
                let timeout = AUTOHIDE_MS.load(Ordering::SeqCst);
                // `stop_watcher` zeroes the timeout, so a stopped watcher
                // can't sneak a hide in after the caller has shown the notch.
                if timeout > 0 && now_ms().saturating_sub(last_inside) >= timeout {
                    hide(&app);
                }
            }
            std::thread::sleep(Duration::from_millis(AUTOHIDE_POLL_MS));
        }
        WATCHER_RUNNING.store(false, Ordering::SeqCst);
    });
}

fn stop_watcher() {
    AUTOHIDE_MS.store(0, Ordering::SeqCst);
    WATCHER_STOP.store(true, Ordering::SeqCst);
}

/// Whether the cursor is inside the notch hotspot (at the top of the launcher's
/// monitor, following `POSITION`), in physical pixels.
fn cursor_in_hotspot(app: &AppHandle) -> bool {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt: POINT = unsafe { std::mem::zeroed() };
    if unsafe { GetCursorPos(&mut pt) } == 0 {
        return false;
    }
    let Some((mx, my, mw, scale)) = monitor_metrics(app) else {
        return false;
    };
    let hot_w = HOTSPOT_W * scale;
    let hot_left = match POSITION.load(Ordering::SeqCst) {
        0 => mx,
        2 => mx + mw - hot_w,
        _ => mx + (mw - hot_w) / 2.0,
    };
    let x = pt.x as f64;
    let y = pt.y as f64;
    x >= hot_left && x <= hot_left + hot_w && y >= my && y <= my + HOTSPOT_H * scale
}

/// `(left, top, width, scale)` of the launcher's monitor, in physical pixels.
fn monitor_metrics(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    let main = app.get_webview_window("main");
    let m = main
        .as_ref()
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| {
            main.as_ref()
                .and_then(|w| w.primary_monitor().ok().flatten())
        })
        .or_else(|| {
            app.get_webview_window(LABEL)
                .and_then(|w| w.current_monitor().ok().flatten())
        })?;
    Some((
        m.position().x as f64,
        m.position().y as f64,
        m.size().width as f64,
        m.scale_factor(),
    ))
}

/// Top edge of the launcher's monitor, aligned by `POSITION` (left / center /
/// right), flush with the top so the notch hangs from the top of the screen.
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
    let left = m.position().x;
    let width = m.size().width as i32;
    let x = match POSITION.load(Ordering::SeqCst) {
        0 => left,
        2 => left + (width - w).max(0),
        _ => left + ((width - w) / 2).max(0),
    };
    let y = m.position().y;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}
