import { invoke } from "@tauri-apps/api/core";

/**
 * Tracks whether the user is in "LRUD mode" (navigating with the
 * keyboard). While in LRUD mode:
 *   - `data-lrud` is set on <html> so CSS can suppress hover styles
 *     and disable pointer events (see styles.css).
 *   - The OS-level cursor is hidden via the `hide_cursor` Rust
 *     command, which calls `SetCursor(NULL)` to remove it from the
 *     current thread. CSS `cursor: none` alone doesn't hide the
 *     cursor on Windows because the OS still draws it over the
 *     WebView2 surface.
 *
 * Switching:
 *   - Any `keydown` → enter LRUD mode (hide cursor, suppress
 *     hover).
 *   - Any `mousemove` or `mousedown` → leave LRUD mode (restore
 *     the cursor, re-enable hover).
 *
 * Mounted once at the app root from `App.tsx`.
 */
export function useLrudMode() {
  if (typeof document === "undefined") return;
  const on = () => {
    document.documentElement.setAttribute("data-lrud", "");
    void invoke("hide_cursor");
  };
  const off = () => {
    if (!document.documentElement.hasAttribute("data-lrud")) return;
    document.documentElement.removeAttribute("data-lrud");
    void invoke("show_cursor");
  };
  window.addEventListener("keydown", on);
  window.addEventListener("mousemove", off);
  window.addEventListener("mousedown", off);
}