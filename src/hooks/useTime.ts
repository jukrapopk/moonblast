import { useEffect, useRef, useState } from "react";

/**
 * Live wall-clock time, refreshed every 30s. Returns a `Date` so callers can
 * format however they like. 30s is enough to never show a stale minute while
 * keeping the wakeup rate negligible.
 *
 * `now` is held in a ref so callers that pass an inline arrow don't churn
 * the interval on every render — the interval is visibility-gated and reads
 * the latest `now()` at each tick.
 */
export function useTime(now: () => Date = () => new Date()): Date {
  const [t, setT] = useState<Date>(now);
  const nowRef = useRef(now);
  nowRef.current = now;
  // Tick only while the window is visible: a hidden window's clock isn't on
  // screen, and Chromium throttles hidden timers regardless. Coming back to
  // visible snaps the value to now instead of waiting out the interval.
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const tick = () => setT(nowRef.current());
    const sync = () => {
      const visible = document.visibilityState === "visible";
      if (visible && id === null) {
        tick();
        id = setInterval(tick, 30_000);
      } else if (!visible && id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      if (id !== null) clearInterval(id);
      document.removeEventListener("visibilitychange", sync);
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
