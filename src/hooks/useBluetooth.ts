import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDebouncedRead } from "./useDebouncedRead";

export interface BluetoothRadioStatus {
  /** False when the machine has no Bluetooth radio — the chip stays hidden. */
  supported: boolean;
  on: boolean;
  /** True when at least one paired device is currently connected. */
  connected: boolean;
}

export interface BluetoothDevice {
  /** Opaque WinRT device id — stable, used for pair/forget lookups. */
  id: string;
  name: string;
  connected: boolean;
  /** "audio" | "input" | "phone" | "computer" | "other". */
  kind: string;
}

/**
 * Event-driven Bluetooth radio state for the TopBar chip, mirroring
 * `useWifi`: reads on mount, window `focus`, `visibilitychange` to
 * "visible", and an explicit `refresh()` call (the modal calls this after
 * a radio toggle / pair / forget so the chip reflects the new state
 * immediately).
 */
export function useBluetooth(): {
  status: BluetoothRadioStatus | null | undefined;
  refresh: () => void;
} {
  const [status, setStatus] = useState<BluetoothRadioStatus | null | undefined>(undefined);
  const read = useDebouncedRead<BluetoothRadioStatus | null>("bluetooth_radio_status", setStatus);
  return { status, refresh: read };
}

/** One-shot fetch — the modal uses this to refresh after an action. */
export async function fetchBluetoothRadioStatus(): Promise<BluetoothRadioStatus | null> {
  try {
    return await invoke<BluetoothRadioStatus>("bluetooth_radio_status");
  } catch {
    return null;
  }
}

export async function bluetoothSetRadio(on: boolean): Promise<void> {
  await invoke("bluetooth_set_radio", { on });
}

/** Already-paired devices for the modal's "Paired" section. */
export async function fetchBluetoothPairedDevices(): Promise<BluetoothDevice[]> {
  try {
    return await invoke<BluetoothDevice[]>("bluetooth_paired_devices");
  } catch {
    return [];
  }
}

/** Forget (unpair) a device by id. Idempotent. */
export async function bluetoothForget(id: string): Promise<void> {
  await invoke("bluetooth_forget", { id });
}

/**
 * On-demand discovery scan for the modal's "Other devices" section.
 * Returns an empty array while loading or on failure.
 */
export function useBluetoothScan(): {
  devices: BluetoothDevice[];
  loading: boolean;
  scan: () => Promise<void>;
  clear: () => void;
} {
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [loading, setLoading] = useState(false);
  async function scan() {
    setLoading(true);
    try {
      const list = await invoke<BluetoothDevice[]>("bluetooth_scan");
      setDevices(list);
    } catch {
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }
  function clear() {
    setDevices([]);
  }
  return { devices, loading, scan, clear };
}

/** Pair with a discovered device by id. */
export async function bluetoothPair(id: string): Promise<void> {
  await invoke("bluetooth_pair", { id });
}
