/**
 * Gamepad adapter — translates a standard gamepad's D-pad, action
 * buttons (A/B/X), and sticks into synthetic events dispatched on
 * the focused element. The existing window-level keyboard listener
 * (see `useSpatialController.ts`) handles the keyboard-shaped ones
 * (arrows, Enter, Escape) via the same code path as a real key press.
 * Right-stick scrolls via synthetic `wheel` events, which any scroll
 * container picks up automatically — modals close on B (Esc), buttons
 * activate on A (Enter), arrows navigate, X opens the active
 * element's context menu, the right stick scrolls.
 *
 * Why this is a "remap" instead of a controller-aware pipeline
 * --------------------------------------------------------------
 * The shell already has working keyboard handling: LIFO escape / enter
 * stacks, spatial nav, Tab wrap, F11 shortcut, prompt submit, password
 * form submit, volume step, etc. Gamepad events become synthetic key
 * events, which means every existing handler sees them automatically —
 * no per-component refactor, no router, no intent registry.
 *
 * Mapping
 * -------
 *   D-pad / left stick          → ArrowUp / ArrowDown / ArrowLeft / ArrowRight
 *   A (button 0, south)         → Enter
 *   B (button 1, east)          → Escape
 *   X (button 2, west)          → contextmenu (synthesised on focused element)
 *   Right stick                 → vertical / horizontal scroll (synthetic wheel event)
 *
 * Edge-detected buttons, so an idle controller never repeats. rAF
 * pauses naturally on `document.hidden` — no manual tick scheduling.
 *
 * What's deliberately out of scope
 * --------------------------------
 *   - Right-stick pointer emulation (mouse mode).
 *   - Force-feedback / rumble (WebView2 doesn't expose it).
 *   - Mapping customization or remap UI. Xbox / standard mapping is
 *     what every controller reports via the Gamepad API.
 *   - Triggers (L2/R2) and bumpers (L1/R1). Hover future work.
 */
import { useEffect } from "react";
import { useSpatialControllerInternals } from "./controllerInternals";

/* ---------------------------------------------------------------------------
 *  Mapping constants.
 *  -------------------------------------------------------------------------*/

const PRIMARY_BUTTON = 0; // A on Xbox, × on PlayStation, B on Switch (south)
const CANCEL_BUTTON = 1;  // B on Xbox, ○ on PlayStation, A on Switch (east)
// Context-menu gesture was Y (button 3); user requested X (button 2)
// which is `west` on a standard mapping. Adjust here only.
const MENU_BUTTON = 2;    // X on Xbox, □ on PlayStation, Y on Switch (west)

const STICK_DEAD_ZONE = 0.5;

// Right stick on the standard mapping (Chrome / Firefox / WebView2):
// axes[2] = X, axes[3] = Y. We don't read axes[0]/[1] (left stick).
const RIGHT_STICK_X = 2;
const RIGHT_STICK_Y = 3;

/**
 * Pixels per unit of stick deflection. The synthetic `wheel` event's
 * `deltaY` / `deltaX` are interpreted by the page in pixels
 * (`deltaMode: "pixel"`). We multiply stick magnitude (0..1) by this
 * factor so a full-tilt push scrolls ~120px — Chromium's default
 * line-height-ish amount. Tweak if it feels too fast / sluggish.
 */
const SCROLL_PIXELS_PER_UNIT = 120;

/* ---------------------------------------------------------------------------
 *  Direction helper.
 *  -------------------------------------------------------------------------*/

type Dir = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/**
 * Pick a single dominant direction from a 2-axis analog input, or
 * `null` if both axes are within the dead-zone. Two-axis sticks always
 * commit to the stronger axis so a diagonal lean doesn't fire two
 * directions back-to-back.
 */
function dominant(x: number, y: number, dead: number): Dir | null {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax < dead && ay < dead) return null;
  if (ax >= ay) return x < 0 ? "ArrowLeft" : "ArrowRight";
  return y < 0 ? "ArrowUp" : "ArrowDown";
}

/**
 * Read the right stick and return its dominant axis (or `null`
 * inside the dead-zone) plus the signed magnitude on that axis.
 * Magnitude is the raw 0..1 deflection (so full-tilt = 1.0).
 */
