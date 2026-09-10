import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface WifiConnection {
  /** Connected SSID. Empty when not connected. */
  ssid: string;
  /** 0–100. 0 when not connected. */
  signal: number;
  /** True if the AP requires credentials. */
  secured: boolean;
  /** True if a network is currently associated. */
  connected: boolean;
  /** False when the adapter exists but the radio is off — the chip
   *  shows a WifiX icon. Absent (`null` fetch result) means no
   *  adapter, and the chip stays hidden. */
  radioOn: boolean;
}

export interface WifiNetwork {
  ssid: string;
  signal: number;
  secured: boolean;
  /** Raw auth string from the netsh scan, e.g. "WPA2-Personal" or "WEP". */
  auth: string | null;
  connected: boolean;
  /** True if Windows already has a saved profile for this network. */
  known: boolean;
  /** Best WiFi generation advertised by the network (4/5/6/7).
   * `null` when unknown or legacy. Drives the small "6" / "5" badge
   * in the modal row. */
  gen: number | null;
}

/**
 * Event-driven WiFi state for the TopBar chip: the wlan service doesn't
 * change state on its own, so we just read on:
 *   - mount (app start)
 *   - window `focus`
 *   - `visibilitychange` to "visible" (user alt-tabs back)
 *   - explicit `refresh()` call (the modal calls this after a
 *     connect/disconnect so the chip reflects the new state
 *     immediately, not on the next user focus).
 *
 * The wlan service's netsh read takes ~200ms; calling it on focus
 * is cheap.
 */
export function useWifi(): {
  current: WifiConnection | null | undefined;
  refresh: () => void;
} {
  const [current, setCurrent] = useState<WifiConnection | null | undefined>(undefined);
  // In-flight read — multiple concurrent calls (e.g. focus + visibility
  // firing on the same refocus) share a single in-flight Promise
  // instead of issuing multiple Rust invocations. Resolves to void; the
  // value is the same `current` state set inside the single read.
  const inFlight = useRef<Promise<void> | null>(null);
  // Last successful read timestamp (ms). Back-to-back events within 2s
  // collapse to one read — the wlan service doesn't change state that
  // fast, and the previous read's `current` is still fresh.
  const lastReadAt = useRef(0);

  const read = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const now = Date.now();
    if (now - lastReadAt.current < 2000) return;
    lastReadAt.current = now;
    const p = (async () => {
      try {
        const c = await invoke<WifiConnection | null>("wifi_current");
        setCurrent(c);
      } catch {
        setCurrent(null);
      }
    })();
    inFlight.current = p;
    try {
      await p;
    } finally {
      inFlight.current = null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const safeRead = () => {
      if (alive) void read();
    };
    safeRead();
    function onFocus() {
      safeRead();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") safeRead();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [read]);

  return { current, refresh: read };
}

/**
 * One-shot fetch of the current connection. The event-driven hook above
 * is for continuous monitoring; the modal uses this to refresh its
 * header after connect/disconnect.
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
  clear: () => void;
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
  function clear() {
    setNetworks([]);
  }
  return { networks, loading, scan, clear };
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

/**
 * Connect to a secured network that needs a fresh password. `auth` is
 * the raw string from the netsh scan, e.g. "WPA2-Personal", "WEP".
 * On success the profile is saved so the network shows up as
 * "Saved" in subsequent scans.
 */
export async function wifiConnectWithPassword(
  ssid: string,
  password: string,
  auth: string,
): Promise<void> {
  await invoke("wifi_connect_with_password", { ssid, password, auth });
}

/** Disconnect from the current network. No-op if already disconnected. */
export async function wifiDisconnect(): Promise<void> {
  await invoke("wifi_disconnect");
}

/** Delete a saved profile ("forget" the network). No-op if none exists. */
export async function wifiForget(ssid: string): Promise<void> {
  await invoke("wifi_forget", { ssid });
}

/**
 * Open the Windows Wi-Fi settings app. Radio on/off lives there —
 * toggling it from Moonblast needs elevation.
 */
export async function openWifiSettings(): Promise<void> {
  await invoke("open_wifi_settings");
}
