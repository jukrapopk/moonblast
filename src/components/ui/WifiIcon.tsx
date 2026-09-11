import {
  WifiHigh,
  WifiLow,
  WifiMedium,
  WifiNone,
  WifiSlash,
  WifiX,
} from "@phosphor-icons/react";

interface WifiIconProps {
  /** 0–100. Overlay tier: >=75 High, >=50 Medium, >=25 Low, >0 None. */
  signal: number;
  /** When false, the radio is off — show `WifiX` overlay with no signal-base. */
  radioOn: boolean;
  size?: number;
}

/**
 * Single WiFi glyph used by the TopBar chip. Mirrors `SpeakerIcon` and
 * `BatteryIcon`: a dimmed `WifiHigh` base sits underneath, with a
 * full-brightness overlay on top — signal-tier (`High` / `Medium` / `Low`
 * / `None`) when the radio is on, or `WifiX` when the radio is off.
 * `signal === 0` with the radio on renders a lone `WifiSlash` with no
 * base (matches the audio chip's lone `SpeakerX` for muted).
 */
export function WifiIcon({ signal, radioOn, size = 24 }: WifiIconProps) {
  if (radioOn && signal <= 0) {
    return <WifiSlash size={size} weight="bold" />;
  }
  const Overlay = !radioOn
    ? WifiX
    : signal >= 75
      ? WifiHigh
      : signal >= 50
        ? WifiMedium
        : signal >= 25
          ? WifiLow
          : WifiNone;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <WifiHigh size={size} weight="bold" className="absolute inset-0 opacity-40" />
      <Overlay size={size} weight="bold" className="absolute inset-0" />
    </span>
  );
}
