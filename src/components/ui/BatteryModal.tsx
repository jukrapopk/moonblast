import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { SectionLabel } from "./SectionLabel";
import { ErrorBanner } from "./ErrorBanner";
import { formatDuration } from "./formatDuration";
import { useForegroundInterval } from "../../hooks/useForegroundInterval";
import type { BatteryStatus } from "../../hooks/useBattery";

interface BatteryModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * "Battery" modal — opens from the TopBar chip. Read-on-open plus a 2s
 * visibility-gated refresh while open (so the percent / time-remaining tick
 * down live), mirrors the AudioModal/WifiModal vocabulary: STATUS section with
 * a big percent + horizontal fill bar + time-remaining, POWER SOURCE line, no
 * footer action.
 */
export function BatteryModal({ open, onClose }: BatteryModalProps) {
  const [status, setStatus] = useState<BatteryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Authoritative read for the modal. The component stays mounted at the App
  // root (only `open` changes), so a late resolve after close just refreshes
  // the numbers for the next open — no unmount guard needed.
  const read = useCallback(async () => {
    try {
      setStatus(await invoke<BatteryStatus | null>("battery"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  // Read on open, then keep the percent / time-remaining ticking live while
  // the modal is up. `useForegroundInterval` reads once up front and stops the
  // 2s tick whenever the window drops out of the foreground, so a modal left
  // open behind a game / a stream issues no IPCs — the same rule every other
  // timer in the app follows. The TopBar chip keeps its own 5s cadence.
  useForegroundInterval(read, 2_000, open);

  const percent = status?.percent ?? -1;
  const charging = status?.charging ?? false;
  const pluggedIn = status?.pluggedIn ?? false;
  const timeSec = status?.timeRemainingSec ?? null;
  const known = percent >= 0;
  const fillColor =
    known && !charging && percent <= 10
      ? "bg-(--color-danger)"
      : "bg-(--color-accent)";

  return (
    <Modal open={open} onClose={onClose} title="Battery" width="max-w-md">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <SectionLabel>Status</SectionLabel>
      <div className="mb-5 rounded-xl px-1 py-2">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-3xl font-semibold tabular-nums text-(--color-text)">
            {known ? `${percent}%` : "—"}
          </span>
          <span className="text-sm text-(--color-muted)">
            {charging ? "Charging" : pluggedIn ? "Plugged in" : "On battery"}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-(--color-surface)">
          {known && (
            <div
              className={`h-full rounded-full transition-all ${fillColor}`}
              style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
            />
          )}
        </div>
        {/* Time row only when the OS has an estimate. Win32 doesn't
          *  expose time-to-full — BatteryLifeTime returns -1 on AC per
          *  MS docs — so while charging/on-AC the row is hidden instead
          *  of showing a permanent "Calculating…". */}
        {timeSec !== null && timeSec > 0 && (
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-(--color-muted)">
              {charging ? "Time to full" : "Time remaining"}
            </span>
            <span className="tabular-nums text-(--color-text)">
              {formatDuration(timeSec, "long")}
            </span>
          </div>
        )}
      </div>

      <SectionLabel>Power source</SectionLabel>
      <div className="mb-1 flex items-center justify-between rounded-xl px-1 py-2">
        <span className="text-sm text-(--color-muted)">Source</span>
        <span className="text-sm text-(--color-text)">
          {pluggedIn ? "Wall power" : "Battery"}
        </span>
      </div>
    </Modal>
  );
}