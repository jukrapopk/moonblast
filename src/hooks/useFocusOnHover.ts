import { useEffect } from "react";

/**
 * Global "hover = focus" handler. Listens for `mouseover` at the
 * capture phase on `document` and focuses the entered element so
 * the same `:focus` / `:focus-visible` styling applies for both
 * mouse and keyboard navigation. One listener covers every
 * component — no per-button wiring needed.
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
    function onMouseOver(e: Event) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // Don't yank focus out of text inputs / textareas /
      // contenteditable regions — they need arrows for caret
      // movement, not focus jumps.
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (typeof t.focus !== "function") return;
      t.focus({ preventScroll: true });
    }
    // Capture phase: runs before any React `onMouseEnter` /
    // `onMouseOver` handlers, so we focus the element regardless
    // of how the rest of the tree reacts to the mouseover.
    document.addEventListener("mouseover", onMouseOver, true);
    return () => document.removeEventListener("mouseover", onMouseOver, true);
  }, []);
}