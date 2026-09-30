import { useCallback, useEffect, useRef } from "react";

/**
 * A stable `() => boolean` that reports whether the component is still
 * mounted. Use it to fence a `setState` that runs after an `await`, so a
 * component that unmounted mid-flight (a page switch, a view that owns the
 * request, an unmounting modal) doesn't keep writing state for a scope
 * that's gone:
 *
 *   const isMounted = useMounted();
 *   const list = await invoke(...);
 *   if (isMounted()) setList(list);
 *
 * Re-arms on every effect run so React StrictMode's dev-only
 * mount → cleanup → mount double-invoke can't leave it stuck `false`.
 */
export function useMounted(): () => boolean {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return useCallback(() => alive.current, []);
}
