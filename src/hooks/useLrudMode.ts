import { invoke } from "@tauri-apps/api/core";

/**
 * Tracks whether the user is in "LRUD mode" (navigating with the
 * keyboard). While in LRUD mode:
 *   - `data-lrud` is set on <html> so CSS can suppress hover styles
 *     and disable pointer events (see styles.css).
 *   - The OS-level cursor is hidden via a Tauri command that calls
 *     `SetCursor(LoadCursorW(NULL, IDC_NONE))` on the window's
 *     thread. CSS alone won't hide the cursor on Windows because
 *     the OS still draws it over the WebView2 surface.
 *
 * Switching:
 *   - Any `keydown` → enter LRUD mode (cursor hidden, hover
 *     suppressed).
 *   - Any `mousemove` or `mousedown` → leave LRUD mode (cursor
 *     restored, hover re-enabled).
 *
 * Mounted once at the app root from `App.tsx`.
 */
export function useLrudMode() {
  if (typeof document === "undefined") return;
  const on = () => {
    document.documentElement.setAttribute("data-lrud", "");
    void invoke("set_cursor_visible", { visible: false });
  };
  const off = () => {
    document.documentElement.removeAttribute("data-lrud");
    void invoke("set_cursor_visible", { visible: true });
  };
  window.addEventListener("keydown", on);
  window.addEventListener("mousemove", off);
  window.addEventListener("mousedown", off);
}