function readRightStick(pad: Gamepad): { axis: RightStickAxis; magnitude: number } {
  const x = pad.axes[RIGHT_STICK_X] ?? 0;
  const y = pad.axes[RIGHT_STICK_Y] ?? 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax < STICK_DEAD_ZONE && ay < STICK_DEAD_ZONE) return { axis: null, magnitude: 0 };
  if (ay >= ax) return { axis: "y", magnitude: y };
  return { axis: "x", magnitude: x };
}

/* ---------------------------------------------------------------------------
 *  Synthetic event dispatch.
 *  -------------------------------------------------------------------------*/

/**
 * Dispatch a synthetic keydown on the currently-focused element.
 *
 * Why the focused element, not `window`
 * --------------------------------------
 * Dispatching on `window` only reaches DOM-level listeners (the
 * controller's `addEventListener("keydown", ...)` for example) but
 * skips React's synthetic event system, because React's synthetic
 * dispatch only fires for events whose `target` was set during a
 * browser-initiated dispatch. A programmatic `dispatchEvent` on
 * `window` registers `window` as the target — none of the React
 * `onKeyDown` props in the focus chain fire. That bug shows up
 * where keyboard `ArrowDown` overrides live on a wrapper `<div>`'s
 * `onKeyDownCapture` (e.g. Moonlight's sub-tab Down-jump) and the
 * synthesised D-pad Down just walks the spatial-nav default into
 * the wrong focusable.
 *
 * Dispatching on the focused element instead puts the event target
 * inside the same React tree as those wrappers, so React's synthetic
 * chain runs identically to a real key press. The window listener
 * still receives the event because DOM events bubble.
 *
 * For Enter on a focusable button / link the synthetic keydown alone
 * doesn't trigger the browser's native click — WebView2 / Chromium
 * reserves that path for OS-originated key events. So when the
 * controller wouldn't intercept Enter itself (no LIFO enter-handler
 * pushed by a modal), we shortcut to `.click()` directly. This
 * mirrors real-key Enter exactly: the controller runs its Enter
 * branch, sees no enter-handler, and the browser auto-clicks; we
 * collapse those two steps into one. The click path is identical
 * whether you arrived via the shortcut or via the browser's native
 * activation, so no double-fire risk.
 */
function sendKey(key: Dir | "Enter" | "Escape"): void {
  if (typeof window === "undefined") return;
  if (key === "Enter") {
    const target = document.activeElement;
    const enterHandler = useSpatialControllerInternals.peekEnter();
    if (
      !enterHandler &&
      target instanceof HTMLElement &&
      target !== document.body &&
      (target.tagName === "BUTTON" || target.tagName === "A" || target.tagName === "SUMMARY")
    ) {
      target.click();
      return;
    }
  }
  const target = document.activeElement ?? document.body;
  // `target.dispatchEvent` triggers DOM listeners on `target` and its
  // ancestors (capture and bubble), including the controller's window
  // listener. When `target === document.body` and there's no React
  // wrapper, the window listener still fires on bubble.
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
}

/**
 * Synthesise a contextmenu event on the focused element, matching the
 * existing Shift+F10 / ContextMenu-key helper in
 * `useSpatialController.ts`. The component-level React `onContextMenu`
 * handler picks it up and opens the menu; the synthetic flag tells
 * the menu to autoFocus its first item (same as keyboard-opened
 * menus).
 */
function sendContextMenu(): void {
  if (typeof window === "undefined") return;
  const target = document.activeElement;
  if (!target || target === document.body || !(target instanceof Element)) return;
  const rect = target.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const ev = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: cx,
    clientY: cy,
    view: window,
  });
  (ev as MouseEvent & { __keyboard?: boolean }).__keyboard = true;
  target.dispatchEvent(ev);
}

/**
 * Scroll the nearest scrollable ancestor of `start` (or the document
 * scrolling element when no ancestor is scrollable). Mirrors the
 * browser's response to a real wheel event, but applied directly via
 * `scrollBy()` so the `isTrusted` gate doesn't drop our non-trusted
 * synthesised `WheelEvent`s — Chromium only auto-scrolls on trusted
 * events, but `scrollBy` is a public DOM API that always works.
 *
 * Walks up from `start` looking for a node whose computed style makes
 * it scrollable along the requested axis. If none is found, falls
 * back to `document.scrollingElement` (the document `<html>` by
 * default, or the body's overflow container if anything else has
 * taken over).
 */
