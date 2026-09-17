/**
 * Hide-and-restore the OS cursor when the user starts driving the UI
 * via keyboard or gamepad. Big-Picture-style — once you commit to a
 * controller, the mouse pointer gets out of the way until you move
 * the mouse again.
 *
 * Behaviour
 * ---------
 * - `hideCursor()` sets `data-cursor-hidden` on <body>. CSS in
 *   `styles.css` reads this attribute and applies `cursor: none` to
 *   every element (with `!important` so existing `cursor-pointer`
 *   per-component overrides don't survive). Sticky — repeated calls
 *   while already hidden are a no-op.
 * - Restore signals — any of:
 *     1. `pointerdown` with `isTrusted: true` — a real mouse / touch
 *        / pen button press. Pointer events only fire for actual
 *        pointer input; the browser does NOT fire pointerdown for
 *        keyboard activation of a focused button, and JS-dispatched
 *        events have `isTrusted: false`. So this single check
 *        filters out every false-positive path: the `mousedown` /
 *        `mouseup` / `click` that `target.click()` synthesises from
 *        `gamepadAdapter.sendKey("Enter")`, AND the `mousedown` /
 *        `mouseup` / `click` that the browser fires natively when
 *        the user presses Enter or Space on a focused button via
 *        the real keyboard.
 *     2. `pointermove` with `isTrusted: true` whose coords differ
 *        by at least 1 pixel in either axis from the last known
 *        cursor position. A zero-delta move records the new
 *        position but does NOT restore — this filters out the
 *        spurious pointermove that WebView2 fires when the window
 *        transitions into / out of fullscreen (the OS keeps the
 *        cursor at its current screen position but reports the
 *        same WebView-relative coords, so the delta to the
 *        previous sample is 0).
 *
 *   The first `pointermove` after a hide has no "previous position"
 *   in this module (we wipe the reference on hide), so it's stored
 *   and treated as a baseline — only the second move with a
 *   non-zero delta restores. That's a one-move-of-jitter delay, but
 *   it makes the hide-stick behaviour robust against the F11
 *   transition emitting a single re-confirmation pointermove at
 *   the cursor's current position before the user touches it.
 *
 * Why pointer events rather than mouse events
 * -------------------------------------------
 * Mouse events (`mousedown`, `mousemove`) fire for more scenarios
 * than pointer events: in particular, pressing Enter or Space on a
 * focused `<button>` causes the browser to fire a trusted
 * `mousedown`/`mouseup`/`click` triplet as part of its keyboard
 * activation pipeline. Listening to `mousedown` therefore restored
 * the cursor even when the user was still driving with the
 * keyboard — the exact bug this module exists to avoid. Pointer
 * events bypass that: they're only dispatched for actual pointer
 * input, so keyboard activation of a focused button is silent on
 * the pointer event side. This is the right event type for
 * distinguishing "real pointer input" from "any chain of
 * synthesised / activation-driven events".
 *
 * Trigger sites (callers of `hideCursor()`):
 *   - `useSpatialController.onKey` — fires on the leading edge of a
 *     real keyboard arrow, AND on the synthesised keydown dispatched
 *     by `gamepadAdapter.sendKey` (the entire gamepad arrow path).
 *     Single source of truth: both real and gamepad arrows funnel
 *     through this controller before they move focus.
 *
 * Auto-fire (held-arrow cadence in `arrowAutoFire.tick`) flows
 * through the same `onKey` handler so it re-asserts `hideCursor()`
 * while the user holds the stick. That's a no-op while already
 * hidden — the attribute is sticky.
 */

let hidden = false;
let lastX: number | null = null;
let lastY: number | null = null;
let detachListeners: (() => void) | null = null;

/**
 * Apply the hidden-cursor visual state. Idempotent — calling this
 * while already hidden is a cheap attribute check with no side
 * effects beyond the listeners being already in place.
 */
export function hideCursor(): void {
  if (typeof document === "undefined") return;
  if (hidden) return;
  hidden = true;
  document.body.setAttribute("data-cursor-hidden", "");
  // Reset the last-known cursor position so the first pointermove
  // after a hide becomes a baseline rather than being compared
  // against a stale position from before the keyboard / gamepad
  // session. (Without this, a user who pushed arrows for a minute
  // and then nudged the mouse could see delta = 0 because we'd be
  // comparing to a pre-hide sample; here we force a clean slate.)
  lastX = null;
  lastY = null;
  // Bind on `window` to match the keyboard-listener convention used
  // in `useSpatialController`. `pointerdown` and `pointermove` both
  // bubble to `window`, so a single pair of listeners covers every
  // case. `passive: true` lets the browser skip waiting for our
  // handler before scrolling / painting — we never call
  // `preventDefault` here.
  window.addEventListener("pointermove", onRestoreMove, { passive: true });
  window.addEventListener("pointerdown", onRestoreClick, { passive: true });
  detachListeners = () => {
    window.removeEventListener("pointermove", onRestoreMove);
    window.removeEventListener("pointerdown", onRestoreClick);
  };
}

function onRestoreMove(e: PointerEvent): void {
  if (!hidden) return;
  // `isTrusted` is `true` only for events the browser itself
  // dispatched in response to OS pointer input. JS-dispatched
  // events have `isTrusted: false`. Filtering here is defence in
  // depth — pointer events are already trusted-only in practice,
  // but if a future code path ever synthesises one, we don't want
  // it to restore the cursor.
  if (!e.isTrusted) return;
  const x = e.clientX;
  const y = e.clientY;
  if (lastX === null || lastY === null) {
    // First sample after a hide — record as baseline, don't
    // restore. Lets WebView2's fullscreen-transition pointermove
    // (which lands at the cursor's current position with no prior
    // reference) be absorbed silently.
    lastX = x;
    lastY = y;
    return;
  }
  if (Math.abs(x - lastX) < 1 && Math.abs(y - lastY) < 1) {
    // Zero-delta move (synthetic re-emit from a window state
    // change, OS cursor parked at a fixed position, etc.) —
    // record the new position but don't restore. Real user
    // motion produces sub-pixel jitter at minimum, so this is a
    // safe lower bound.
    lastX = x;
    lastY = y;
    return;
  }
  lastX = x;
  lastY = y;
  restore();
}

function onRestoreClick(e: PointerEvent): void {
  if (!hidden) return;
  // Pointer events only fire for actual pointer input. The browser
  // does NOT fire pointerdown for keyboard activation of a focused
  // button — that path emits a `keydown` plus a trusted `mousedown`
  // / `mouseup` / `click` triplet but never a pointerdown. JS
  // dispatch has `isTrusted: false`. So a simple trusted check is
  // sufficient here: any pointerdown that reaches us is, by
  // construction, a real user click on the surface.
  if (!e.isTrusted) return;
  restore();
}

function restore(): void {
  hidden = false;
  document.body.removeAttribute("data-cursor-hidden");
  if (detachListeners) {
    detachListeners();
    detachListeners = null;
  }
}
