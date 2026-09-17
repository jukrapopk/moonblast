import { invoke } from "@tauri-apps/api/core";

/**
 * Tracks whether the user is in "LRUD mode" — navigating with the
 * keyboard or gamepad instead of the mouse. Single boolean state
 * driven by two transitions:
 *
 *   enter  → keydown OR gamepad edge (button press / axis edge)
 *   exit   → mousemove (real mouse movement)
 *
 * Click and `mousedown` deliberately do NOT exit: clicks must
 * register reliably even while LRUD is on (e.g. mouse-hover focus
 * styling puts focus on a button, then the user clicks it). When
 * the user actually moves the mouse afterwards, that single
 * mousemove cleanly exits.
 *
 * Why this is solid:
 *   - One source of truth (`data-lrud` on <html>).
 *   - One enter path (`enterLrudMode`) and one exit path
 *     (`exitLrudMode`), both idempotent.
 *   - The gamepad path fires `enterLrudMode` only on real input
 *     edges (button down, axis threshold cross), not every poll
 *     frame. The previous "refresh every connected-pad frame"
 *     approach caused cursor flicker because mousemove could exit,
 *     then the next frame would re-enter at 60Hz while the pad
 *     was plugged in.
 *
 * Mounted once at the app root from `App.tsx`.
 */

/**
 * Switch into LRUD mode. Idempotent — calling it repeatedly while
 * already in LRUD mode is a no-op (no extra IPC, no extra DOM
 * mutation). Exported so `useGamepad` can drive LRUD mode from
 * real input edges without going through a fake `keydown`.
 */
export function enterLrudMode(): void {
  if (document.documentElement.hasAttribute("data-lrud")) return;
  document.documentElement.setAttribute("data-lrud", "");
  void invoke("hide_cursor");
}

/**
 * Switch out of LRUD mode. Idempotent. The window-level
 * `mousemove` listener installed by `useLrudMode` covers the
 * common case without needing to call this directly.
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
}
