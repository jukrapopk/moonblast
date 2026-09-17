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
 * Re-arm LRUD mode while the gamepad poller is active. Throttled
 * to 750 ms so wiggling the mouse while a controller is connected
 * doesn't create a hide/show cycle: `exitLrudMode` fires from the
 * window mousemove listener, and without throttling the next gamepad
 * poll frame would immediately call `enterLrudMode` again, hiding
 * the cursor at ~60Hz and breaking click registration. With the
 * throttle, once the user moves the mouse the cursor stays visible
 * for at least 750 ms; if the gamepad is still active after that
 * window (e.g. they nudged the mouse but kept holding the stick),
 * LRUD mode re-engages.
 */
let lastEnterAt = 0;
export function refreshLrudMode(): void {
  const t = performance.now();
  if (t - lastEnterAt < 750) return;
  lastEnterAt = t;
  if (document.documentElement.hasAttribute("data-lrud")) {
    // Already on but we got here (debounce expired); re-issue
    // hide_cursor in case the cursor was re-shown by something
    // external (e.g. focus change / alt-tab).
    void invoke("hide_cursor");
  } else {
    enterLrudMode();
  }
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
  // Reset the refresh throttle so a subsequent `refreshLrudMode`
  // call (e.g. from the gamepad poller) has to wait the full 750 ms
  // before re-entering. This is what makes "user moves mouse → cursor
  // visible → no flicker" actually work: even if the gamepad poller
  // fires on the very next animation frame, it's throttled out.
  lastEnterAt = performance.now();
  void invoke("show_cursor");
}

export function useLrudMode() {
  if (typeof document === "undefined") return;
  window.addEventListener("keydown", enterLrudMode);
  window.addEventListener("mousemove", exitLrudMode);
  window.addEventListener("mousedown", exitLrudMode);
}
