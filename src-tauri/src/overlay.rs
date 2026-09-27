//! The in-stream **floating menu** — a second, always-on-top Tauri window
//! (`stream-menu`) that floats over a running Moonlight stream, Parsec-style.
//!
//! Unlike the volume OSD (`osd.rs`), this window is **interactive** (it has
//! buttons) but must **never steal focus** from the stream, because Moonlight
//! captures the keyboard/pointer and forwards them to the host game. So:
//!
//! - The window is `focusable(false)` (`WS_EX_NOACTIVATE`) — it can receive
//!   mouse clicks but never becomes the foreground window.
//! - Because it can't hold keyboard focus, its own React UI can't receive key
//!   events. While it is visible we register the navigation keys as *global
//!   hotkeys* (arrows / Enter / Escape) and forward them to the webview as
//!   `menu-key` events. Hotkeys are focus-independent — a `WH_KEYBOARD_LL` hook
//!   goes deaf whenever a Chromium/WebView2 window is in the foreground (the
//!   deafness described in `mediakeys.rs`), which is the case whenever the menu
//!   floats over Moonblast's own UI — so the hook is installed only as a
//!   fallback when the hotkeys can't be claimed.
//! - The summon hotkey is a `RegisterHotKey` global shortcut (works regardless
//!   of which window is focused), armed for the whole app lifetime so it can
//!   always bring the menu up even when `show_floating_menu` is off.
//!
//! Actions either run as Rust commands (Disconnect / End Session, which reuse
//! the stream teardown) or inject Moonlight's own `Ctrl+Alt+Shift+<key>`
//! shortcuts via `SendInput` (Moonlight is still the foreground window, so the
//! injected chord lands on it).

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicPtr, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, SendInput, UnregisterHotKey, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, VK_CONTROL, VK_MENU, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE,
    PeekMessageW, PostThreadMessageW, SetForegroundWindow, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_APP, WM_HOTKEY, WM_KEYDOWN, WM_KEYUP,
    WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use crate::moonblast_log;

/// Window label; the frontend branches on it to render `StreamMenu` instead of
/// the launcher, and the capability file lists it for event access.
pub const LABEL: &str = "stream-menu";

/// Fallback hotkey when settings hold an unparseable spec.
const DEFAULT_HOTKEY: &str = "Ctrl+Shift+F10";

const WIDTH: f64 = 300.0;
/// Seed size only — the frontend shrink-wraps the window to the list (see
/// `StreamMenu.tsx`), and `position` then reads the real size back off the
/// window. This just avoids a wrong-sized first frame.
const HEIGHT: f64 = 410.0;

/// Global-hotkey id for the summon shortcut (0x0000–0xBFFF).
const HK_MENU: i32 = 0x2100;

/// Nav keys, registered as global hotkeys while the menu is open. Hotkeys fire
/// regardless of which window has focus — unlike the low-level keyboard hook,
/// which goes deaf whenever a Chromium/WebView2 window is in the foreground
/// (the same issue `mediakeys.rs` hit). The hook is kept only as a fallback for
/// when these are already claimed.
const NAV_HOTKEYS: [(i32, u32); 7] = [
    (0x2201, 0x26), // up
    (0x2202, 0x28), // down
    (0x2203, 0x25), // left
    (0x2204, 0x27), // right
    (0x2205, 0x0D), // enter
    (0x2206, 0x1B), // escape
    (0x2207, 0x20), // space
];

/// Thread messages for the dedicated hotkey/hook thread.
const WM_APP_MENU_HOOK: u32 = WM_APP + 20; // wParam: 1 arm hook, 0 disarm
const WM_APP_MENU_NAV: u32 = WM_APP + 21; // wParam: VK forwarded to the webview
const WM_APP_MENU_RELOAD: u32 = WM_APP + 22; // re-register the summon hotkey
const WM_APP_MENU_OUTSIDE: u32 = WM_APP + 23; // click landed outside the overlay

static APP: Mutex<Option<AppHandle>> = Mutex::new(None);
static STARTED: AtomicBool = AtomicBool::new(false);
static THREAD_ID: AtomicU32 = AtomicU32::new(0);
/// The currently-registered hotkey as `(modifiers, vk)`.
static APPLIED: Mutex<Option<(u32, u32)>> = Mutex::new(None);
/// The hotkey we want registered (parsed from settings).
static DESIRED: Mutex<Option<(u32, u32)>> = Mutex::new(None);
static VISIBLE: AtomicBool = AtomicBool::new(false);
/// Anchor the overlay to the monitor centre instead of the trigger button.
/// Set by the Power view; cleared on hide so the next summon anchors again.
static CENTERED: AtomicBool = AtomicBool::new(false);
static HOOK: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
static HOOK_MOUSE: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
/// True while nav is driven by global hotkeys (the preferred path) rather than
/// the low-level keyboard-hook fallback.
static NAV_VIA_HOTKEYS: AtomicBool = AtomicBool::new(false);
static WATCHING: AtomicBool = AtomicBool::new(false);
/// Physical-pixel rects of the two overlay windows, kept in atomics so the
/// low-level mouse hook can test a click without ever taking a lock.
static MENU_RECT: [AtomicI32; 4] = [AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0)];
static MENU_RECT_VALID: AtomicBool = AtomicBool::new(false);
static BUTTON_RECT: [AtomicI32; 4] = [AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0)];
static BUTTON_RECT_VALID: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct MenuKey {
    key: String,
}

/// Sent to the button window to (un)highlight it as the menu's current target.
#[derive(Clone, serde::Serialize)]
struct MenuFocus {
    on: bool,
}

