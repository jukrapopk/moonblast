import { useEffect, useRef } from "react";
import { isForeground, subscribeForeground } from "./foreground";

/**
 * `setInterval` that only runs while the window is in the foreground
 * (`isForeground()`), and fires once on every transition into the
 * foreground so the surface never comes back with stale data.
 *
 * The hand-rolled-timer form of the foreground gate (the other interval
 * hooks, `useTime` and `useDebouncedRead`, apply the same condition). A
 * foregrounded window behaves exactly as a plain `setInterval` would,
 * and a window the user has left (a game or a Moonlight stream in
 * front) stops ticking entirely —
 * Chromium only throttles a hidden window, not an unfocused one, so
 * stopping outright is what makes a backgrounded launcher free.
 *
 * `fn` is read through a ref, so passing an inline closure is fine.
 */
export function useForegroundInterval(fn: () => void, ms: number, enabled = true) {
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
    const sync = () => {
      if (isForeground()) {
        fnRef.current();
        start();
      } else {
        stop();
      }
    };
    sync();
    const unsubscribe = subscribeForeground(sync);
    return () => {
      stop();
      unsubscribe();
    };
  }, [ms, enabled]);
}
