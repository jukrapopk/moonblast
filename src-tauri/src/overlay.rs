//! The persistent always-on-top status overlay (the "notch").
//!
//! A second, frameless, transparent, topmost Tauri window spanning the top
//! edge of the launcher's monitor. While `settings.overlay.enabled` is on it
//! shows a thin status notch (time / battery / power draw), aligned left /
//! center / right by CSS inside the window (so changing position is a single
//! DOM move, never a window jump) and scaled / dimmed by the `scale` /
//! `opacity` settings. Like the volume OSD (`osd.rs`) it:
//! - never takes focus (`focusable(false)`), so it can't steal a stream's
//!   keyboard focus,
//! - stays out of Alt+Tab / the taskbar (`skip_taskbar`) and is click-through,
//! - is created lazily the first time the user enables it and **destroyed when
//!   they disable it**, so a disabled overlay holds no WebView2 / React tree
//!   at all (autohide merely hides / re-shows the live window).
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

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::moonblast_log;

/// Window label; the frontend branches on it to render the overlay instead of
/// the launcher, and the capability file lists it for event access.
pub const LABEL: &str = "overlay";

/// Serializes `apply` calls. Toggles spawn a thread each, so a fast off→on
/// could otherwise interleave and leave the window in the wrong state (or
/// double-build the same label).
static APPLY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Initial window width. The window is resized to **span the monitor** on
/// show, so the notch's left / center / right alignment is plain CSS inside it
/// (`StatusOverlay`) and a position change never moves the window.
const WIDTH: f64 = 300.0;
/// Clears the notch card at scale 1; extra space below it is transparent, so
/// this only needs to be tall enough for the tallest padding/type combination.
/// The window height is multiplied by the user's scale so a larger notch isn't
/// clipped.
const HEIGHT: f64 = 32.0;

/// Allowed notch scale range, clamped Rust-side so a bad `settings.json` can't
/// ask for an absurd window height. Mirrors the SettingsView slider.
const MIN_SCALE: f64 = 0.5;
const MAX_SCALE: f64 = 2.0;

/// Autohide watcher poll interval.
const AUTOHIDE_POLL_MS: u64 = 120;
/// Hotspot for autohide, in logical px: a wide, shallow strip along the top of
/// the monitor, tracking the notch's left / center / right position.
const HOTSPOT_W: f64 = 420.0;
const HOTSPOT_H: f64 = 90.0;

/// Current autohide timeout (0 = off). Read by the watcher each tick so a
/// timeout change is picked up without restarting it.
static AUTOHIDE_MS: AtomicU64 = AtomicU64::new(0);
/// `0` = left, `1` = center, `2` = right. Read by `cursor_in_hotspot` so the
/// autohide reveal zone follows the notch along the top edge. The window's own
/// placement doesn't depend on it — alignment is CSS inside the monitor-wide
/// window.
static POSITION: AtomicU8 = AtomicU8::new(1);
/// Notch scale, stored as `f64` bits (atomics only hold integers). Read by
/// `position` so the window is tall enough for the scaled card. Initialized to
/// `1.0` (`0x3FF0_0000_0000_0000`).
static SCALE_BITS: AtomicU64 = AtomicU64::new(0x3FF0_0000_0000_0000);
/// Bumped whenever a watcher starts *or* stops. A watcher exits as soon as it
/// sees a generation other than its own, so an off→on toggle can start a fresh
/// watcher immediately instead of waiting for the old thread to notice a shared
/// stop flag — which is racy when the toggle lands inside one poll interval.
static WATCHER_GEN: AtomicU64 = AtomicU64::new(0);
/// True while the watcher for the current generation is alive; lets `apply`
/// refresh the timeout without spawning a second watcher.
static WATCHER_ACTIVE: AtomicBool = AtomicBool::new(false);
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
pub fn apply(app: &AppHandle, enabled: bool, autohide_ms: u64, position: &str, scale: f64) {
    let _guard = APPLY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Recorded for the autohide hotspot. On-screen alignment is pure CSS
    // inside the monitor-wide window, so a position change never moves the
    // window — one clean DOM move instead of a window jump.
    POSITION.store(position_code(position), Ordering::SeqCst);
    SCALE_BITS.store(scale.clamp(MIN_SCALE, MAX_SCALE).to_bits(), Ordering::SeqCst);
    if !enabled {
        stop_watcher();
        destroy(app);
        return;
    }
    ensure_window(app);
    // A scale change resizes the window (height only, never lateral), so apply
    // it live when the notch is already up. Position changes are CSS-only and
    // don't need this, but re-placing is idempotent.
    reposition_if_visible(app);
    if autohide_ms == 0 {
        stop_watcher();
        show(app);
        return;
    }
    AUTOHIDE_MS.store(autohide_ms, Ordering::SeqCst);
    if WATCHER_ACTIVE.load(Ordering::SeqCst) {
        return; // already watching; the timeout above was just refreshed
    }
    hide(app); // start hidden until the cursor comes near
    start_watcher(app.clone());
}