/// Best-effort mirror of Moonlight's *live* stream toggles, shown as checkboxes
/// in the floating menu. Moonlight exposes no read-back for any of these at
/// runtime — the chord we inject only mutates its session state — so each flag
/// is seeded from the exact flags the stream was spawned with and flipped
/// locally whenever its chord is injected. The mirror drifts only if the user
/// presses Moonlight's own shortcut directly, or Moonlight changes state on its
/// own (e.g. releasing pointer capture when the window loses focus).
#[derive(Clone, Copy, serde::Serialize)]
pub struct StreamToggles {
    /// Performance overlay (`Ctrl+Alt+Shift+S`).
    pub stats: bool,
    /// Fullscreen (`Ctrl+Alt+Shift+X`).
    pub fullscreen: bool,
    /// Mouse/pointer capture (`Ctrl+Alt+Shift+Z`).
    pub mouse_capture: bool,
    /// Mouse mode: `false` = relative, `true` = absolute (`Ctrl+Alt+Shift+M`).
    pub mouse_absolute: bool,
}

static TOGGLES: Mutex<StreamToggles> = Mutex::new(StreamToggles {
    stats: false,
    fullscreen: true,
    mouse_capture: true,
    mouse_absolute: false,
});

/// Last `show_floating_menu` value seen by `on_settings_changed`, so the
/// real-time reconcile only fires on an actual change (that hook runs on every
/// settings write, including unrelated ones).
static LAST_AUTO_SHOW: Mutex<Option<bool>> = Mutex::new(None);

fn toggles() -> StreamToggles {
    TOGGLES.lock().map(|t| *t).unwrap_or(StreamToggles {
        stats: false,
        fullscreen: true,
        mouse_capture: true,
        mouse_absolute: false,
    })
}

fn emit_toggles(app: &AppHandle) {
    let _ = app.emit_to(LABEL, "stream-toggles", toggles());
}

/// Seed the mirror from the flags a stream is about to spawn with. Called on
/// every stream start — even when auto-show is off, since the summon hotkey can
/// still bring the menu up.
pub fn reset_toggles(app: &AppHandle, fullscreen: bool, stats: bool, mouse_absolute: bool) {
    if let Ok(mut t) = TOGGLES.lock() {
        *t = StreamToggles {
            stats,
            fullscreen,
            mouse_capture: true,
            mouse_absolute,
        };
    }
    emit_toggles(app);
}

/// Flip the mirrored flag for the toggle chords. A no-op for the one-shot
/// chords (minimize), so the mirror only tracks what it can.
fn apply_toggle_key(app: &AppHandle, key: &str) {
    let changed = match TOGGLES.lock() {
        Ok(mut t) => match key.to_ascii_lowercase().as_str() {
            "s" => {
                t.stats = !t.stats;
                true
            }
            "x" => {
                t.fullscreen = !t.fullscreen;
                true
            }
            "z" => {
                t.mouse_capture = !t.mouse_capture;
                true
            }
            "m" => {
                t.mouse_absolute = !t.mouse_absolute;
                true
            }
            _ => false,
        },
        Err(_) => false,
    };
    if changed {
        emit_toggles(app);
    }
}

fn app_handle() -> Option<AppHandle> {
    APP.lock().ok().and_then(|g| g.clone())
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Store the app handle and start the hotkey/hook thread. Called once from
/// `setup`. Idempotent.
pub fn init(app: AppHandle) {
    if let Ok(mut g) = APP.lock() {
        *g = Some(app.clone());
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let desired = {
        let state = app.state::<crate::settings::SettingsState>();
        let guard = state.0.lock().unwrap();
        parse_hotkey(&guard.moonlight.floating_menu_hotkey)
            .or_else(|_| parse_hotkey(DEFAULT_HOTKEY))
            .ok()
    };
    if let Ok(mut d) = DESIRED.lock() {
        *d = desired;
    }
    std::thread::spawn(thread_main);
    moonblast_log!("overlay: hotkey thread started");
}

/// Re-apply the summon hotkey after a settings write, and mirror the
/// "Show Floating Menu" preference onto what is currently on screen so the
/// checkbox takes effect immediately rather than at the next stream.
pub fn on_settings_changed(app: &AppHandle, settings: &crate::settings::Settings) {
    let parsed = parse_hotkey(&settings.moonlight.floating_menu_hotkey)
        .or_else(|_| parse_hotkey(DEFAULT_HOTKEY))
        .ok();
    let changed = {
        let mut desired = match DESIRED.lock() {
            Ok(d) => d,
            Err(_) => return,
        };
        if *desired == parsed {
            false
        } else {
            *desired = parsed;
            true
        }
    };
    if changed {
        reload_hotkey();
    }

    let enabled = settings.moonlight.show_floating_menu;
    let auto_show_changed = match LAST_AUTO_SHOW.lock() {
        Ok(mut last) => {
            if *last == Some(enabled) {
                false
            } else {
                *last = Some(enabled);
                true
            }
        }
        Err(_) => false,
    };
    if !auto_show_changed {
        return;
    }
    // Window work must not run on the IPC/main thread.
    let app = app.clone();
    std::thread::spawn(move || {
        if !enabled && VISIBLE.load(Ordering::SeqCst) {
            // Switching off takes an open menu down with it.
            hide_now(&app);
        } else {
            // Switching on only offers the trigger button — popping the menu open
            // mid-stream would be a surprise. The menu itself arrives on a click,
            // on the summon hotkey, or from the next stream's auto-show.
            reconcile_button(&app);
        }
    });
}

fn reload_hotkey() {
    let tid = THREAD_ID.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            PostThreadMessageW(tid, WM_APP_MENU_RELOAD, 0, 0);
        }
    }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/// The host + app + local PID of a live stream, if any.
fn active_stream_full(app: &AppHandle) -> Option<(String, String, u32)> {
    let state = app.try_state::<crate::StreamState>()?;
    let mut map = state.0.lock().ok()?;
    for (key, active) in map.iter_mut() {
        if let Ok(None) = active.child.try_wait() {
            if let Some((host, app_name)) = key.split_once('\u{1f}') {
                return Some((host.to_string(), app_name.to_string(), active.child.id()));
            }
        }
    }
    None
}

/// Everything the overlay offers is gated on a live stream Moonblast launched:
/// `StreamState` holds the child we spawned, and `try_wait` tells us it's alive.
fn has_active_stream(app: &AppHandle) -> bool {
    active_stream_full(app).is_some()
}

fn auto_show_enabled(app: &AppHandle) -> bool {
    let state = app.state::<crate::settings::SettingsState>();
    let guard = state.0.lock().unwrap();
    guard.moonlight.show_floating_menu
}

/// The hotkey / auto-show are only meaningful while a stream is running.
fn available(app: &AppHandle) -> bool {
    has_active_stream(app)
}

// ---------------------------------------------------------------------------
// Show / hide / toggle
// ---------------------------------------------------------------------------

/// Called once a stream starts. Brings the floating menu up when the user has
/// it enabled; otherwise nothing is shown until the summon hotkey. Runs on a
/// short delay so Moonlight's own window exists and owns the foreground first.
pub fn maybe_autoshow(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700));
        if !has_active_stream(&app) {
            return;
        }
        if auto_show_enabled(&app) {
            show_now(&app);
        }
    });
}

