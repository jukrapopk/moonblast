import { useState } from "react";
import { useDebouncedRead } from "./useDebouncedRead";

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
 * would just return duplicate values). Back-to-back focus + visibility
 * triggers collapse to a single IPC via the shared `useDebouncedRead`.
 */
export function useBattery(): {
  status: BatteryStatus | null;
  refresh: () => void;
} {
  const [status, setStatus] = useState<BatteryStatus | null>(null);
  const read = useDebouncedRead<BatteryStatus | null>("battery", setStatus, {
    pollIntervalMs: 5_000,
  });
  return { status, refresh: read };
}