//! The always-on-top volume overlay window (`osd`).
//!
//! While Immersive Mode has Explorer suppressed, Explorer's volume flyout is
//! gone — `mediakeys.rs` applies the volume and calls [`show_level`] so the
//! level is still visible. It is a second, frameless, transparent, topmost
//! Tauri window that:
//! - never takes focus (`focusable(false)`), so it can't steal a stream's
//!   keyboard focus,
//! - stays out of Alt+Tab / the taskbar (`skip_taskbar`) and is click-through,
//! - is created hidden when Immersive Mode first arms and shown per keypress.
//!
//! Rust owns the whole visibility lifecycle (show **and** the debounced hide),
//! so the overlay appears even if the hidden webview's JS is throttled; the
//! frontend only renders the bar from the `volume-key` event.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use crate::moonblast_log;

/// Window label; the frontend branches on it to render the OSD instead of the
/// launcher, and the capability file lists it for event access.
pub const LABEL: &str = "osd";

const WIDTH: f64 = 320.0;
const HEIGHT: f64 = 96.0;
/// Distance from the top of the monitor, in logical pixels.
const TOP_MARGIN: f64 = 44.0;
/// Idle time after the last keypress before the overlay hides.
const HIDE_AFTER_MS: u64 = 1500;
/// Poll granularity of the hide watcher.
const HIDE_POLL_MS: u64 = 250;

static HIDE_SCHEDULED: AtomicBool = AtomicBool::new(false);
static LAST_ACTIVITY_MS: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, serde::Serialize)]
struct VolumeKey {
    volume: u8,
    muted: bool,
}

/// Monotonic milliseconds since the first call. `Instant` can't live in a
/// `static` directly, so anchor it in a `OnceLock`.
fn now_ms() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Create the hidden OSD window if it doesn't exist yet. Idempotent.
///
/// Must **not** be called synchronously on the main thread — Tauri window
/// creation deadlocks there on Windows (see `WebviewWindowBuilder::from_config`
/// docs) — so `mediakeys::set_active` calls this from a spawned thread.
pub fn ensure_window(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    match WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Moonblast Volume")
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
            // Click-through, so hovering or clicking the overlay never steals a
            // mouse event from the content underneath it (which, while
            // streaming, is the stream window).
            let _ = win.set_ignore_cursor_events(true);
            moonblast_log!("osd: window created");
        }
        Err(e) => moonblast_log!("osd: window creation failed: {e}"),
    }
}

/// Update the level, bring the overlay up (top-center of the launcher's
/// monitor), and arm the debounced hide. Called on every volume keypress.
pub fn show_level(app: &AppHandle, volume: u8, muted: bool) {
    let _ = app.emit_to(LABEL, "volume-key", VolumeKey { volume, muted });
    if let Some(win) = app.get_webview_window(LABEL) {
        position(app, &win);
        let _ = win.show();
        // Re-assert topmost in case another topmost window grabbed z-order.
        let _ = win.set_always_on_top(true);
    }
    LAST_ACTIVITY_MS.store(now_ms(), Ordering::SeqCst);
    schedule_hide(app.clone());
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}

/// Keep exactly one watcher alive while the overlay is up; it hides the window
/// once no keypress has arrived for `HIDE_AFTER_MS`, then exits. Holding the
/// key just keeps pushing `LAST_ACTIVITY_MS` forward, so the overlay stays up.
fn schedule_hide(app: AppHandle) {
    if HIDE_SCHEDULED.swap(true, Ordering::SeqCst) {
        return; // a watcher is already running
    }
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(HIDE_POLL_MS));
            let idle = now_ms().saturating_sub(LAST_ACTIVITY_MS.load(Ordering::SeqCst));
            if idle >= HIDE_AFTER_MS {
                hide(&app);
                HIDE_SCHEDULED.store(false, Ordering::SeqCst);
                return;
            }
        }
    });
}

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
    let y = m.position().y + (TOP_MARGIN * scale).round() as i32;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}
