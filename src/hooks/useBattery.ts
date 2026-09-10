import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface BatteryStatus {
  /** 0–100, or -1 when the OS reports "unknown". */
  percent: number;
  /** True when the battery is actively accepting current. */
  charging: boolean;
  /** True when on wall power (regardless of charge state). */
  pluggedIn: boolean;
  /**
   * Estimated seconds until empty (on battery) or until full (charging).
   * `null` when the OS reports "unknown" / no estimate.
   */
  timeRemainingSec: number | null;
}

/**
 * Polled battery state for the TopBar chip. Refreshes on:
 *   - mount (app start)
 *   - every 5s while the launcher is foreground (chip must reflect
 *     plug/unplug events within a few seconds)
 *   - window `focus`
 *   - `visibilitychange` to "visible" (user alt-tabs back from a stream)
 *   - explicit `refresh()` call
 *
 * 5s is short enough that the chip looks realtime for plug/unplug (the OS
 * itself only updates `SYSTEM_POWER_STATUS` at ~1Hz, so faster polling
 * would just return duplicate values). The hook also collapses
 * back-to-back refresh calls like `useWifi` does so concurrent triggers
 * never spawn parallel invocations.
 */
export function useBattery(): {
  status: BatteryStatus | null;
  refresh: () => void;
} {
  const [status, setStatus] = useState<BatteryStatus | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  // 2s collapse window mirrors useWifi. Back-to-back focus+visibility
  // events shouldn't issue a second read.
  const lastReadAt = useRef(0);

  const read = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const now = Date.now();
    if (now - lastReadAt.current < 2000) return;
    lastReadAt.current = now;
    const p = (async () => {
      try {
        const s = await invoke<BatteryStatus | null>("battery");
        setStatus(s);
      } catch {
        setStatus(null);
      }
    })();
    inFlight.current = p;
    try {
      await p;
    } finally {
      inFlight.current = null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const safeRead = () => {
      if (alive) void read();
    };
    safeRead();
    const id = setInterval(safeRead, 5_000);
    function onFocus() {
      safeRead();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") safeRead();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [read]);

  return { status, refresh: read };
}