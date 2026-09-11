import {
  BatteryCharging,
  BatteryEmpty,
  BatteryFull,
  BatteryHigh,
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
 * Single battery glyph used by the TopBar chip. One glyph, picked by
 * state — no layering:
 *
 *   - charging wins over level (the OS-driven "actively accepting
 *     current" indicator is the actionable signal)
 *   - unknown (`percent < 0`) → `BatteryWarning`
 *   - 81–100% → `BatteryFull`
 *   - 61–80%  → `BatteryHigh`
 *   - 36–60%  → `BatteryMedium`
 *   - 11–35%  → `BatteryLow`
 *   - 0–10%   → `BatteryEmpty`
 */
export function BatteryIcon({ percent, charging, size = 24 }: BatteryIconProps) {
  if (percent < 0) {
    return <BatteryWarning size={size} weight="bold" />;
  }
  if (charging) {
    return <BatteryCharging size={size} weight="bold" />;
  }
  const Base = pickBase(percent);
  return <Base size={size} weight="bold" />;
}

function pickBase(percent: number) {
  if (percent <= 10) return BatteryEmpty;
  if (percent <= 35) return BatteryLow;
  if (percent <= 60) return BatteryMedium;
  if (percent <= 80) return BatteryHigh;
  return BatteryFull;
}
