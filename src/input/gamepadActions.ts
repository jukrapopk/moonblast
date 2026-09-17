/**
 * Gamepad action handlers. Shared between `useGamepad` (real
 * gamepad polling) and any future input source that maps to the
 * "activate" / "cancel" semantic. Element-type-aware so a single
 * helper covers buttons, links, selects, sliders, and inputs
 * without per-call-site branching.
 *
 * The previous design in `useGamepad` only called `.click()` on the
 * focused element. That worked for `<button>` and `<a>` but had two
 * holes:
 *   - `<select>` requires a synthesized mousedown/mouseup pair or
 *     a trusted user gesture; `.click()` alone is unreliable in
 *     WebView2.
 *   - Element-specific React `onKeyDown` handlers (Select.tsx's
 *     `preventDefault` for ArrowUp/Down, VolumeControl's Left/Right
 *     step) only fire on a keydown — calling `.click()` skips them.
 *
 * The new approach: synthesize an Enter `keydown` on the focused
 * element (not `window`) so local React handlers run, then also
 * call the element's user-gesture activation (`.click()` /
 * `.showPicker()`) so the browser's native activation logic still
 * triggers even though synthesized keydowns aren't trusted.
 */

function isHTMLSelectElement(el: Element | null): el is HTMLSelectElement {
  return el instanceof HTMLSelectElement;
}

function hasShowPicker(el: HTMLSelectElement): el is HTMLSelectElement & { showPicker(): Promise<void> } {
  return typeof (el as unknown as { showPicker?: () => unknown }).showPicker === "function";
}

/**
 * Activate the currently focused element. Tries, in order:
 *   1. A synthesized Enter `keydown` on the element so local
 *      React onKeyDown handlers (Select.tsx, VolumeControl.tsx,
 *      etc.) fire.
 *   2. The element's native activation path:
 *      - `<select>` → `showPicker()` if available, else `.click()`.
 *      - `<button>` / `<a>` / `<input type="checkbox|radio">` →
 *        `.click()` (canonical user-gesture activation).
 *      - Other elements → no native activation (the synthesized
 *        Enter is the whole story for them).
 *
 * Returns `true` if the focused element was activated in some way,
 * `false` if there was no focusable target.
 */
export function activateFocused(): boolean {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement)) return false;
  // 1. Synthesized Enter on the element. Routes through React
  //    onKeyDown handlers and the element's own listeners. Not
  //    trusted by the browser (won't trigger native button
  //    activation), so we still call the user-gesture path below.
  const enterEvent = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  a.dispatchEvent(enterEvent);
  // 2. Native user-gesture activation.
  if (isHTMLSelectElement(a)) {
    if (hasShowPicker(a)) {
      try {
        a.showPicker();
        return true;
      } catch {
        // showPicker throws if not triggered by user activation
        // (which a synthesized event doesn't have). Fall through
        // to .click() below.
      }
    }
    a.click();
    return true;
  }
  if (
    a instanceof HTMLButtonElement ||
    (a instanceof HTMLInputElement &&
      (a.type === "checkbox" || a.type === "radio")) ||
    (a instanceof HTMLAnchorElement && a.hasAttribute("href"))
  ) {
    a.click();
    return true;
  }
  // Other focusable elements (range, text, etc.) get the Enter
  // dispatch only — that's enough to focus them for further
  // input and to fire any custom handlers.
  return true;
}

/**
 * Cancel / back action. Dispatches an Escape `keydown` on the
 * focused element so any local onKeyDown handler can react, then
 * falls back to a `window`-level dispatch so LIFO modal/menu
 * handlers (registered via `pushEscapeHandler`) still see it.
 */
export function cancel(): void {
  const a = document.activeElement;
  if (a instanceof HTMLElement) {
    a.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  // Belt-and-braces: also bubble to window so the spatial
  // controller's LIFO escape stack picks it up if the focused
  // element didn't `stopPropagation`.
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}
