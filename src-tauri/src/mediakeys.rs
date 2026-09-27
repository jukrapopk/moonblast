//! Hardware volume-key handling for Immersive Mode.
//!
//! Explorer is what normally turns the keyboard's volume keys
//! (`VK_VOLUME_UP` / `VK_VOLUME_DOWN` / `VK_VOLUME_MUTE`) into a master-volume
//! change plus the on-screen flyout: the key becomes an app command that the
//! shell consumes. Immersive Mode kills Explorer (and Auto Immersive never
//! starts it), so those keys go dead — nothing consumes the app command, and
//! the volume doesn't move. This module restores them.
//!
//! **Why hotkeys, not (only) a low-level hook.** The obvious primitive is a
//! `WH_KEYBOARD_LL` hook, and this module used one at first. But Windows
//! silently stops delivering low-level hook events while a Chromium-family
//! window is in the foreground (Chromium registers raw input, which makes the
//! system skip the low-level hook chain — documented on Win10/11 and easily
//! reproduced with WebView2/CEF/Electron). Moonblast's own UI *is* a WebView2
//! window, so the hook went deaf exactly when the launcher was focused and
//! worked only when some *other* window was. `RegisterHotKey` is matched by
//! the input system independently of the hook chain, so it fires regardless of
//! which window has focus. Hotkeys are therefore the primary mechanism; the
//! low-level hook is kept only as a fallback for the rare case where the
//! volume keys are already claimed as another app's hotkey.
//!
//! Either way the work happens on a dedicated thread that owns a Win32 message
//! loop (required for both `WH_KEYBOARD_LL` callbacks and `WM_HOTKEY` posts
//! from `RegisterHotKey(NULL, …)`), and applies the change through `audio.rs`
//! and `osd.rs`.

use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;

use crate::moonblast_log;
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE, PeekMessageW,
    PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL,
    WM_APP, WM_HOTKEY, WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN,
};

const VK_VOLUME_MUTE: u32 = 0xAD;
const VK_VOLUME_DOWN: u32 = 0xAE;
const VK_VOLUME_UP: u32 = 0xAF;

/// Percent per keypress — matches Windows' own step.
const STEP: i32 = 2;

/// Global-hotkey ids (must be 0x0000–0xBFFF). With a null `HWND`,
/// `RegisterHotKey` posts `WM_HOTKEY` to the calling thread's queue.
const HK_VOLUME_MUTE: i32 = 0x2001;
const HK_VOLUME_DOWN: i32 = 0x2002;
const HK_VOLUME_UP: i32 = 0x2003;

/// Fallback path only: `wParam` carries the virtual key that was pressed.
const WM_APP_VOLUME: u32 = WM_APP + 1;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static HOOK: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
/// True while the low-level-hook fallback (not the hotkeys) is what's armed.
static USING_HOOK: AtomicBool = AtomicBool::new(false);
/// The `AppHandle` used to drive the OSD overlay (see `osd::show_level`).
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

/// Store the app handle. Called once from `setup`.
pub fn init(app: AppHandle) {
    if let Ok(mut g) = APP.lock() {
        *g = Some(app);
    }
}

/// Start or stop the volume-key handler. Idempotent — `suppress_shell` calls
/// this on every Immersive enter/exit, and Auto Immersive fires the "enter"
/// path twice at boot.
pub fn set_active(active: bool) {
    if active {
        if ACTIVE.swap(true, Ordering::SeqCst) {
            return; // already running
        }
        STOP.store(false, Ordering::SeqCst);
        std::thread::spawn(thread_main);
        // Warm up the OSD window now (it's only needed while the desktop is
        // suppressed) so it's loaded and listening by the first keypress.
        // Created on its own thread because Tauri window creation deadlocks on
        // the main thread on Windows.
        if let Some(app) = APP.lock().ok().and_then(|g| g.clone()) {
            std::thread::spawn(move || crate::osd::ensure_window(&app));
        }
        moonblast_log!("mediakeys: arming");
    } else {
        if !ACTIVE.swap(false, Ordering::SeqCst) {
            return; // wasn't running
        }
        STOP.store(true, Ordering::SeqCst);
        // Posting WM_QUIT is enough to unwind the message loop; we deliberately
        // don't join, because `set_active(false)` can run on the main thread
        // (e.g. `close_app`) while the handler thread is mid-`emit`, which could
        // otherwise deadlock on Tauri's dispatch.
        let tid = HOOK_THREAD_ID.swap(0, Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                PostThreadMessageW(tid, WM_QUIT, 0, 0);
            }
        }
        moonblast_log!("mediakeys: disarming");
    }
}