/// Request a toggle from a Tauri command (runs on the main thread, where
/// window creation would deadlock — so hop to a worker).
pub fn request_toggle(app: AppHandle) {
    std::thread::spawn(move || toggle_now(&app));
}

/// Request a hide from a Tauri command.
pub fn request_hide(app: AppHandle) {
    std::thread::spawn(move || hide_now(&app));
}

/// Hide both the menu and the trigger button (stream teardown).
pub fn request_hide_all(app: AppHandle) {
    std::thread::spawn(move || {
        hide_now(&app);
        hide_button_now(&app);
    });
}

fn toggle_now(app: &AppHandle) {
    if VISIBLE.load(Ordering::SeqCst) {
        hide_now(app);
    } else if available(app) {
        show_now(app);
    } else {
        moonblast_log!("overlay: summon ignored (no active stream)");
    }
}

fn show_now(app: &AppHandle) {
    if !ensure_window(app) {
        return;
    }
    // The menu anchors to the button, so the button has to be up — and its rect
    // known — *before* we place the menu. `position` can only read a button rect
    // while `BUTTON_VISIBLE` is set, so doing this after the fact left the menu
    // centred on the monitor instead of anchored.
    show_button_now(app);
    if let Some(win) = app.get_webview_window(LABEL) {
        position(app, &win);
        let _ = win.show();
        // Re-assert topmost in case another topmost window grabbed z-order.
        let _ = win.set_always_on_top(true);
    }
    VISIBLE.store(true, Ordering::SeqCst);
    arm_hook(true);
    let _ = app.emit_to(LABEL, "menu-shown", ());
    start_watch(app.clone());
    reconcile_button(app);
    moonblast_log!("overlay: shown");
}

fn hide_now(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
    VISIBLE.store(false, Ordering::SeqCst);
    MENU_RECT_VALID.store(false, Ordering::Relaxed);
    // Back to button-anchored for the next summon. The Power view blew the
    // window up to the whole monitor, so restore the seed size too — otherwise
    // `show_now` would place a full-screen transparent window and swallow the
    // first click before the webview re-measures.
    if CENTERED.swap(false, Ordering::SeqCst) {
        if let Some(win) = app.get_webview_window(LABEL) {
            let _ = win.set_size(tauri::LogicalSize::new(WIDTH, HEIGHT));
        }
    }
    arm_hook(false);
    // The button must not stay highlighted once the menu is gone.
    let _ = app.emit_to(BUTTON_LABEL, "menu-focus", MenuFocus { on: false });
    reconcile_button(app);
    moonblast_log!("overlay: hidden");
}

/// Button visibility: shown whenever the menu is up **or** the setting is on.
///
/// | setting | menu | button |
/// |---|---|---|
/// | on  | up   | yes — the drag handle stays available |
/// | on  | down | yes — the way back to a dismissed menu |
/// | off | up   | yes — accompanies a manually summoned menu |
/// | off | down | no — nothing floating at all, hotkey only |
///
/// Call this after anything that changes either side.
fn reconcile_button(app: &AppHandle) {
    if VISIBLE.load(Ordering::SeqCst) || auto_show_enabled(app) {
        show_button_now(app);
    } else {
        hide_button_now(app);
    }
}

// ---------------------------------------------------------------------------
// Floating trigger button (`stream-button`) — a small, draggable, always-on-top
// handle that opens the menu (Parsec-style). Same non-focus-stealing rules as
// the menu, but it stays put while streaming so there's a visible affordance
// beyond the hotkey.
// ---------------------------------------------------------------------------

