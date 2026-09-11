import {
  BatteryCharging,
  BatteryEmpty,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
} from "@phosphor-icons/react";

interface BatteryIconProps {
  /** -1 for unknown, 0–100 otherwise. */
  percent: number;
  charging: boolean;
  size?: number;
}

/**
 * Single battery glyph used by the TopBar chip. Normal state is a dimmed
 * level-based base (Empty / Low / Medium / Full) with a full-brightness
 * `BatteryCharging` overlay directly on top when charging — mirroring
 * `SpeakerIcon`'s stacked-icon pattern so the chip "feels" the same as
 * the audio and WiFi indicators. Unknown (`percent < 0`) renders a lone
 * `BatteryWarning` with no overlay.
 *
 * At 100% the bold-outline `BatteryFull` silhouette has no internal bar
 * segments (they collapse into the outline at full charge), so the
 * dimmed 40%-opacity treatment reads as "off / muted" — same as a
 * powered-down chip. Fix: render a fully-filled `BatteryFull` (fill
 * weight) at 100% opacity when `percent >= 100`. The chip reads as
 * "topped up" instead of dead, while still staying distinct from the
 * partial states (Medium/Low/Empty) that the outline-with-bars style
 * continues to carry.
 */
export function BatteryIcon({ percent, charging, size = 24 }: BatteryIconProps) {
  if (percent < 0) {
    return <BatteryWarning size={size} weight="bold" />;
  }
  // Exact 100% only — partial states keep the outline-with-bars style
  // so the level is still legible.
  const isFull = percent >= 100;
  if (isFull) {
    return (
      <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
        <BatteryFull size={size} weight="fill" className="absolute inset-0" />
        {charging && (
          <BatteryCharging size={size} weight="bold" className="absolute inset-0" />
        )}
      </span>
    );
  }
  const Base = pickBase(percent);
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <Base size={size} weight="bold" className="absolute inset-0 opacity-40" />
      {charging && (
        <BatteryCharging size={size} weight="bold" className="absolute inset-0" />
      )}
    </span>
  );
}

function pickBase(percent: number) {
  if (percent <= 10) return BatteryEmpty;
  if (percent <= 35) return BatteryLow;
  if (percent <= 75) return BatteryMedium;
  return BatteryFull;
}
