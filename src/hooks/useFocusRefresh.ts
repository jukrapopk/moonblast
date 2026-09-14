import { useEffect, type DependencyList } from "react";

/**
 * Run `fn` once on mount, then again on `window.focus` and on
 * `visibilitychange → visible`. Cancels on unmount via an `alive` flag
 * so an in-flight async call doesn't `setState` after unmount.
 *
 * Shared by hooks that just want to keep a piece of state in sync with
 * the foreground app (`useAudio`, `useDebouncedRead`, `MoonlightView`,
 * `MoonlightSettings`).
 *
 *   useFocusRefresh(refresh);
 *   useFocusRefresh(() => scan(), [sub === "machines"]);
 */
export function useFocusRefresh(fn: () => void, deps?: DependencyList) {
  useEffect(() => {
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
  }, deps);
}