pub const BUTTON_LABEL: &str = "stream-button";
/// The button (and window) size. The window is a plain transparent square and
/// the circle is pure CSS — no OS region clip.
const BUTTON_SIZE: f64 = 44.0;
const BUTTON_MARGIN: f64 = 16.0;

static BUTTON_VISIBLE: AtomicBool = AtomicBool::new(false);
/// Set once the user drags the button. Until then every show re-applies the
/// default resting spot (so it tracks the stream's monitor); afterwards the
/// user's position wins for the life of the window.
static BUTTON_PINNED: AtomicBool = AtomicBool::new(false);

fn ensure_button_window(app: &AppHandle) -> bool {
    if app.get_webview_window(BUTTON_LABEL).is_some() {
        return true;
    }
    match WebviewWindowBuilder::new(app, BUTTON_LABEL, WebviewUrl::App("index.html".into()))
        .title("Moonblast Menu Button")
        .inner_size(BUTTON_SIZE, BUTTON_SIZE)
        // Windows otherwise clamps a fresh window to SM_CXMINTRACK (136px),
        // which turned the button into a wide pill.
        .min_inner_size(BUTTON_SIZE, BUTTON_SIZE)
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
            // Windows clamps a fresh window to SM_CXMINTRACK (136px); lower the
            // minimum so the button can actually be this small.
            let _ = win.set_min_size(Some(tauri::LogicalSize::new(BUTTON_SIZE, BUTTON_SIZE)));
            let _ = win.set_size(tauri::LogicalSize::new(BUTTON_SIZE, BUTTON_SIZE));
            moonblast_log!("overlay: button window created");
            true
        }
        Err(e) => {
            moonblast_log!("overlay: button window creation failed: {e}");
            false
        }
    }
}

/// Default resting spot: top-center of the stream's monitor. `show_button_now`
/// applies it on every show *until* the user drags the button (`BUTTON_PINNED`),
/// from which point the user's spot wins.
fn position_button(app: &AppHandle, win: &tauri::WebviewWindow) {
    let scale = app
        .get_webview_window("main")
        .and_then(|m| m.scale_factor().ok())
        .unwrap_or(1.0);
    let margin = (BUTTON_MARGIN * scale).round() as i32;
    let Some((x, y, rw, _rh)) = stream_monitor_rect(app).or_else(|| main_monitor_rect(app)) else {
        return;
    };
    // Use the window's real size (Windows may have clamped it), so the circle
    // still ends up centered on the monitor.
    let (w, h) = win
        .outer_size()
        .map(|s| (s.width as i32, s.height as i32))
        .unwrap_or_else(|_| {
            let s = (BUTTON_SIZE * scale).round() as i32;
            (s, s)
        });
    let px = x + ((rw - w) / 2).max(0);
    let py = y + margin;
    let _ = win.set_position(PhysicalPosition::new(px, py));
    set_rect(&BUTTON_RECT, &BUTTON_RECT_VALID, px, py, w, h);
}

fn show_button_now(app: &AppHandle) {
    if !ensure_button_window(app) {
        return;
    }
    if let Some(win) = app.get_webview_window(BUTTON_LABEL) {
        if BUTTON_PINNED.load(Ordering::SeqCst) {
            // The user placed it — keep it, but re-publish the rect: the menu
            // anchors to it and the click-outside test needs it, and neither
            // should read a stale value after a hide/show.
            if let (Ok(p), Ok(s)) = (win.outer_position(), win.outer_size()) {
                set_rect(
                    &BUTTON_RECT,
                    &BUTTON_RECT_VALID,
                    p.x,
                    p.y,
                    s.width as i32,
                    s.height as i32,
                );
            }
        } else {
            position_button(app, &win);
        }
        let _ = win.show();
        let _ = win.set_always_on_top(true);
    }
    BUTTON_VISIBLE.store(true, Ordering::SeqCst);
    start_watch(app.clone());
    moonblast_log!("overlay: button shown");
}

fn hide_button_now(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(BUTTON_LABEL) {
        let _ = win.hide();
    }
    BUTTON_VISIBLE.store(false, Ordering::SeqCst);
    BUTTON_RECT_VALID.store(false, Ordering::Relaxed);
}

/// Once anything is visible, hide the menu + button automatically if the
/// stream ends (the user quit Moonlight directly, connection dropped, …).
fn start_watch(app: AppHandle) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(1000));
            if !VISIBLE.load(Ordering::SeqCst) && !BUTTON_VISIBLE.load(Ordering::SeqCst) {
                break;
            }
            if !has_active_stream(&app) {
                hide_now(&app);
                hide_button_now(&app);
                break;
            }
        }
        WATCHING.store(false, Ordering::SeqCst);
    });
}

fn arm_hook(arm: bool) {
    let tid = THREAD_ID.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            PostThreadMessageW(tid, WM_APP_MENU_HOOK, if arm { 1 } else { 0 }, 0);
        }
    }
}

/// Create the window if it doesn't exist yet. Must not run on the main thread.
fn ensure_window(app: &AppHandle) -> bool {
    if app.get_webview_window(LABEL).is_some() {
        return true;
    }
    match WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Moonblast Stream Menu")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        // Never takes focus — the stream keeps keyboard + pointer capture.
        .focusable(false)
        .visible(false)
        .build()
    {
        Ok(_) => {
            moonblast_log!("overlay: window created");
            true
        }
        Err(e) => {
            moonblast_log!("overlay: window creation failed: {e}");
            false
        }
    }
}

