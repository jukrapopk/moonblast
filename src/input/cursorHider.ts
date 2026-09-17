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
 *     1. `mousedown` (any button) with `isTrusted: true` —
 *        definitive "I'm using the mouse". The `isTrusted` check
 *        filters out the mousedown that `target.click()` synthesises
 *        from `gamepadAdapter.sendKey("Enter")` — without it, every
 *        gamepad A-button press on a focused button would restore
 *        the cursor via `.click()` → `mousedown` → our listener.
 *     2. `mousemove` with `isTrusted: true` whose coords differ
 *        by at least 1 pixel in either axis from the last known
 *        cursor position. A zero-delta move records the new
 *        position but does NOT restore — this filters out the
 *        spurious `mousemove` that WebView2 fires when the window
 *        transitions into / out of fullscreen (the OS keeps the
 *        cursor at its current screen position but reports the
 *        same WebView-relative coords, so the delta to the
 *        previous sample is 0).
 *
 *   The first `mousemove` after a hide has no "previous position"
 *   in this module (we wipe the reference on hide), so it's stored
 *   and treated as a baseline — only the second move with a
 *   non-zero delta restores. That's a one-move-of-jitter delay, but
 *   it makes the hide-stick behaviour robust against the F11
 *   transition emitting a single re-confirmation `mousemove` at
 *   the cursor's current position before the user touches it.
 *
 *   The first `mousemove` after a hide has no "previous position"
 *   in this module (we wipe the reference on hide), so it's stored
 *   and treated as a baseline — only the second move with a
 *   non-zero delta restores. That's a one-move-of-jitter delay, but
 *   it makes the hide-stick behaviour robust against the F11
 *   transition emitting a single re-confirmation `mousemove` at
 *   the cursor's current position before the user touches it.
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
  // Reset the last-known cursor position so the first `mousemove`
  // after a hide becomes a baseline rather than being compared
  // against a stale position from before the keyboard / gamepad
  // session. (Without this, a user who pushed arrows for a minute
  // and then nudged the mouse could see delta = 0 because we'd be
  // comparing to a pre-hide sample; here we force a clean slate.)
  lastX = null;
  lastY = null;
  // Bind on `window` to match the keyboard-listener convention used
  // in `useSpatialController`. `mousemove` and `mousedown` both
  // bubble to `window`, so a single pair of listeners covers every
  // case. `passive: true` on `mousemove` lets the browser skip
  // waiting for our handler before scrolling / painting — we don't
  // call `preventDefault` here.
  window.addEventListener("mousemove", onRestoreMove, { passive: true });
  window.addEventListener("mousedown", onRestoreClick, { passive: true });
  detachListeners = () => {
    window.removeEventListener("mousemove", onRestoreMove);
    window.removeEventListener("mousedown", onRestoreClick);
  };
}

function onRestoreMove(e: MouseEvent): void {
  if (!hidden) return;
  // `isTrusted` is `true` only for events the browser itself
  // dispatched in response to OS input. JS-dispatched events
  // (including any from our own gamepad adapter, though it
  // currently doesn't synthesise mousemoves) are `false`. Filtering
  // here is a defence-in-depth measure: if a future code path
  // ever does `target.dispatchEvent(new MouseEvent("mousemove"))`,
  // the cursor won't come back from it.
  if (!e.isTrusted) return;
  const x = e.clientX;
  const y = e.clientY;
  if (lastX === null || lastY === null) {
    // First sample after a hide — record as baseline, don't
    // restore. Lets WebView2's fullscreen-transition mousemove
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

function onRestoreClick(e: MouseEvent): void {
  if (!hidden) return;
  // Critical: gamepad A-activation routes through `target.click()`
  // in gamepadAdapter.sendKey. That synthesises a mousedown /
  // mouseup / click sequence with `isTrusted: false`. Without
  // this filter every gamepad button press on a focused button
  // would fire `.click()` → `mousedown` → restore the cursor,
  // making the "hide on gamepad use" state meaningless.
  //
  // Real user clicks (mouse button, touch tap) are `isTrusted:
  // true` because they originate from the browser's input
  // pipeline. Same for Space / Enter activation of a focused
  // <button> — Chromium synthesises that with `isTrusted: true`.
  // Only the explicit `element.click()` path (which we use for
  // gamepad A) marks the event untrusted.
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
