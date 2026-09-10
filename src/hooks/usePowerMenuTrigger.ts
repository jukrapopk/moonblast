// Module-level singleton for opening the Power menu from anywhere (Rust
// events like `request-power-menu`, keyboard shortcuts, etc.) without
// prop-drilling. TopBar subscribes via `usePowerMenuTrigger()` and calls
// its own `setPowerOpen(true)` when the flag flips.
//
// Single-subscriber by design: only TopBar owns the actual modal state
// (it has the immersive/fullscreen props the Power menu needs), so we
// don't need a generic open/close API. `openPowerMenu()` is fire-and-
// forget; the Power menu's existing close handler resets the flag.

import { useEffect, useState } from "react";

let pending = false;
const listeners = new Set<(v: boolean) => void>();

/** Open the Power menu. No-op if it's already open. */
export function openPowerMenu() {
  if (pending) return;
  pending = true;
  listeners.forEach((l) => l(true));
}

/**
 * Subscribes to Power-menu open requests. Returns the current pending
 * state so callers can show / hide based on it. The caller is
 * responsible for calling `resetPowerMenu()` when its modal actually
 * closes, so subsequent opens work.
 */
export function usePowerMenuTrigger(): boolean {
  const [pendingState, setPendingState] = useState(pending);
  useEffect(() => {
    const l = (v: boolean) => setPendingState(v);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return pendingState;
}

/** Mark the Power menu as closed so the next `openPowerMenu()` works. */
export function resetPowerMenu() {
  if (!pending) return;
  pending = false;
  listeners.forEach((l) => l(false));
}