/// Place the menu. It "spawns from" the trigger button when that's up (anchored
/// to it, flipping above/below to stay on-screen); otherwise it centers on the
/// stream's monitor.
fn position(app: &AppHandle, win: &tauri::WebviewWindow) {
    let scale = app
        .get_webview_window("main")
        .and_then(|m| m.scale_factor().ok())
        .unwrap_or(1.0);
    let (w, h) = win
        .outer_size()
        .ok()
        .map(|s| (s.width as i32, s.height as i32))
        .filter(|(w, h)| *w > 0 && *h > 0)
        .unwrap_or((
            (WIDTH * scale).round() as i32,
            (HEIGHT * scale).round() as i32,
        ));
    let monitor = stream_monitor_rect(app).or_else(|| main_monitor_rect(app));
    // Anchor the *list* column. Extra width is an open submenu flyout, which
    // must extend to the right without dragging the list sideways.
    let anchor_w = (WIDTH * scale).round() as i32;

    // The Power view is a modal: centre it instead of hanging it off the button.
    if !CENTERED.load(Ordering::SeqCst) {
        if let Some((bx, by, bw, bh)) = button_rect(app) {
            let gap = (10.0 * scale).round() as i32;
            let mut x = bx + bw / 2 - anchor_w / 2;
            // Prefer opening just below the button; flip above when it won't fit.
            let mut y = by + bh + gap;
            if let Some((mx, my, mw, mh)) = monitor {
                x = x.clamp(mx, (mx + mw - anchor_w).max(mx));
                if y + h > my + mh {
                    let above = by - gap - h;
                    y = if above >= my { above } else { (my + mh - h).max(my) };
                }
                y = y.max(my);
            }
            let _ = win.set_position(PhysicalPosition::new(x, y));
            set_rect(&MENU_RECT, &MENU_RECT_VALID, x, y, w, h);
            return;
        }
    }

    let Some((x, y, rw, rh)) = monitor else {
        return;
    };
    let px = x + ((rw - w) / 2).max(0);
    let py = y + ((rh - h) / 2).max(0);
    let _ = win.set_position(PhysicalPosition::new(px, py));
    set_rect(&MENU_RECT, &MENU_RECT_VALID, px, py, w, h);
}

/// Rect of the trigger button when it's currently showing.
fn button_rect(app: &AppHandle) -> Option<(i32, i32, i32, i32)> {
    if !BUTTON_VISIBLE.load(Ordering::SeqCst) {
        return None;
    }
    let win = app.get_webview_window(BUTTON_LABEL)?;
    let p = win.outer_position().ok()?;
    let s = win.outer_size().ok()?;
    Some((p.x, p.y, s.width as i32, s.height as i32))
}

/// `(x, y, width, height)` of the monitor the active stream lives on.
fn stream_monitor_rect(app: &AppHandle) -> Option<(i32, i32, i32, i32)> {
    let (_, _, pid) = active_stream_full(app)?;
    let hwnd = hwnd_for_pid(pid)?;
    let hmon = unsafe { MonitorFromWindow(hwnd as _, MONITOR_DEFAULTTONEAREST) };
    if hmon.is_null() {
        return None;
    }
    let mut mi: MONITORINFO = unsafe { std::mem::zeroed() };
    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(hmon, &mut mi) } == 0 {
        return None;
    }
    let r = mi.rcMonitor;
    Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
}

fn main_monitor_rect(app: &AppHandle) -> Option<(i32, i32, i32, i32)> {
    let main = app.get_webview_window("main")?;
    let m = main.current_monitor().ok().flatten()?;
    let p = m.position();
    let s = m.size();
    Some((p.x, p.y, s.width as i32, s.height as i32))
}

/// Top-level visible window owned by `pid`, if any.
fn hwnd_for_pid(pid: u32) -> Option<isize> {
    let mut found = None;
    crate::for_each_visible_window(|hwnd, owner| {
        if owner == pid {
            found = Some(hwnd);
            false
        } else {
            true
        }
    });
    found
}

// ---------------------------------------------------------------------------
// Hotkey thread (message loop + LL keyboard hook)
// ---------------------------------------------------------------------------

fn thread_main() {
    unsafe {
        // The thread needs a message queue for both the hook and WM_HOTKEY.
        let mut msg: MSG = std::mem::zeroed();
        PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
    }
    apply_hotkey();

    loop {
        let mut msg: MSG = unsafe { std::mem::zeroed() };
        let r = unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) };
        if r <= 0 {
            break;
        }
        match msg.message {
            WM_HOTKEY => {
                let id = msg.wParam as i32;
                if id == HK_MENU {
                    if let Some(app) = app_handle() {
                        toggle_now(&app);
                    }
                } else if let Some(name) = nav_key_for_hotkey(id) {
                    if let Some(app) = app_handle() {
                        let _ = app.emit_to(LABEL, "menu-key", MenuKey { key: name.into() });
                    }
                }
            }
            WM_APP_MENU_NAV => {
                if let (Some(app), Some(name)) =
                    (app_handle(), nav_key_name(msg.wParam as u32))
                {
                    let _ = app.emit_to(LABEL, "menu-key", MenuKey { key: name.into() });
                }
            }
            WM_APP_MENU_HOOK => set_hook(msg.wParam == 1),
            WM_APP_MENU_RELOAD => apply_hotkey(),
            WM_APP_MENU_OUTSIDE => {
                if let Some(app) = app_handle() {
                    if VISIBLE.load(Ordering::SeqCst) {
                        hide_now(&app);
                    }
                }
            }
            _ => unsafe {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            },
        }
    }

    set_hook(false);
    unregister_hotkey();
    THREAD_ID.store(0, Ordering::SeqCst);
    moonblast_log!("overlay: hotkey thread exiting");
}