fn thread_main() {
    unsafe {
        // Both mechanisms need a message queue on this thread: a low-level hook
        // is delivered to the installing thread's queue, and `RegisterHotKey`
        // with a null HWND posts `WM_HOTKEY` there.
        let mut msg: MSG = std::mem::zeroed();
        PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        HOOK_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
        if STOP.load(Ordering::SeqCst) {
            return; // stopped between spawn and install
        }

        // Preferred path: system-wide hotkeys, which keep firing while
        // Moonblast's own Chromium window (or any other WebView2/CEF window)
        // is focused — unlike the low-level hook.
        if register_hotkeys() {
            moonblast_log!("mediakeys: volume hotkeys registered");
        } else {
            // The keys are already someone else's hotkey. Fall back to the hook,
            // which still covers every non-Chromium window.
            let hmod = GetModuleHandleW(std::ptr::null());
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), hmod, 0);
            if hook.is_null() {
                moonblast_log!("mediakeys: hotkeys and hook both unavailable; keys will be dead");
            } else {
                HOOK.store(hook, Ordering::SeqCst);
                USING_HOOK.store(true, Ordering::SeqCst);
                moonblast_log!("mediakeys: hotkeys taken; using WH_KEYBOARD_LL fallback");
            }
        }

        loop {
            let r = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
            if r <= 0 {
                break; // WM_QUIT (0) or error (-1)
            }
            if msg.message == WM_HOTKEY {
                if let Some(vk) = vk_for_hotkey(msg.wParam as i32) {
                    apply_volume_key(vk);
                }
            } else if msg.message == WM_APP_VOLUME {
                apply_volume_key(msg.wParam as u32);
            } else {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        unregister_hotkeys();
        let hook = HOOK.swap(std::ptr::null_mut(), Ordering::SeqCst);
        if !hook.is_null() {
            UnhookWindowsHookEx(hook);
        }
        USING_HOOK.store(false, Ordering::SeqCst);
        moonblast_log!("mediakeys: disarmed");
    }
}

/// Register the three volume hotkeys on this thread. All-or-nothing: a partial
/// success is rolled back so the hook fallback (or nothing) is unambiguous.
fn register_hotkeys() -> bool {
    for (id, vk) in [
        (HK_VOLUME_MUTE, VK_VOLUME_MUTE),
        (HK_VOLUME_DOWN, VK_VOLUME_DOWN),
        (HK_VOLUME_UP, VK_VOLUME_UP),
    ] {
        let ok = unsafe { RegisterHotKey(std::ptr::null_mut(), id, 0, vk) };
        if ok == 0 {
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            moonblast_log!("mediakeys: RegisterHotKey(vk=0x{vk:02X}) failed (err={err})");
            unregister_hotkeys();
            return false;
        }
    }
    true
}

fn unregister_hotkeys() {
    for id in [HK_VOLUME_MUTE, HK_VOLUME_DOWN, HK_VOLUME_UP] {
        unsafe {
            UnregisterHotKey(std::ptr::null_mut(), id);
        }
    }
}

fn vk_for_hotkey(id: i32) -> Option<u32> {
    match id {
        HK_VOLUME_UP => Some(VK_VOLUME_UP),
        HK_VOLUME_DOWN => Some(VK_VOLUME_DOWN),
        HK_VOLUME_MUTE => Some(VK_VOLUME_MUTE),
        _ => None,
    }
}

/// Low-level-hook fallback callback. Does no work — posts to the handler thread
/// and returns immediately, because a slow hook stalls all keyboard input.
unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && (wparam as u32 == WM_KEYDOWN || wparam as u32 == WM_SYSKEYDOWN) {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
        let vk = kb.vkCode;
        if vk == VK_VOLUME_UP || vk == VK_VOLUME_DOWN || vk == VK_VOLUME_MUTE {
            let tid = HOOK_THREAD_ID.load(Ordering::SeqCst);
            if tid != 0 {
                PostThreadMessageW(tid, WM_APP_VOLUME, vk as WPARAM, 0);
            }
            // Swallow it so a keyboard utility's own handling can't double-apply.
            return 1;
        }
    }
    CallNextHookEx(HOOK.load(Ordering::SeqCst), code, wparam, lparam)
}

/// Runs on the handler thread's message loop (never inside the hook callback),
/// so the COM write is free to take its time.
fn apply_volume_key(vk: u32) {
    let current = match crate::audio::master() {
        Ok(m) => m,
        Err(e) => {
            moonblast_log!("mediakeys: master read failed: {e}");
            return;
        }
    };
    let (volume, muted, result) = match vk {
        VK_VOLUME_UP => {
            let v = (current.volume as i32 + STEP).min(100) as u8;
            (v, false, crate::audio::set_master_volume(v))
        }
        VK_VOLUME_DOWN => {
            let v = (current.volume as i32 - STEP).max(0) as u8;
            (v, false, crate::audio::set_master_volume(v))
        }
        VK_VOLUME_MUTE => {
            let m = !current.muted;
            (current.volume, m, crate::audio::set_master_mute(m))
        }
        _ => return,
    };
    if let Err(e) = result {
        moonblast_log!("mediakeys: apply failed: {e}");
        return;
    }
    // Windows clears mute when the level is adjusted with the volume keys.
    if vk != VK_VOLUME_MUTE && current.muted {
        let _ = crate::audio::set_master_mute(false);
    }
    let app = APP.lock().ok().and_then(|g| g.clone());
    if let Some(app) = app {
        crate::osd::show_level(&app, volume, muted);
    }
}
