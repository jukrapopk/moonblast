import { Fragment, type ReactNode } from "react";
import { useSettings } from "../../settings/SettingsContext";
import { useTime, formatClock } from "../../hooks/useTime";
import { useBattery, useBatteryPower } from "../../hooks/useBattery";

/**
 * Contents of the `overlay` window — the thin always-on-top status notch.
 *
 * Rust owns the window's show/hide lifecycle (see `overlay.rs`); this
 * component only renders the enabled readouts (time / battery / battery
 * usage) and follows the app theme through the shared surface tokens. The
 * notch sits flush with the top of the screen, so it uses bottom-only
 * rounding to read as a notch rather than a floating pill.
 */
export function StatusOverlay() {
  const { settings } = useSettings();
  const { enabled, show_time, show_battery, show_battery_usage } = settings.overlay;
  const now = useTime();
  const { status: battery } = useBattery(enabled && show_battery);
  const watts = useBatteryPower(enabled && show_battery_usage);

  if (!enabled) return null;

  const parts: ReactNode[] = [];
  if (show_time) {
    parts.push(
      <span key="time" className="tabular-nums">
        {formatClock(now)}
      </span>,
    );
  }
  if (show_battery && battery) {
    parts.push(
      <span key="battery" className="tabular-nums">
        {battery.percent < 0 ? "—" : `${battery.percent}%`}
      </span>,
    );
  }
  if (show_battery_usage && watts != null) {
    parts.push(
      <span key="watts" className="tabular-nums">
        {Math.abs(watts).toFixed(1)} W
      </span>,
    );
  }

  return (
    <div className="flex h-full w-full items-start justify-center">
      {parts.length > 0 && (
        <div className="flex items-center gap-2 rounded-b-lg border border-t-0 border-(--color-border) bg-(--color-surface-2) px-2 py-1 text-[12px] leading-none font-medium text-(--color-text) shadow-lg">
          {parts.map((part, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="text-(--color-muted)">·</span>}
              {part}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