/// Unregister the applied hotkey (if any) and register the desired one.
fn apply_hotkey() {
    let desired = DESIRED.lock().ok().and_then(|g| *g);
    let mut applied = match APPLIED.lock() {
        Ok(a) => a,
        Err(_) => return,
    };
    if *applied == desired {
        return;
    }
    if applied.is_some() {
        unsafe {
            UnregisterHotKey(std::ptr::null_mut(), HK_MENU);
        }
    }
    *applied = None;
    if let Some((mods, vk)) = desired {
        let ok = unsafe {
            RegisterHotKey(std::ptr::null_mut(), HK_MENU, mods | MOD_NOREPEAT, vk)
        };
        if ok != 0 {
            *applied = Some((mods, vk));
            moonblast_log!("overlay: hotkey registered (mods=0x{mods:04X}, vk=0x{vk:02X})");
        } else {
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            moonblast_log!("overlay: RegisterHotKey failed (err={err})");
        }
    }
}

fn unregister_hotkey() {
    if let Ok(mut applied) = APPLIED.lock() {
        if applied.is_some() {
            unsafe {
                UnregisterHotKey(std::ptr::null_mut(), HK_MENU);
            }
            *applied = None;
        }
    }
}

fn set_hook(arm: bool) {
    if arm {
        arm_nav();
        arm_mouse_hook();
    } else {
        disarm_nav();
        disarm_mouse_hook();
    }
}

/// Nav input: global hotkeys first (focus-independent), low-level keyboard hook
/// only as a fallback. The hook is deaf while a Chromium/WebView2 window has
/// focus, which is exactly the "arrows sometimes don't work" symptom.
fn arm_nav() {
    if register_nav_hotkeys() {
        NAV_VIA_HOTKEYS.store(true, Ordering::SeqCst);
        moonblast_log!("overlay: nav hotkeys registered");
        return;
    }
    let hmod = unsafe { GetModuleHandleW(std::ptr::null()) };
    let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(nav_proc), hmod, 0) };
    if hook.is_null() {
        moonblast_log!("overlay: nav input unavailable (hotkeys + hook both failed)");
    } else {
        HOOK.store(hook, Ordering::SeqCst);
        moonblast_log!("overlay: nav hotkeys taken; using keyboard-hook fallback");
    }
}

fn disarm_nav() {
    if NAV_VIA_HOTKEYS.swap(false, Ordering::SeqCst) {
        unregister_nav_hotkeys();
        moonblast_log!("overlay: nav hotkeys unregistered");
    }
    let hook = HOOK.swap(std::ptr::null_mut(), Ordering::SeqCst);
    if !hook.is_null() {
        unsafe {
            UnhookWindowsHookEx(hook);
        }
        moonblast_log!("overlay: keyboard hook released");
    }
}

fn arm_mouse_hook() {
    if !HOOK_MOUSE.load(Ordering::SeqCst).is_null() {
        return;
    }
    let hmod = unsafe { GetModuleHandleW(std::ptr::null()) };
    let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hmod, 0) };
    if hook.is_null() {
        moonblast_log!("overlay: mouse hook install failed");
    } else {
        HOOK_MOUSE.store(hook, Ordering::SeqCst);
        moonblast_log!("overlay: mouse hook armed");
    }
}

fn disarm_mouse_hook() {
    let hook = HOOK_MOUSE.swap(std::ptr::null_mut(), Ordering::SeqCst);
    if !hook.is_null() {
        unsafe {
            UnhookWindowsHookEx(hook);
        }
        moonblast_log!("overlay: mouse hook released");
    }
}

/// Register the nav keys as global hotkeys. All-or-nothing: a partial success is
/// rolled back so the hook fallback is unambiguous.
fn register_nav_hotkeys() -> bool {
    for (id, vk) in NAV_HOTKEYS {
        if unsafe { RegisterHotKey(std::ptr::null_mut(), id, 0, vk) } == 0 {
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            moonblast_log!("overlay: nav RegisterHotKey(vk=0x{vk:02X}) failed (err={err})");
            unregister_nav_hotkeys();
            return false;
        }
    }
    true
}

fn unregister_nav_hotkeys() {
    for (id, _) in NAV_HOTKEYS {
        unsafe {
            UnregisterHotKey(std::ptr::null_mut(), id);
        }
    }
}

fn nav_key_for_hotkey(id: i32) -> Option<&'static str> {
    NAV_HOTKEYS
        .iter()
        .find(|(hid, _)| *hid == id)
        .and_then(|(_, vk)| nav_key_name(*vk))
}

/// Store a physical-pixel rect for the hook's hit test.
fn set_rect(rect: &[AtomicI32; 4], valid: &AtomicBool, x: i32, y: i32, w: i32, h: i32) {
    rect[0].store(x, Ordering::Relaxed);
    rect[1].store(y, Ordering::Relaxed);
    rect[2].store(w, Ordering::Relaxed);
    rect[3].store(h, Ordering::Relaxed);
    valid.store(true, Ordering::Relaxed);
}

fn hit(rect: &[AtomicI32; 4], valid: &AtomicBool, x: i32, y: i32) -> bool {
    if !valid.load(Ordering::Relaxed) {
        return false;
    }
    let rx = rect[0].load(Ordering::Relaxed);
    let ry = rect[1].load(Ordering::Relaxed);
    let rw = rect[2].load(Ordering::Relaxed);
    let rh = rect[3].load(Ordering::Relaxed);
    x >= rx && x < rx + rw && y >= ry && y < ry + rh
}

