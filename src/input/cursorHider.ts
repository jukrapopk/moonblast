/**
 * Hide-and-restore the OS cursor when the user starts driving the UI
 * via keyboard or gamepad. Big-Picture-style — once you commit to a
 * controller, the mouse pointer gets out of the way until you move
 * the mouse again.
 *
 * Behaviour
 * ---------
 * - `hideCursor()` sets `data-cursor-hidden` on `<body>`. CSS in
 *   `styles.css` reads this attribute and applies `cursor: none` to
 *   every element (with `!important` so existing `cursor-pointer`
 *   per-component overrides don't survive). Sticky — repeated calls
 *   while already hidden are a no-op.
 * - The first `mousemove` after `hideCursor()` clears the attribute
 *   and detaches its own mousemove listener. The cursor returns
 *   instantly; subsequent movements are ignored until the next hide.
 *
 * Trigger sites (callers of `hideCursor()`):
 *   - `useSpatialController.onKey` — fires on the leading-edge of a
 *     real keyboard arrow, AND on the synthesised keydown dispatched
 *     by `gamepadAdapter.sendKey` (which is the entire gamepad arrow
 *     path). Single source of truth: both real and gamepad arrows
 *     funnel through this controller before they move focus.
 *
 * Auto-fire (held-arrow cadence in `arrowAutoFire.tick`) flows
 * through the same `onKey` handler so it re-asserts `hideCursor()`
 * while the user holds the stick. That's a no-op while already
 * hidden — the attribute is sticky — but it's worth noting that we
 * don't gate the call on `e.repeat` purely for cursor purposes.
 * `useSpatialController` already gates the *focus* move on
 * `e.repeat`, but the cursor-hide call sits above that gate so the
 * very first hide happens on the leading edge. (Keyboard's
 * `e.repeat` keydowns DO still reach `onKey` and DO still call
 * `hideCursor()` — idempotent, fine.)
 */

let hidden = false;
let restoreListener: (() => void) | null = null;

/**
 * Apply the hidden-cursor visual state. Idempotent — calling this
 * while already hidden is a cheap attribute check with no side
 * effects beyond the listener being already in place.
 */
export function hideCursor(): void {
  if (typeof document === "undefined") return;
  if (hidden) return;
  hidden = true;
  document.body.setAttribute("data-cursor-hidden", "");
  // Attach the first-mousemove-restore hook exactly once per hide.
  // We bind on `window` (not `document`) because `window` is the
  // canonical target for mouse-move events that originate from the
  // OS event pump; `document` would also work but `window` matches
  // the existing keyboard-listener convention used in
  // `useSpatialController`.
  window.addEventListener("mousemove", onRestoreMove, { passive: true });
  restoreListener = () => {
    window.removeEventListener("mousemove", onRestoreMove);
  };
}

function onRestoreMove(): void {
  if (!hidden) return;
  hidden = false;
  document.body.removeAttribute("data-cursor-hidden");
  if (restoreListener) {
    restoreListener();
    restoreListener = null;
  }
}
