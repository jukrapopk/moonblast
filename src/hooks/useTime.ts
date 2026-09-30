import { useEffect, useRef, useState } from "react";
import { isForeground, subscribeForeground } from "./foreground";

/**
 * Live wall-clock time, refreshed every 30s. Returns a `Date` so callers can
 * format however they like. 30s is enough to never show a stale minute while
 * keeping the wakeup rate negligible.
 *
 * `now` is held in a ref so callers that pass an inline arrow don't churn
 * the interval on every render — the interval is foreground-gated and reads
 * the latest `now()` at each tick.
 */
export function useTime(now: () => Date = () => new Date()): Date {
  const [t, setT] = useState<Date>(now);
  const nowRef = useRef(now);
  nowRef.current = now;
  // Tick only while the window is in the foreground: an unfocused window's
  // clock isn't being looked at, and a hidden one is throttled by Chromium
  // anyway. The mount value is already fresh, so only a transition into the
  // foreground snaps it to now (`focus` / `visibilitychange` fire on real
  // transitions only) — no redundant render on mount.
  useEffect(() => {
    const tick = () => setT(nowRef.current());
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id === null) id = setInterval(tick, 30_000);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const onForeground = () => {
      if (isForeground()) {
        tick();
        start();
      } else {
        stop();
      }
    };
    if (isForeground()) start();
    const unsubscribe = subscribeForeground(onForeground);
    return () => {
      stop();
      unsubscribe();
    };
  }, []);
  return t;
}

/** `HH:MM` in 24h. Stable width (no am/pm) so the chip doesn't reflow. */
export function formatClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * Locale-formatted short date (e.g. "Sep 10, 2026" in en-US, "10/09/2026"
 * in en-GB). Uses the OS locale — no in-app format choice, so the chip
 * matches whatever the user picked in Windows Settings.
 */
export function formatDate(d: Date): string {
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}
