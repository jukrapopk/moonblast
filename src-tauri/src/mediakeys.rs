//! Hardware volume-key handling for Immersive Mode.
//!
//! Explorer is what normally turns the keyboard's volume keys
//! (`VK_VOLUME_UP` / `VK_VOLUME_DOWN` / `VK_VOLUME_MUTE`) into a master-volume
//! change plus the on-screen flyout: the key becomes an app command that the
//! shell consumes. Immersive Mode kills Explorer (and Auto Immersive never
//! starts it), so those keys go dead — nothing consumes the app command, and
//! the volume doesn't move. This module restores them.
//!
//! It installs a low-level keyboard hook (`WH_KEYBOARD_LL`) while the desktop
//! is suppressed, applies the change through `audio.rs`, and asks the
//! always-on-top OSD window (`osd.rs`) to show the new level. The hook is torn
//! down when Immersive Mode exits, so normal desktop use keeps the native
//! Windows flyout.
//!
//! Two deliberate design points:
//! - The hook is installed on a dedicated thread that owns a Win32 message
//!   loop — `WH_KEYBOARD_LL` callbacks are delivered to the installing
//!   thread's queue.
//! - The callback itself does no work: it posts to that thread's queue and
//!   returns immediately, because a slow low-level hook stalls *all* keyboard
//!   input system-wide. The actual Core Audio write happens on the message
//!   loop after the callback has returned.

use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;
use crate::moonblast_log;

use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE,
    PeekMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    WH_KEYBOARD_LL, WM_APP, WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN,
};

const VK_VOLUME_MUTE: u32 = 0xAD;
const VK_VOLUME_DOWN: u32 = 0xAE;
const VK_VOLUME_UP: u32 = 0xAF;

/// Percent per keypress — matches Windows' own step.
const STEP: i32 = 2;

/// Custom thread message: `wParam` carries the virtual key that was pressed.
const WM_APP_VOLUME: u32 = WM_APP + 1;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static HOOK: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
/// The `AppHandle` used to drive the OSD overlay (see `osd::show_level`) and
/// emit `volume-key`. Separate from the hook thread so the call works
/// regardless of which thread owns the state.
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

/// Store the app handle. Called once from `setup`.
pub fn init(app: AppHandle) {
    if let Ok(mut g) = APP.lock() {
        *g = Some(app);
    }
}

/// Start or stop the volume-key hook. Idempotent — `suppress_shell` calls this
/// on every Immersive enter/exit, and Auto Immersive fires the "enter" path
/// twice at boot.
pub fn set_active(active: bool) {
    if active {
        if ACTIVE.swap(true, Ordering::SeqCst) {
            return; // already running
        }
        STOP.store(false, Ordering::SeqCst);
        std::thread::spawn(hook_thread);
        // Warm up the OSD window now (it's only needed while the desktop is
        // suppressed) so it's loaded and listening by the first keypress.
        // Created on its own thread because Tauri window creation deadlocks on
        // the main thread on Windows.
        if let Some(app) = APP.lock().ok().and_then(|g| g.clone()) {
            std::thread::spawn(move || crate::osd::ensure_window(&app));
        }
        moonblast_log!("mediakeys: hook starting");
    } else {
        if !ACTIVE.swap(false, Ordering::SeqCst) {
            return; // wasn't running
        }
        STOP.store(true, Ordering::SeqCst);
        // Posting WM_QUIT is enough to unwind the message loop; we deliberately
        // don't join, because `set_active(false)` can run on the main thread
        // (e.g. `close_app`) while the hook thread is mid-`emit`, which could
        // otherwise deadlock on Tauri's dispatch.
        let tid = HOOK_THREAD_ID.swap(0, Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                PostThreadMessageW(tid, WM_QUIT, 0, 0);
            }
        }
        moonblast_log!("mediakeys: hook stopping");
    }
}

fn hook_thread() {
    unsafe {
        // A low-level hook is delivered to the installing thread's message
        // queue, so force the queue to exist before anything can post to it.
        let mut msg: MSG = std::mem::zeroed();
        PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        HOOK_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
        if STOP.load(Ordering::SeqCst) {
            return; // stopped between spawn and install
        }
        let hmod = GetModuleHandleW(std::ptr::null());
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), hmod, 0);
        if hook.is_null() {
            moonblast_log!("mediakeys: SetWindowsHookExW failed");
            return;
        }
        HOOK.store(hook, Ordering::SeqCst);
        loop {
            let r = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
            if r <= 0 {
                break; // WM_QUIT (0) or error (-1)
            }
            if msg.message == WM_APP_VOLUME {
                apply_volume_key(msg.wParam as u32);
            } else {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        UnhookWindowsHookEx(hook);
        HOOK.store(std::ptr::null_mut(), Ordering::SeqCst);
        moonblast_log!("mediakeys: hook stopped");
    }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && (wparam as u32 == WM_KEYDOWN || wparam as u32 == WM_SYSKEYDOWN) {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
        let vk = kb.vkCode;
        if vk == VK_VOLUME_UP || vk == VK_VOLUME_DOWN || vk == VK_VOLUME_MUTE {
            let tid = HOOK_THREAD_ID.load(Ordering::SeqCst);
            if tid != 0 {
                PostThreadMessageW(tid, WM_APP_VOLUME, vk as WPARAM, 0);
            }
            // Swallow it: with no shell, nobody else can act on it, and
            // swallowing keeps a keyboard utility's own handling from
            // double-applying.
            return 1;
        }
    }
    CallNextHookEx(HOOK.load(Ordering::SeqCst), code, wparam, lparam)
}

/// Runs on the hook thread's message loop (never inside the hook callback), so
/// the COM write is free to take its time.
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
