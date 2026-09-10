import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Toggle } from "./Toggle";
import {
  WifiHigh,
  WifiLow,
  WifiMedium,
  WifiNone,
  WifiSlash,
  Lock,
  ArrowsClockwise,
  ArrowsOutSimple,
} from "@phosphor-icons/react";
import {
  fetchWifiCurrent,
  useWifiScan,
  wifiConnect,
  wifiDisconnect,
  wifiRadioGet,
  wifiRadioSet,
  type WifiNetwork,
} from "../../hooks/useWifi";

/**
 * Poll the OS up to `timeoutMs` waiting for the connection state to
 * settle to the expected value. The wlan service can take a few
 * seconds to actually apply connect/disconnect, and reading it
 * before that gives a stale view.
 */
async function waitForState(
  expected: string | null,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await fetchWifiCurrent();
    if (expected === null ? c === null : c?.ssid === expected) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

interface WifiModalProps {
  open: boolean;
  onClose: () => void;
  /** SSID of the currently connected network, or null if disconnected. */
  currentSsid: string | null;
}

function signalIcon(signal: number) {
  const weight = "bold" as const;
  if (signal >= 75) return <WifiHigh size={16} weight={weight} />;
  if (signal >= 50) return <WifiMedium size={16} weight={weight} />;
  if (signal >= 25) return <WifiLow size={16} weight={weight} />;
  if (signal > 0) return <WifiNone size={16} weight={weight} />;
  return <WifiSlash size={16} weight={weight} />;
}

function signalTone(signal: number) {
  if (signal >= 50) return "text-(--color-text)";
  if (signal >= 25) return "text-(--color-muted)";
  return "text-(--color-danger)";
}

function NetworkRow({
  net,
  currentSsid,
  onConnect,
  onDisconnect,
  busy,
}: {
  net: WifiNetwork;
  currentSsid: string | null;
  onConnect: (ssid: string) => void;
  onDisconnect: () => void;
  busy: boolean;
}) {
  const isCurrent = currentSsid === net.ssid && net.connected;
  const needsSignIn = net.secured && !net.known;

  const rowBody = (
    <>
      <span className={`${signalTone(net.signal)} flex w-5 shrink-0 items-center justify-center`}>
        {signalIcon(net.signal)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-(--color-text)">{net.ssid}</span>
        </div>
        {(isCurrent || net.known) && (
          <div className="mt-0.5 text-xs text-(--color-muted)">
            {isCurrent ? "Connected" : "Saved"}
          </div>
        )}
      </div>
      {/* Decorative icon — shows the user what kind of network this row
          is (saved vs. needs sign-in). The whole row is the click target. */}
      {!isCurrent && needsSignIn && (
        <Lock size={13} weight="bold" className="shrink-0 text-(--color-muted)" />
      )}
      {!isCurrent && !needsSignIn && net.known && (
        <ArrowsOutSimple size={13} weight="bold" className="rotate-[-90deg] shrink-0 text-(--color-muted)" />
      )}
      {isCurrent && (
        <Button
          variant="outline"
          size="md"
          onClick={onDisconnect}
          disabled={busy}
          className="px-3 py-1 text-xs"
        >
          Disconnect
        </Button>
      )}
    </>
  );

  // For the connected row, keep the existing click-to-disconnect only on
  // the Disconnect button (not the whole row). For all other rows, the
  // whole row is the action — click anywhere to connect / sign in.
  if (isCurrent) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-(--color-accent-soft) px-3 py-2.5">
        {rowBody}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onConnect(net.ssid)}
      disabled={busy}
      aria-label={needsSignIn ? `Sign in to ${net.ssid}` : `Connect to ${net.ssid}`}
      title={needsSignIn ? "Sign in (opens Wi-Fi settings)" : "Connect"}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-(--color-surface) focus:bg-(--color-surface) focus:outline-none disabled:opacity-40"
    >
      {rowBody}
    </button>
  );
}

export function WifiModal({ open, onClose, currentSsid }: WifiModalProps) {
  const { networks, loading, scan } = useWifiScan();
  const [busy, setBusy] = useState<null | "connect" | "disconnect" | "radio">(null);
  const [error, setError] = useState<string | null>(null);
  const [radioOn, setRadioOn] = useState<boolean | null>(null);
  // Local copy of the current SSID so connect/disconnect reflect
  // immediately, without waiting for the parent chip's 30s poll.
  // Seeded from the prop on open; re-fetched from the OS after every
  // connect/disconnect so the modal reflects the real state.
  const [liveSsid, setLiveSsid] = useState<string | null>(currentSsid);
  useEffect(() => {
    if (open) setLiveSsid(currentSsid);
  }, [open, currentSsid]);

  useEffect(() => {
    if (!open) return;
    scan();
    setError(null);
    // Probe the radio state so the toggle reflects reality.
    void wifiRadioGet()
      .then((v) => setRadioOn(v ?? true))
      .catch(() => setRadioOn(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleConnect(ssid: string) {
    setBusy("connect");
    setError(null);
    try {
      await wifiConnect(ssid);
      // The connect command may take a few seconds to actually take
      // effect; poll the OS a few times to wait for the state to land
      // before refreshing the modal.
      await waitForState(ssid);
      // Refresh the scan to update the `connected` flag.
      await scan();
      const c = await fetchWifiCurrent();
      setLiveSsid(c?.ssid ?? null);
    } catch (e) {
      const msg = String(e);
      setError(msg);
      // netsh can't connect to a secured network without a saved profile.
      // Surface a hint and open the Windows WiFi settings so the user can
      // enter the password. (Same fallback the modal footer used to have.)
      if (/profile/i.test(msg)) {
        await invoke("opener:open", { path: "ms-settings:network-wifi" }).catch(() => {});
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect() {
    setBusy("disconnect");
    setError(null);
    try {
      await wifiDisconnect();
      // The disconnect command may also be async on the wlan service;
      // poll briefly so the modal reflects the real state.
      await waitForState(null);
      await scan();
      const c = await fetchWifiCurrent();
      setLiveSsid(c?.ssid ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleRadioToggle(next: boolean) {
    setBusy("radio");
    setError(null);
    try {
      const result = await wifiRadioSet(next);
      setRadioOn(result ?? next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="WiFi" width="max-w-sm">
      {error && (
        <p className="mb-3 rounded-lg border border-(--color-danger)/30 bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </p>
      )}

      <div className="max-h-72 space-y-1 overflow-y-auto">
        {loading && networks.length === 0 ? (
          <p className="py-6 text-center text-sm text-(--color-muted)">Scanning…</p>
        ) : networks.length === 0 ? (
          <p className="py-6 text-center text-sm text-(--color-muted)">
            No networks found. {radioOn === false ? "Wi-Fi is off — turn it on to scan." : "Make sure WiFi is on and try again."}
          </p>
        ) : (
          networks.map((net) => (
            <NetworkRow
              key={net.ssid}
              net={net}
              currentSsid={liveSsid}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              busy={busy === "connect"}
            />
          ))
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-(--color-border) pt-3">
        <Button
          variant="ghost"
          size="md"
          onClick={scan}
          disabled={loading || busy !== null}
          icon={<ArrowsClockwise size={14} weight="bold" className={loading ? "animate-spin" : ""} />}
        >
          Rescan
        </Button>
        <Toggle
          checked={radioOn ?? true}
          onChange={handleRadioToggle}
          disabled={busy !== null}
        />
      </div>
    </Modal>
  );
}
