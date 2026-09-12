import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { SectionLabel } from "./SectionLabel";
import { formatDuration } from "./formatDuration";

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

interface BatteryModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * "Battery" modal — opens from the TopBar chip. Read-on-open plus a 2s
 * refresh while open (so the percent / time-remaining tick down live),
 * mirrors the AudioModal/WifiModal vocabulary: STATUS section with a big
 * percent + horizontal fill bar + time-remaining, POWER SOURCE line, no
 * footer action.
 */
export function BatteryModal({ open, onClose }: BatteryModalProps) {
  const [status, setStatus] = useState<BatteryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    let cancelled = false;
    async function read() {
      try {
        const s = await invoke<BatteryStatus | null>("battery");
        if (!cancelled) setStatus(s);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    void read();
    // Refresh every 2s while the modal is open so the user sees the
    // percent / time-remaining tick down live. The hook in the TopBar
    // already handles focus + visibility for the chip; the modal just
    // wants the numbers to keep moving.
    const id = setInterval(read, 2_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open]);

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
      {error && (
        <p className="mb-3 rounded-lg border border-(--color-danger)/30 bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </p>
      )}

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