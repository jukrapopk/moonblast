// Module-level pub/sub for opening the Power menu from anywhere (Rust
// events like `request-power-menu`, keyboard shortcuts, etc.) without
// prop-drilling. TopBar subscribes via `usePowerMenuTrigger()` and the
// returned `subscribe(cb)` lets it react to every `openPowerMenu()`
// call regardless of whether its modal is already open.
//
// Single-subscriber by design: only TopBar owns the actual modal state
// (it has the immersive/fullscreen props the Power menu needs), so we
// don't need a generic open/close API. `openPowerMenu()` is pure
// fire-and-forget — it never depends on the consumer's lifecycle.

import { useEffect, useMemo } from "react";

const listeners = new Set<() => void>();

/**
 * Open the Power menu. Always fires; the consumer's modal state
 * decides whether to actually show it (TopBar's `setPowerOpen(true)`
 * is idempotent — React bails on equal values). Earlier versions
 * gated this on a `pending` flag the consumer had to clear in its
 * close handler; that stranded the trigger if the consumer unmounted
 * mid-open.
 */
export function openPowerMenu() {
  listeners.forEach((l) => l());
}

/**
 * Subscribes to Power-menu open requests. Returns a stable callback
 * the caller should register with its modal open-state setter, so
 * every `openPowerMenu()` invocation reaches the consumer even when
 * the modal is already open (e.g. user alt-F4s while the menu is up).
 *
 * The returned `subscribe` is stable across renders; the cleanup
 * unsubscribes when the consumer unmounts.
 */
export function usePowerMenuTrigger(): { subscribe: (cb: () => void) => void } {
  const subscribe = useMemo(
    () => (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    [],
  );
  useEffect(() => {
    // No-op: subscribe is a stable ref. We rely on the consumer to
    // register/unregister its callback via the returned `subscribe`.
  }, []);
  return { subscribe };
}