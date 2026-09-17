import { useEffect } from "react";

/**
 * Global "hover = focus" handler. Uses `mouseenter` / `mouseleave`
 * (not `mouseover` / `mouseout`) captured at `document` — these
 * only fire when the pointer actually enters/exits an element's
 * own box, not on every crossing into a child element, so hovering
 * around inside a button (e.g. over its icon vs. its label) doesn't
 * spuriously blur it. One listener pair covers every component —
 * no per-button wiring needed.
 *
 * `mouseenter` focuses the entered element so the same `:focus` /
 * `:focus-visible` styling applies for both mouse and keyboard nav.
 * `mouseleave` blurs it again — but only when the element being
 * left is the one currently focused, so leaving stops mid-tree
 * ancestors (which were never focused in the first place) from
 * blurring anything.
 *
 * Skipped:
 *   - Targets inside `input` / `textarea` / `[contenteditable]`
 *     — those use arrow keys for text navigation, not focus.
 *   - Elements that aren't focusable (the `.focus()` call is
 *     guarded by a typeof check; no-op otherwise).
 *
 * `preventScroll: true` keeps the page from jumping when the user
 * mouses into a control that's partially below the fold.
 *
 * Mounted once at the app root from `App.tsx`.
 */
export function useFocusOnHover() {
  useEffect(() => {
    function onMouseEnter(e: Event) {
      // Narrow to Element first — `closest` lives on Element.prototype,
      // and the spec lets `e.target` be a non-Element in edge cases
      // (e.g. dispatch from `Document` or `Window`). Bail before
      // touching methods that don't exist on those.
      if (!(e.target instanceof Element)) return;
      const t = e.target as HTMLElement;
      // Don't yank focus out of text inputs / textareas /
      // contenteditable regions — they need arrows for caret
      // movement, not focus jumps.
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (typeof t.focus !== "function") return;
      t.focus({ preventScroll: true });
    }
    function onMouseLeave(e: Event) {
      if (!(e.target instanceof Element)) return;
      const t = e.target as HTMLElement;
      // Only blur if the element being left is the one actually
      // focused — mouseleave also fires for every ancestor between
      // the old and new hover target, most of which were never
      // focused to begin with (the .focus() call above is a no-op
      // on non-focusable elements).
      if (document.activeElement !== t) return;
      t.blur();
    }
    // Capture phase: mouseenter/mouseleave don't bubble, but the
    // capturing pass still walks root → target for every dispatch,
    // so a single pair of listeners on `document` sees every
    // element's enter/leave without per-component wiring.
    document.addEventListener("mouseenter", onMouseEnter, true);
    document.addEventListener("mouseleave", onMouseLeave, true);
    return () => {
      document.removeEventListener("mouseenter", onMouseEnter, true);
      document.removeEventListener("mouseleave", onMouseLeave, true);
    };
  }, []);
}
