import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDebouncedRead } from "./useDebouncedRead";
import { isForeground } from "./foreground";

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

/** How long a "connected but no internet" verdict must settle before the chip
 *  is allowed to act on it. `NetworkConnectivityLevel` is NCSI's cached hint,
 *  and NCSI classifies a fresh association *asynchronously*: a read taken in
 *  that window reports `LocalAccess` / `ConstrainedInternetAccess` on a
 *  perfectly good network. The chip is event-driven (mount / focus / explicit
 *  refresh), so without a hold-back a single lagging sample would pin the
 *  warning on until the next focus. */
const CONNECTIVITY_SETTLE_MS = 4000;

/** `NetworkConnectivityLevel` values that mean "connected, but not online". */
function isNoInternet(c: Connectivity): boolean {
  return c === "constrained" || c === "local" || c === "none";
}

/**
 * Confirm Windows' "no internet" verdict before the chip acts on it.
 *
 * The level is only a hint, so a non-`internet` verdict is held back for
 * `CONNECTIVITY_SETTLE_MS` and then re-checked: a fresh level read first (a
 * recovered level clears the suspicion for free), and if that is still bad, the
 * same active probe the Wi-Fi modal uses. The probe is the authority — if the
 * NCSI endpoint answered correctly the level was simply lagging, so the chip
 * stays normal; otherwise (a portal, a genuine outage, or active probing being
 * disabled) the warning stands. Healthy networks never probe, because the cheap
 * level gates it, and a probe is only ever issued on the idle→suspect
 * transition, so a persistent condition can't turn this into a poll.
 */
function useConfirmedOffline(raw: WifiConnection | null | undefined): boolean {
  const [offline, setOffline] = useState(false);
  // One-shot state machine, keyed by SSID so a connection change restarts it.
  const phase = useRef<
    | { kind: "idle" }
    | { kind: "suspect"; ssid: string }
    | { kind: "confirming"; ssid: string }
    | { kind: "offline"; ssid: string }
  >({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const confirm = useCallback(async (ssid: string) => {
    phase.current = { kind: "confirming", ssid };
    const stale = () => phase.current.kind !== "confirming" || phase.current.ssid !== ssid;
    // Network I/O is foreground-only, like every other read. If we've slipped
    // into the background, bail — the focus refresh starts a fresh suspicion
    // on return.
    if (!isForeground()) {
      phase.current = { kind: "idle" };
      return;
    }
    // Fresh cheap read first: a recovered level (or a changed connection)
    // clears the suspicion without paying for a probe.
    const c = await fetchWifiCurrent();
    if (stale()) return;
    if (
      !c ||
      !c.connected ||
      c.ssid !== ssid ||
      c.connectivity === null ||
      c.connectivity === "internet"
    ) {
      phase.current = { kind: "idle" };
      setOffline(false);
      return;
    }
    // The level is still bad — ask the active probe, the authority.
    const s = await fetchPortalStatus();
    if (stale()) return;
    if (s?.state === "internet") {
      phase.current = { kind: "idle" };
      setOffline(false);
    } else {
      phase.current = { kind: "offline", ssid };
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    const c = raw;
    const suspect = !!c && c.connected && c.connectivity !== null && isNoInternet(c.connectivity);
    if (!suspect) {
      clearTimer();
      phase.current = { kind: "idle" };
      setOffline(false);
      return;
    }
    const ssid = c!.ssid;
    const ph = phase.current;
    // Already tracking this connection — the timer / probe owns the verdict.
    if (ph.kind !== "idle" && ph.ssid === ssid) return;
    // New suspicion: hold the verdict back until it settles.
    clearTimer();
    phase.current = { kind: "suspect", ssid };
    setOffline(false);
    timer.current = setTimeout(() => {
      timer.current = null;
      void confirm(ssid);
    }, CONNECTIVITY_SETTLE_MS);
  }, [raw, clearTimer, confirm]);

  // Cancel any pending confirmation on unmount.
  useEffect(() => clearTimer, [clearTimer]);

  return offline;
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
 * `connectivity` is Windows' hint, so a non-`internet` value is only surfaced
 * once `useConfirmedOffline` has confirmed it (see there). Until then it is
 * presented as `null` (unknown), which the chip never warns about — otherwise
 * a lagging sample on a healthy network would flash the "sign in required"
 * state.
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
  const [raw, setRaw] = useState<WifiConnection | null | undefined>(undefined);
  const read = useDebouncedRead<WifiConnection | null>("wifi_current", setRaw, { enabled });
  const offline = useConfirmedOffline(raw);
  // Present the raw verdict only once it's confirmed; while a non-`internet`
  // level is still settling, expose it as `null` (unknown) so the chip's
  // `connectivity !== "internet"` warning can't fire on a transient.
  const current = useMemo(() => {
    if (!raw || raw.connectivity === null || raw.connectivity === "internet") return raw;
    return offline ? raw : { ...raw, connectivity: null };
  }, [raw, offline]);
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
