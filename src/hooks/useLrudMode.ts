import { invoke } from "@tauri-apps/api/core";

/**
 * Tracks whether the user is in "LRUD mode" (navigating with the
 * keyboard or gamepad). While in LRUD mode:
 *   - `data-lrud` is set on <html> so CSS can suppress hover styles
 *     and disable pointer events (see styles.css).
 *   - The OS-level cursor is hidden via the `hide_cursor` Rust
 *     command, which calls `SetCursor(NULL)` to remove it from the
 *     current thread. CSS `cursor: none` alone doesn't hide the
 *     cursor on Windows because the OS still draws it over the
 *     WebView2 surface.
 *
 * Switching:
 *   - Any `keydown` (handled here) → enter LRUD mode.
 *   - Gamepad button / axis press (handled in `useGamepad`) → enter
 *     LRUD mode via `enterLrudMode()`.
 *   - Any `mousemove` or `mousedown` (handled here) → leave LRUD
 *     mode. Gamepad-exit is implicit: as soon as the user moves the
 *     mouse, the same listeners fire.
 *
 * Mounted once at the app root from `App.tsx`.
 */

/**
 * Switch into LRUD mode. Idempotent — calling it repeatedly while
 * already in LRUD mode is a no-op (no extra IPC, no extra DOM
 * mutation). Exported so `useGamepad` can drive LRUD mode from
 * button / axis edges without going through a fake `keydown`.
 */
export function enterLrudMode(): void {
  if (document.documentElement.hasAttribute("data-lrud")) return;
  document.documentElement.setAttribute("data-lrud", "");
  void invoke("hide_cursor");
}

/**
 * Switch out of LRUD mode. Idempotent. Exported for symmetry and
 * for tests, but the window-level mouse listeners installed by
 * `useLrudMode` cover the common case without needing to call
 * this directly.
 */
export function exitLrudMode(): void {
  if (!document.documentElement.hasAttribute("data-lrud")) return;
  document.documentElement.removeAttribute("data-lrud");
  void invoke("show_cursor");
}

export function useLrudMode() {
  if (typeof document === "undefined") return;
  window.addEventListener("keydown", enterLrudMode);
  window.addEventListener("mousemove", exitLrudMode);
  window.addEventListener("mousedown", exitLrudMode);
}