/// Low-level mouse hook: a button-down outside the menu + button closes the
/// menu. The click is deliberately **not** swallowed, so it still reaches
/// whatever is underneath (i.e. the game).
unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let msg = wparam as u32;
        if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN)
            && VISIBLE.load(Ordering::SeqCst)
        {
            let ms = unsafe { &*(lparam as *const MSLLHOOKSTRUCT) };
            let (x, y) = (ms.pt.x, ms.pt.y);
            if !hit(&MENU_RECT, &MENU_RECT_VALID, x, y)
                && !hit(&BUTTON_RECT, &BUTTON_RECT_VALID, x, y)
            {
                let tid = THREAD_ID.load(Ordering::SeqCst);
                if tid != 0 {
                    unsafe {
                        PostThreadMessageW(tid, WM_APP_MENU_OUTSIDE, 0, 0);
                    }
                }
            }
        }
    }
    unsafe { CallNextHookEx(HOOK_MOUSE.load(Ordering::SeqCst), code, wparam, lparam) }
}

/// Maps a nav virtual key to the string the webview understands.
fn nav_key_name(vk: u32) -> Option<&'static str> {
    Some(match vk {
        0x26 => "up",
        0x28 => "down",
        0x25 => "left",
        0x27 => "right",
        0x0D => "enter",
        0x1B => "escape",
        0x20 => "space",
        _ => return None,
    })
}

/// Low-level hook callback: swallow the nav keys (both down and up, so the
/// game never sees a stuck key) and forward the key-downs to the menu thread.
unsafe extern "system" fn nav_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let msg = wparam as u32;
        let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
        if down || up {
            let kb = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
            if nav_key_name(kb.vkCode).is_some() {
                if down {
                    let tid = THREAD_ID.load(Ordering::SeqCst);
                    if tid != 0 {
                        unsafe {
                            PostThreadMessageW(tid, WM_APP_MENU_NAV, kb.vkCode as WPARAM, 0);
                        }
                    }
                }
                return 1;
            }
        }
    }
    unsafe { CallNextHookEx(HOOK.load(Ordering::SeqCst), code, wparam, lparam) }
}

// ---------------------------------------------------------------------------
// Hotkey parsing
// ---------------------------------------------------------------------------

fn parse_hotkey(spec: &str) -> Result<(u32, u32), String> {
    let mut mods = 0u32;
    let mut vk: Option<u32> = None;
    for part in spec.split('+') {
        let p = part.trim().to_ascii_lowercase();
        if p.is_empty() {
            continue;
        }
        match p.as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL,
            "alt" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            "win" | "super" | "meta" => mods |= MOD_WIN,
            other => {
                if vk.is_some() {
                    return Err("Shortcut can only contain one key".into());
                }
                vk = Some(vk_for_name(other).ok_or_else(|| format!("Unknown key '{other}'"))?);
            }
        }
    }
    let vk = vk.ok_or_else(|| "Shortcut needs a key".to_string())?;
    if mods == 0 {
        return Err("Shortcut needs at least one modifier (Ctrl/Alt/Shift/Win)".into());
    }
    if mods == (MOD_CONTROL | MOD_ALT | MOD_SHIFT) {
        return Err("Ctrl+Alt+Shift is reserved by Moonlight".into());
    }
    Ok((mods, vk))
}