function scrollByNear(start: Element | null, dx: number, dy: number): void {
  if (typeof document === "undefined") return;
  if (dx === 0 && dy === 0) return;
  const target = pickScrollTarget(start);
  if (target) target.scrollBy({ top: dy, left: dx, behavior: "auto" });
}

function pickScrollTarget(start: Element | null): Element | null {
  let cur: Element | null = start;
  while (cur && cur !== document.documentElement) {
    if (isScrollable(cur, "y") || isScrollable(cur, "x")) return cur;
    cur = cur.parentElement;
  }
  // No scrollable ancestor found. Use the document's scrolling
  // element so background scrolling on Apps / Settings pages works
  // even when focus is on a non-scrolling chip.
  return document.scrollingElement ?? document.documentElement;
}

function isScrollable(el: Element, axis: "x" | "y"): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = typeof getComputedStyle === "function"
    ? getComputedStyle(el)
    : null;
  if (!style) return false;
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") {
    const size = axis === "y"
      ? el.scrollHeight - el.clientHeight
      : el.scrollWidth - el.clientWidth;
    return size > 0;
  }
  return false;
}

/* ---------------------------------------------------------------------------
 *  Edge-detection state.
 *  -------------------------------------------------------------------------*/

/**
 * Right-stick tracking shape. We don't store the raw X/Y each
 * frame (that would imply continuous scroll while held — see
 * below); instead we store the *dominant axis* of the previous
 * frame so we can edge-detect a fresh push out of the dead-zone.
 * `null` means "inside the dead-zone" (no scroll triggered last
 * frame); `"x"` / `"y"` means "pushed along this axis last
 * frame" (next non-zero tick in the same axis is a repeat, which
 * we currently don't auto-fire).
 */
type RightStickAxis = "x" | "y" | null;

interface State {
  primary: boolean;
  cancel: boolean;
  menu: boolean;
  /** Last stick + dpad direction we dispatched. Tracked so we only
   *  dispatch on edge (push -> fires once; release -> no-op). */
  stick: Dir | null;
  dpad: Dir | null;
  /** Dominant axis of last frame's right-stick deflection. */
  rightAxis: RightStickAxis;
  /** Last wheel delta we dispatched (after magnitude scaling).
   *  Tracked so we only fire on the edge: leaving the dead-zone
   *  triggers one tick; releasing the stick resets the axis so the
   *  next push fires again. */
  rightDelta: number;
}

function empty(): State {
  return {
    primary: false,
    cancel: false,
    menu: false,
    stick: null,
    dpad: null,
    rightAxis: null,
    rightDelta: 0,
  };
}

// Backwards compat: old code referenced `MENU_BUTTON = 3` and labelled
// it "Y on Xbox". The user wants the menu gesture on **X** (button
// 2), not Y. Keeping the constant internal so this stays a one-line
// swap if the mapping needs to change again.


function read(navigator: Navigator): State {
  const pads = navigator.getGamepads?.() ?? [];
  const next = empty();
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!pad) continue;
    if (pad.buttons[PRIMARY_BUTTON]?.pressed) next.primary = true;
    if (pad.buttons[CANCEL_BUTTON]?.pressed) next.cancel = true;
    if (pad.buttons[MENU_BUTTON]?.pressed) next.menu = true;

    // D-pad can show up as either axes 9/10 (standard mapping) or
    // buttons 12-15. Read both forms and take whichever fires.
    const dpadBtns = dominant(
      (pad.buttons[14]?.pressed ? -1 : pad.buttons[15]?.pressed ? 1 : 0),
      (pad.buttons[12]?.pressed ? -1 : pad.buttons[13]?.pressed ? 1 : 0),
      0.5,
    );
    const dpadAxes = dominant(pad.axes[9] ?? 0, pad.axes[10] ?? 0, STICK_DEAD_ZONE);
    const dpad = dpadBtns ?? dpadAxes;
    if (dpad) next.dpad = dpad;

    // Left stick is the fallback if no D-pad reports.
    const stick = dominant(pad.axes[0] ?? 0, pad.axes[1] ?? 0, STICK_DEAD_ZONE);
    if (stick) next.stick = stick;

    // Right stick is reserved for scrolling. We carry the per-frame
    // dominant axis + signed magnitude; the dispatch step converts
    // this into a wheel event on the edge out of the dead-zone.
    const rs = readRightStick(pad);
    next.rightAxis = rs.axis;
    next.rightDelta = rs.magnitude * SCROLL_PIXELS_PER_UNIT;
  }
  return next;
}

