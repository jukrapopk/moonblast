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
