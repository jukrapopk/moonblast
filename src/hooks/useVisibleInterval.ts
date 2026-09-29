import { useEffect, useRef } from "react";

/**
 * `setInterval` that only runs while the window is visible.
 *
 * The hand-rolled-timer equivalent of the gate `useDebouncedRead` and `useTime`
 * already apply, so every poll in the app follows one rule: a hidden window (a
 * minimized launcher, the notch tucked away by autohide) doesn't poll.
 * Chromium throttles hidden timers anyway; stopping outright makes the surface
 * free, and the timeout is restarted — with an immediate tick — the moment the
 * window comes back, so it never returns with stale data.
 *
 * `fn` is read through a ref, so passing an inline closure is fine.
 */
export function useVisibleInterval(fn: () => void, ms: number, enabled = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id === null) id = setInterval(() => fnRef.current(), ms);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    if (document.visibilityState === "visible") {
      fnRef.current();
      start();
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        fnRef.current();
        start();
      } else {
        stop();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms, enabled]);
}
