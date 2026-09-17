import { Bluetooth, BluetoothConnected, BluetoothX } from "@phosphor-icons/react";

interface BluetoothIconProps {
  /** Radio on/off. When false, shows `BluetoothX` regardless of `connected`. */
  radioOn: boolean;
  /** True when at least one paired device is currently connected. */
  connected: boolean;
  size?: number;
}

/**
 * Single Bluetooth glyph used by the TopBar chip. Same family as
 * `WifiIcon` / `BatteryIcon` / `SpeakerIcon`: a dimmed base sits
 * underneath, with a full-brightness overlay glyph on top for state —
 * `BluetoothConnected` when a device is connected, `Bluetooth` otherwise,
 * or a lone `BluetoothX` (no base) when the radio is off.
 */
export function BluetoothIcon({ radioOn, connected, size = 24 }: BluetoothIconProps) {
  if (!radioOn) {
    return <BluetoothX size={size} weight="bold" />;
  }
  const Overlay = connected ? BluetoothConnected : Bluetooth;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <Bluetooth size={size} weight="bold" className="absolute inset-0 opacity-40" />
      <Overlay size={size} weight="bold" className="absolute inset-0" />
    </span>
  );
}
