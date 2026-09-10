import { useEffect, useState } from "react";

/**
 * Live wall-clock time, refreshed every 30s. Returns a `Date` so callers can
 * format however they like. 30s is enough to never show a stale minute while
 * keeping the wakeup rate negligible.
 */
export function useTime(now: () => Date = () => new Date()): Date {
  const [t, setT] = useState<Date>(now);
  useEffect(() => {
    const id = setInterval(() => setT(now()), 30_000);
    return () => clearInterval(id);
  }, [now]);
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