function dispatch(prev: State, next: State): State {
  // Buttons: edge-detect (only fire on the press, not while held).
  if (!prev.primary && next.primary) sendKey("Enter");
  if (!prev.cancel && next.cancel) sendKey("Escape");
  if (!prev.menu && next.menu) sendContextMenu();

  // Direction: prefer D-pad; left stick only if D-pad didn't fire.
  // Only dispatch on a state change so a held stick doesn't repeat
  // every frame. The user releases + re-presses to fire again.
  const dir: Dir | null = next.dpad ?? next.stick ?? null;
  const prevDir: Dir | null = prev.dpad ?? prev.stick ?? null;
  if (dir !== null && dir !== prevDir) {
    sendKey(dir);
  } else if (dir === null) {
    // Reset the previous direction so the next press in any direction
    // fires (covering the case where stick moved from Up to Right
    // while held — without a release, the prev-stored Up would block
    // Right).
    if (prevDir !== null) {
      // No dispatch, just record the new state.
    }
  }

  // Right stick → scroll. Fire on the *transition into* the deflection
  // zone (either the dead-zone's outer edge or a swap between axis
  // directions). Holding the stick at full tilt does not auto-repeat
  // — that would feel like runaway scroll; users release + re-push
  // for each tick. Edge cases:
  //   - prevAxis=null, nextAxis="x"  → push-out, fire scroll.
  //   - prevAxis=null, nextAxis="y"  → push-out, fire scroll.
  //   - prevAxis="x", nextAxis="y"  → swap, fire scroll on y axis.
  //   - prevAxis="x", nextAxis="x"  → held tilt, no fire (repeat
  //     would surprise the user).
  //   - prevAxis="x", nextAxis=null → release, no fire. Resets the
  //     axis so the next push fires.
  if (next.rightAxis !== prev.rightAxis && next.rightAxis !== null) {
    const start = document.activeElement instanceof Element
      ? document.activeElement
      : null;
    const dx = next.rightAxis === "x" ? next.rightDelta : 0;
    const dy = next.rightAxis === "y" ? next.rightDelta : 0;
    scrollByNear(start, dx, dy);
  }

  return next;
}

/* ---------------------------------------------------------------------------
 *  Effect lifecycle.
 *  -------------------------------------------------------------------------*/

let rafId: number | null = null;
let prev: State = empty();
let active = false;

export function installGamepadAdapter(): () => void {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return () => {};
  }
  function start() {
    if (active || typeof requestAnimationFrame === "undefined") return;
    const pads = navigator.getGamepads?.() ?? [];
    const hasAny = Array.from(pads).some((p) => !!p);
    if (!hasAny) {
      active = false;
      return;
    }
    active = true;
    prev = empty();
    rafId = requestAnimationFrame(tick);
  }
  function stop() {
    active = false;
    if (rafId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    prev = empty();
  }
  function tick() {
    if (!active) return;
    prev = dispatch(prev, read(navigator));
    rafId = requestAnimationFrame(tick);
  }
  // Hot-plug: a controller connecting starts the loop; disconnecting
  // stops it. Without this an idle desktop pays no rAF cost.
  window.addEventListener("gamepadconnected", start);
  window.addEventListener("gamepaddisconnected", stop);
  start();
  return () => {
    window.removeEventListener("gamepadconnected", start);
    window.removeEventListener("gamepaddisconnected", stop);
    stop();
  };
}

/** Hook form for app-root mounting. */
export function useGamepadAdapter(): void {
  useEffect(() => installGamepadAdapter(), []);
}