fn vk_for_name(name: &str) -> Option<u32> {
    // F1..F24
    if let Some(rest) = name.strip_prefix('f') {
        if let Ok(n) = rest.parse::<u32>() {
            if (1..=24).contains(&n) {
                return Some(0x70 + (n - 1));
            }
        }
    }
    if name.len() == 1 {
        let c = name.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            return Some(c.to_ascii_uppercase() as u32);
        }
        if c.is_ascii_digit() {
            return Some(c as u32);
        }
    }
    Some(match name {
        "space" | "spacebar" => 0x20,
        "tab" => 0x09,
        "enter" | "return" => 0x0D,
        "escape" | "esc" => 0x1B,
        "backspace" => 0x08,
        "insert" | "ins" => 0x2D,
        "delete" | "del" => 0x2E,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" | "pgup" => 0x21,
        "pagedown" | "pgdn" => 0x22,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        "minus" | "-" => 0xBD,
        "equal" | "=" => 0xBB,
        "comma" | "," => 0xBC,
        "period" | "." => 0xBE,
        "slash" | "/" => 0xBF,
        "backslash" | "\\" => 0xDC,
        "semicolon" | ";" => 0xBA,
        "quote" | "'" => 0xDE,
        "bracketleft" | "[" => 0xDB,
        "bracketright" | "]" => 0xDD,
        "grave" | "`" => 0xC0,
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Moonlight key injection
// ---------------------------------------------------------------------------

/// VK for one of Moonlight's `Ctrl+Alt+Shift+<key>` shortcuts.
fn chord_vk(key: &str) -> Option<u16> {
    Some(match key.to_ascii_lowercase().as_str() {
        "q" => 0x51,
        "z" => 0x5A,
        "x" => 0x58,
        "s" => 0x53,
        "m" => 0x4D,
        "v" => 0x56,
        "d" => 0x44,
        _ => return None,
    })
}

fn key_input(vk: u16, up: bool) -> INPUT {
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.r#type = INPUT_KEYBOARD;
    input.Anonymous.ki = KEYBDINPUT {
        wVk: vk,
        wScan: 0,
        dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
        time: 0,
        dwExtraInfo: 0,
    };
    input
}

/// Inject Moonlight's `Ctrl+Alt+Shift+<vk>` chord into the foreground window.
fn send_chord(vk: u16) {
    let seq = [VK_CONTROL, VK_MENU, VK_SHIFT, vk];
    let mut inputs: Vec<INPUT> = Vec::with_capacity(seq.len() * 2);
    for &v in &seq {
        inputs.push(key_input(v, false));
    }
    for &v in seq.iter().rev() {
        inputs.push(key_input(v, true));
    }
    unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn stream_menu_hide(app: AppHandle) {
    request_hide(app);
}

/// Clicked the floating trigger button → toggle the menu.
#[tauri::command]
pub fn stream_button_click(app: AppHandle) {
    request_toggle(app);
}

/// The user actually dragged the button: stop re-placing it at the default
/// resting spot on every show.
#[tauri::command]
pub fn stream_button_moved() {
    BUTTON_PINNED.store(true, Ordering::SeqCst);
}

/// Keep the open menu attached to the button while the button is dragged.
/// No-op when the menu isn't showing.
#[tauri::command]
pub fn stream_menu_follow(app: AppHandle) {
    // Keep the button rect fresh for the click-outside test even when the menu
    // is closed (the button can be dragged on its own).
    if let Some(win) = app.get_webview_window(BUTTON_LABEL) {
        if let (Ok(p), Ok(s)) = (win.outer_position(), win.outer_size()) {
            set_rect(
                &BUTTON_RECT,
                &BUTTON_RECT_VALID,
                p.x,
                p.y,
                s.width as i32,
                s.height as i32,
            );
        }
    }
    if VISIBLE.load(Ordering::SeqCst) {
        if let Some(win) = app.get_webview_window(LABEL) {
            position(&app, &win);
        }
    }
}

/// Inject one of Moonlight's `Ctrl+Alt+Shift+<key>` chords and update the toggle
/// mirror. Shared by the plain key command and the mouse-mode submenu.
fn inject_chord(app: &AppHandle, key: &str) -> Result<(), String> {
    let vk = chord_vk(key).ok_or_else(|| format!("Unknown shortcut '{key}'"))?;
    // Defensive: make sure Moonlight (not something else) owns the foreground
    // before we inject, so the chord can't leak to another window.
    if let Some((_, _, pid)) = active_stream_full(app) {
        if let Some(hwnd) = hwnd_for_pid(pid) {
            unsafe {
                SetForegroundWindow(hwnd as _);
            }
        }
    }
    send_chord(vk);
    apply_toggle_key(app, key);
    Ok(())
}

#[tauri::command]
pub fn stream_menu_key(app: AppHandle, key: String) -> Result<(), String> {
    inject_chord(&app, &key)
}

/// Current mirrored toggle state, read by the menu on open.
#[tauri::command]
pub fn stream_menu_toggles() -> StreamToggles {
    toggles()
}

/// Pick a specific mouse mode from the submenu. Moonlight only has a toggle, so
/// inject the chord only when the mirror says we're in the other mode.
#[tauri::command]
pub fn stream_menu_set_mouse_mode(app: AppHandle, absolute: bool) -> Result<(), String> {
    if toggles().mouse_absolute != absolute {
        inject_chord(&app, "m")?;
    }
    Ok(())
}

/// Client-only disconnect: kills the local streaming window but leaves the
/// game running on the host (Parsec-style "Disconnect").
#[tauri::command]
pub fn stream_menu_disconnect(app: AppHandle) -> Result<(), String> {
    let (host, app_name, _) =
        active_stream_full(&app).ok_or_else(|| "No active stream".to_string())?;
    let state = app.state::<crate::settings::SettingsState>();
    let streams = app.state::<crate::StreamState>();
    crate::quit_stream_inner(&app, &state, &streams, &host, &app_name, false);
    hide_now(&app);
    hide_button_now(&app);
    Ok(())
}

/// End session: stops the app on the host *and* kills the local stream window.
#[tauri::command]
pub fn stream_menu_end_session(app: AppHandle) -> Result<(), String> {
    let (host, app_name, _) =
        active_stream_full(&app).ok_or_else(|| "No active stream".to_string())?;
    let state = app.state::<crate::settings::SettingsState>();
    let streams = app.state::<crate::StreamState>();
    crate::quit_stream_inner(&app, &state, &streams, &host, &app_name, true);
    hide_now(&app);
    hide_button_now(&app);
    Ok(())
}

/// Show the overlay centered on the monitor instead of anchored to the button —
/// used by the Power view, which is a modal with a full-monitor scrim.
///
/// The window is blown up to the whole monitor so the frontend can paint a
/// tinted backdrop behind the centred panel; `hide_now` puts the seed size back
/// so the next summon is placed before the webview re-measures.
#[tauri::command]
pub fn stream_menu_center(app: AppHandle, centered: bool) {
    CENTERED.store(centered, Ordering::SeqCst);
    if !VISIBLE.load(Ordering::SeqCst) {
        return;
    }
    let Some(win) = app.get_webview_window(LABEL) else {
        return;
    };
    if !centered {
        position(&app, &win);
        return;
    }
    if let Some((mx, my, mw, mh)) =
        stream_monitor_rect(&app).or_else(|| main_monitor_rect(&app))
    {
        let _ = win.set_position(PhysicalPosition::new(mx, my));
        let _ = win.set_size(tauri::PhysicalSize::new(mw as u32, mh as u32));
        set_rect(&MENU_RECT, &MENU_RECT_VALID, mx, my, mw, mh);
    }
}
