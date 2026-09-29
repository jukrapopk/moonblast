import { useEffect, type DependencyList } from "react";

/**
 * Run `fn` once on mount, then again on `window.focus` and on
 * `visibilitychange → visible`. Cancels on unmount via an `alive` flag
 * so an in-flight async call doesn't `setState` after unmount.
 *
 * `enabled` (default `true`) skips the registration entirely when false —
 * so a caller that is mounted-but-idle (a modal rendered at the App root
 * with `open` as a prop) attaches no listeners at all, rather than
 * attaching them and fencing inside the callback. `enabled` is part of the
 * effect deps, so flipping it re-runs the effect and fires the initial
 * call on the way in. Mirrors `useVisibleInterval`'s flag.
 *
 * Shared by hooks that just want to keep a piece of state in sync with
 * the foreground app (`useAudio`, `useDebouncedRead`, `MoonlightView`,
 * `MoonlightSettings`).
 *
 *   useFocusRefresh(refresh);
 *   useFocusRefresh(() => scan(), [sub === "machines"]);
 *   useFocusRefresh(refresh, [open], open);
 */
export function useFocusRefresh(fn: () => void, deps?: DependencyList, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const safe = () => {
      if (alive) fn();
    };
    safe();
    function onFocus() {
      safe();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") safe();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...(deps ?? []), enabled]);
}
