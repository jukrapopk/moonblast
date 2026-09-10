import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface WifiConnection {
  /** Connected SSID. */
  ssid: string;
  /** 0–100. */
  signal: number;
  /** True if the AP requires credentials. */
  secured: boolean;
}

export interface WifiNetwork {
  ssid: string;
  signal: number;
  secured: boolean;
  connected: boolean;
  /** True if Windows already has a saved profile for this network. */
  known: boolean;
}

/**
 * Cheap, periodic poll of the current WiFi connection for the TopBar chip.
 * `null` means "no WiFi adapter" (the chip hides), `undefined` means
 * "loading" (the chip doesn't render yet).
 */
export function useWifi(intervalMs = 30_000): WifiConnection | null | undefined {
  const [current, setCurrent] = useState<WifiConnection | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    async function read() {
      try {
        const c = await invoke<WifiConnection | null>("wifi_current");
        if (alive) setCurrent(c);
      } catch {
        if (alive) setCurrent(null);
      }
    }
    void read();
    const id = setInterval(read, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
  return current;
}

/**
 * One-shot fetch of the current connection. The polling hook above is for
 * continuous monitoring; the modal uses this to refresh its header after
 * connect/disconnect so the UI doesn't wait for the next 30s tick.
 */
export async function fetchWifiCurrent(): Promise<WifiConnection | null> {
  try {
    return await invoke<WifiConnection | null>("wifi_current");
  } catch {
    return null;
  }
}

/**
 * On-demand scan for the picker modal. Returns an empty array while loading,
 * an empty array if the scan failed (no WiFi / no permission), or the
 * deduped + sorted list of visible networks.
 */
export function useWifiScan(): {
  networks: WifiNetwork[];
  loading: boolean;
  scan: () => void;
} {
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [loading, setLoading] = useState(false);
  async function scan() {
    setLoading(true);
    try {
      const list = await invoke<WifiNetwork[]>("wifi_scan");
      setNetworks(list);
    } catch {
      setNetworks([]);
    } finally {
      setLoading(false);
    }
  }
  return { networks, loading, scan };
}

/**
 * Connect to a network by SSID. Resolves on success; rejects with the
 * netsh error message (e.g. "no wireless network profile" for secured
 * networks the user has never connected to — the UI should fall back
 * to opening Windows WiFi settings in that case).
 */
export async function wifiConnect(ssid: string): Promise<void> {
  await invoke("wifi_connect", { ssid });
}

/** Disconnect from the current network. No-op if already disconnected. */
export async function wifiDisconnect(): Promise<void> {
  await invoke("wifi_disconnect");
}

/**
 * Enable (`true`) or disable (`false`) the WiFi radio. Returns the new
 * state as reported by the OS — `null` if the adapter isn't reachable.
 */
export async function wifiRadioSet(enabled: boolean): Promise<boolean | null> {
  return await invoke<boolean | null>("wifi_radio_set", { enabled });
}

/** Read the current WiFi radio state. `true` = on, `false` = off. */
export async function wifiRadioGet(): Promise<boolean | null> {
  return await invoke<boolean | null>("wifi_radio_get");
}
