//! Hide the OS-level cursor while the user is in LRUD (keyboard)
//! mode. CSS `cursor: none` only affects the web content layer —
//! the OS still draws the cursor on top of the WebView2 surface.
//! `SetCursor(NULL)` removes the cursor from this thread so
//! Windows draws nothing.

#[cfg(windows)]
#[tauri::command]
pub fn hide_cursor() {
    use windows_sys::Win32::UI::WindowsAndMessaging::SetCursor;
    unsafe {
        let _ = SetCursor(std::ptr::null_mut());
    }
}

#[cfg(windows)]
#[tauri::command]
pub fn show_cursor() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{LoadCursorW, SetCursor, IDC_ARROW};
    unsafe {
        let h = LoadCursorW(std::ptr::null_mut(), IDC_ARROW);
        let _ = SetCursor(h);
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn hide_cursor() {}

#[cfg(not(windows))]
#[tauri::command]
pub fn show_cursor() {}