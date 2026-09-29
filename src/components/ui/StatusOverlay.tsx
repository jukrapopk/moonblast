import { Fragment, type ReactNode } from "react";
import { useSettings } from "../../settings/SettingsContext";
import { useTime, formatClock } from "../../hooks/useTime";
import { useBattery, useBatteryPower } from "../../hooks/useBattery";
import { formatDuration } from "./formatDuration";

/**
 * Contents of the `overlay` window — the thin always-on-top status notch.
 *
 * Rust owns the window's show/hide lifecycle (see `overlay.rs`); this
 * component only renders the enabled readouts (time / battery / power draw)
 * and follows the app theme through the shared surface tokens. The notch sits
 * flush with the top of the screen, so it uses bottom-only rounding to read as
 * a notch rather than a floating pill.
 */
export function StatusOverlay() {
  const { settings } = useSettings();
  const { enabled, show_time, show_battery, power_draw, scale, opacity, position } =
    settings.overlay;
  const now = useTime();
  // "Time Left" reads the same battery status the percent uses; "Wattage"
  // needs the power-draw read. Only the selected mode's read is armed so an
  // idle notch doesn't poll for data it isn't showing.
  const wantsTimeLeft = power_draw === "time_left";
  const { status: battery } = useBattery(enabled && (show_battery || wantsTimeLeft));
  const watts = useBatteryPower(enabled && power_draw === "wattage");

  if (!enabled) return null;

  // The window spans the top edge of the monitor; the card aligns to the
  // chosen side inside it. Scaling around the matching corner keeps the notch
  // flush with that side, and Rust sized the window tall enough for `scale`.
  const justify =
    position === "left" ? "justify-start" : position === "right" ? "justify-end" : "justify-center";
  const origin = position === "left" ? "top left" : position === "right" ? "top right" : "top center";
  // Clamp to the same ranges `overlay.rs` enforces so a hand-edited
  // settings.json can't scale the card bigger than the window Rust sized.
  const clampedScale = Math.min(2, Math.max(0.5, scale));
  const clampedOpacity = Math.min(1, Math.max(0.1, opacity));

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
  if (power_draw === "wattage" && watts != null) {
    parts.push(
      <span key="watts" className="tabular-nums">
        {Math.abs(watts).toFixed(1)} W
      </span>,
    );
  }
  // Win32 only estimates runtime off-wall (`BatteryLifeTime` returns -1 on
  // AC), so the part is simply omitted when there's no estimate rather than
  // showing a permanent "Calculating…" in the notch.
  if (wantsTimeLeft && battery && battery.timeRemainingSec && battery.timeRemainingSec > 0) {
    parts.push(
      <span key="time-left" className="tabular-nums">
        {formatDuration(battery.timeRemainingSec, "short")}
      </span>,
    );
  }

  return (
    <div className={`flex h-full w-full items-start ${justify}`}>
      {parts.length > 0 && (
        <div
          className="notch flex items-center gap-2 rounded-b-lg border-x border-b border-(--color-border) bg-(--color-surface-2) px-2 pt-[3.25px] pb-1 text-[12px] leading-none font-medium text-(--color-text) shadow-lg"
          style={{
            transform: `scale(${clampedScale})`,
            transformOrigin: origin,
            opacity: clampedOpacity,
          }}
        >
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
