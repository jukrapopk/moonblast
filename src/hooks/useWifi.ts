import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDebouncedRead } from "./useDebouncedRead";

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
  /** Windows' own internet verdict for the connection, scoped to the WLAN
   *  profile while associated. `internet` is the only "everything works"
   *  value; `constrained` is usually a captive portal (but can be any
   *  header-rewriting middlebox), and `local` / `none` mean no internet.
   *  `null` when it couldn't be read — treated as "unknown", not as offline. */
  connectivity: Connectivity | null;
}

/** `Windows.Networking.Connectivity.NetworkConnectivityLevel`, camelCased. */
export type Connectivity = "internet" | "constrained" | "local" | "none";

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
 * Back-to-back calls collapse to a single IPC (2 s window) — the wlan
 * service doesn't change state that fast, and the previous read's
 * `current` is still fresh.
 *
 * `enabled` (default `true`) suspends mount/focus reads entirely — pass
 * `false` when the WiFi chip is hidden via Customization. `WifiModal`
 * does its own independent fetch/scan on open, so hiding the chip never
 * affects the modal's own live data.
 */
export function useWifi(enabled = true): {
  current: WifiConnection | null | undefined;
  refresh: () => void;
} {
  const [current, setCurrent] = useState<WifiConnection | null | undefined>(undefined);
  const read = useDebouncedRead<WifiConnection | null>("wifi_current", setCurrent, { enabled });
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
 * Join a network Windows already has a profile for. Rejects with netsh's
 * message ("There is no profile … assigned to the specified interface") for
 * anything the OS has never connected to — the modal routes those to the
 * password form or `wifiConnectOpen` instead.
 */
export async function wifiConnect(ssid: string): Promise<void> {
  await invoke("wifi_connect", { ssid });
}

/**
 * First-time join of an open (no-auth) network: registers a profile for it
 * (`connectMode=manual`, so Windows never associates with it on its own) and
 * then connects. `auth` is the scan's raw auth string, used only to tell OWE
 * apart from plain open. If the join fails the Rust side removes the profile
 * again, so the row falls back to its real state instead of reading "Saved".
 */
export async function wifiConnectOpen(ssid: string, auth: string | null): Promise<void> {
  await invoke("wifi_connect_open", { ssid, auth });
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

/** Turn the WiFi radio on or off (same API Windows' own Quick Settings
 *  toggle uses). Can't override a physical hardware kill switch. */
export async function wifiSetRadio(on: boolean): Promise<void> {
  await invoke("wifi_set_radio", { on });
}

/** Outcome of the captive-portal probe (mirrors `net::PortalState`). */
export type PortalState = "internet" | "portal" | "offline" | "unknown";

export interface PortalStatus {
  state: PortalState;
  /** Sign-in URL — the portal's redirect target, or the probe URL itself (the
   *  portal intercepts that host, so it lands on the sign-in page anyway).
   *  `null` when there is nothing to sign into. */
  portalUrl: string | null;
  /** Endpoint that was probed, for display / diagnostics. */
  probeUrl: string;
}

/**
 * One-shot captive-portal probe: an HTTP GET against the same endpoint
 * Windows' own NCSI uses, returning the sign-in URL when something on the
 * network intercepts the answer. Bounded to ~4 s Rust-side, and only worth
 * calling while the modal is open *and* the connection already looks offline
 * (see `WifiModal`) — a healthy network never pays for it.
 */
export async function fetchPortalStatus(): Promise<PortalStatus | null> {
  try {
    return await invoke<PortalStatus>("wifi_portal_status");
  } catch {
    return null;
  }
}

/**
 * Open the portal sign-in page in the user's default browser. The URL comes
 * from a redirect header on the local network, so the Rust side scheme-checks
 * it (http/https only) and bounds the launch — under Auto Immersive Mode a
 * packaged browser's shell activation can otherwise hang forever.
 */
export async function wifiOpenPortal(url: string): Promise<void> {
  await invoke("wifi_open_portal", { url });
}
