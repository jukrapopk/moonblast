//! Show / hide the OS-level cursor for the main window.
//!
//! Why Rust, not CSS: the cursor rendered over a Tauri/WebView2 window
//! is drawn by Windows itself based on the window class cursor. CSS
//! `cursor: none` works on the web content layer, but if the OS cursor
//! is still drawn over the WebView2 surface, the user sees it. Calling
//! `SetCursor(LoadCursorW(NULL, IDC_NONE))` swaps the window class
//! cursor to the "no cursor" one for the entire window, so nothing is
//! drawn while the user is in LRUD (keyboard) mode.
//!
//! `SetCursor` only affects the current thread's cursor — Tauri runs
//! the webview on the main thread so the call here is sufficient.

#[cfg(windows)]
#[tauri::command]
pub fn set_cursor_visible(visible: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{LoadCursorW, SetCursor, IDC_ARROW};
    unsafe {
        // To hide the cursor, `SetCursor(NULL)` removes the cursor
        // from the current thread entirely — Windows draws nothing.
        // To restore, load the standard arrow and re-attach it. The
        // returned HCURSOR is a shared system resource — we don't
        // free it; the next SetCursor replaces it.
        let h = if visible {
            LoadCursorW(std::ptr::null_mut(), IDC_ARROW)
        } else {
            std::ptr::null_mut()
        };
        let _ = SetCursor(h);
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn set_cursor_visible(_visible: bool) {
    // No-op on non-Windows; the JS-side data-lrud styling still
    // handles the visual cues.
}