/// Tear the overlay window down entirely, releasing the WebView2 (and its
/// renderer process) rather than parking a hidden one for the rest of the
/// session. Called when the user disables the overlay.
fn destroy(app: &AppHandle) {
    VISIBLE.store(false, Ordering::SeqCst);
    let Some(win) = app.get_webview_window(LABEL) else {
        return;
    };
    let _ = win.destroy();
    // `destroy` only *posts* to the event loop; wait for the window to actually
    // leave the manager so a quick re-enable can't observe the stale window and
    // skip recreation. Bounded, so a wedged event loop can't hang the caller.
    let deadline = Instant::now() + Duration::from_secs(1);
    while app.get_webview_window(LABEL).is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    moonblast_log!("overlay: window destroyed");
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

/// Re-place the (monitor-wide) window if it's currently shown. Position
/// changes don't need it — alignment is CSS inside the window — but a **scale**
/// change resizes the window, and that must land without waiting for the next
/// show.
fn reposition_if_visible(app: &AppHandle) {
    if !VISIBLE.load(Ordering::SeqCst) {
        return;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        position(app, &win);
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

/// Bring up a fresh autohide watcher, superseding any still winding down.
fn start_watcher(app: AppHandle) {
    let gen = WATCHER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    WATCHER_ACTIVE.store(true, Ordering::SeqCst);
    std::thread::spawn(move || {
        let mut last_inside = now_ms();
        while WATCHER_GEN.load(Ordering::SeqCst) == gen {
            if cursor_in_hotspot(&app) {
                last_inside = now_ms();
                // Re-check: a concurrent `stop_watcher` (autohide turned off)
                // must not be undone by a late `show`.
                if WATCHER_GEN.load(Ordering::SeqCst) == gen {
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
        // Only clear the flag if no newer watcher has already taken over.
        if WATCHER_GEN.load(Ordering::SeqCst) == gen {
            WATCHER_ACTIVE.store(false, Ordering::SeqCst);
        }
    });
}

fn stop_watcher() {
    AUTOHIDE_MS.store(0, Ordering::SeqCst);
    // Invalidate any running watcher *and* let the next `start_watcher` run
    // immediately, instead of waiting for the old thread to exit.
    WATCHER_GEN.fetch_add(1, Ordering::SeqCst);
    WATCHER_ACTIVE.store(false, Ordering::SeqCst);
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

/// Span the launcher's monitor along its top edge, flush with the top so the
/// notch hangs from the top of the screen. The card's left / center / right
/// alignment is CSS inside this full-width window.
fn position(app: &AppHandle, win: &tauri::WebviewWindow) {
    let Some((mx, my, mw, dpi)) = monitor_metrics(app) else {
        return;
    };
    let ui = f64::from_bits(SCALE_BITS.load(Ordering::SeqCst)).clamp(MIN_SCALE, MAX_SCALE);
    let width = mw.round().max(1.0) as u32;
    let height = (HEIGHT * ui * dpi).round().max(1.0) as u32;
    let _ = win.set_size(PhysicalSize::new(width, height));
    let _ = win.set_position(PhysicalPosition::new(mx as i32, my as i32));
}
