import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface WifiConnection {
  /** Connected SSID. Empty when the radio is on but no network is
   *  associated — the chip still shows in that case. */
  ssid: string;
  /** 0–100. 0 when not connected. */
  signal: number;
  /** True if the AP requires credentials. */
  secured: boolean;
  /** True if a network is currently associated. */
  connected: boolean;
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
}

/**
 * Event-driven WiFi state for the TopBar chip. Replaces the old
 * 30s-tick poll: the wlan service doesn't change state on its own,
 * so we just read on:
 *   - mount (app start)
 *   - window `focus`
 *   - `visibilitychange` to "visible" (user alt-tabs back)
 *   - explicit `refresh()` call (the modal calls this after a
 *     connect/disconnect/radio toggle so the chip reflects the new
 *     state immediately, not on the next user focus).
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
