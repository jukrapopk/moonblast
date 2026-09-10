import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { Button } from "./Button";
import {
  WifiHigh,
  WifiLow,
  WifiMedium,
  WifiNone,
  WifiSlash,
  Lock,
  Check,
  ArrowsClockwise,
  ArrowsOutSimple,
  Power,
} from "@phosphor-icons/react";
import {
  useWifiScan,
  wifiConnect,
  wifiDisconnect,
  wifiRadioGet,
  wifiRadioSet,
  type WifiNetwork,
} from "../../hooks/useWifi";

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
  busy,
}: {
  net: WifiNetwork;
  currentSsid: string | null;
  onConnect: (ssid: string) => void;
  busy: boolean;
}) {
  const isCurrent = currentSsid === net.ssid && net.connected;
  const needsPassword = net.secured && !net.known && !isCurrent;
  return (
    <div
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
        isCurrent ? "bg-(--color-accent-soft)" : "hover:bg-(--color-surface)"
      }`}
    >
      <span className={`${signalTone(net.signal)} flex w-5 shrink-0 items-center justify-center`}>
        {signalIcon(net.signal)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-(--color-text)">{net.ssid}</span>
          {net.secured && <Lock size={12} weight="bold" className="shrink-0 text-(--color-muted)" />}
        </div>
        <div className="mt-0.5 text-xs text-(--color-muted)">
          {isCurrent ? "Connected" : needsPassword ? "Tap to sign in" : net.known ? "Saved" : `${net.signal}%`}
        </div>
      </div>
      {isCurrent ? (
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-(--color-accent)">
          <Check size={14} weight="bold" />
        </span>
      ) : (
        <button
          onClick={() => onConnect(net.ssid)}
          disabled={busy}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-(--color-muted) transition-colors hover:bg-(--color-surface-2) hover:text-(--color-text) disabled:opacity-40"
          aria-label={`Connect to ${net.ssid}`}
          title={needsPassword ? "Sign in (opens Wi-Fi settings)" : "Connect"}
        >
          {needsPassword ? (
            <Lock size={13} weight="bold" />
          ) : (
            <ArrowsOutSimple size={13} weight="bold" className="rotate-[-90deg]" />
          )}
        </button>
      )}
    </div>
  );
}

export function WifiModal({ open, onClose, currentSsid }: WifiModalProps) {
  const { networks, loading, scan } = useWifiScan();
  const [busy, setBusy] = useState<null | "connect" | "disconnect" | "radio">(null);
  const [error, setError] = useState<string | null>(null);
  const [radioOn, setRadioOn] = useState<boolean | null>(null);

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
      // Refresh the scan to update the `connected` flag.
      setTimeout(() => scan(), 800);
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
      setTimeout(() => scan(), 500);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleRadioToggle() {
    const next = !(radioOn ?? true);
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
    <Modal open={open} onClose={onClose} title="WiFi" subtitle={currentSsid ?? "Not connected"} width="max-w-sm">
      {currentSsid && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-(--color-accent-soft) px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Check size={14} weight="bold" className="shrink-0 text-(--color-accent)" />
              <span className="truncate text-sm font-medium text-(--color-text)">{currentSsid}</span>
            </div>
            <div className="mt-0.5 ml-6 text-xs text-(--color-muted)">Connected</div>
          </div>
          <Button
            variant="outline"
            size="md"
            onClick={handleDisconnect}
            disabled={busy !== null}
            className="px-3 py-1 text-xs"
          >
            Disconnect
          </Button>
        </div>
      )}

      <div className="mb-3 flex justify-end">
        <Button
          variant="ghost"
          size="md"
          onClick={scan}
          disabled={loading || busy !== null}
          icon={<ArrowsClockwise size={14} weight="bold" className={loading ? "animate-spin" : ""} />}
        >
          Rescan
        </Button>
      </div>

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
              currentSsid={currentSsid}
              onConnect={handleConnect}
              busy={busy === "connect"}
            />
          ))
        )}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-(--color-border) pt-3">
        <span className="text-xs text-(--color-muted)">Wi-Fi radio</span>
        <button
          onClick={handleRadioToggle}
          disabled={busy !== null}
          className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors ${
            (radioOn ?? true)
              ? "bg-(--color-accent) text-white"
              : "bg-(--color-surface-2) text-(--color-muted)"
          } disabled:opacity-40`}
          aria-label={(radioOn ?? true) ? "Turn Wi-Fi off" : "Turn Wi-Fi on"}
        >
          <Power size={12} weight="bold" />
          {(radioOn ?? true) ? "On" : "Off"}
        </button>
      </div>
    </Modal>
  );
}
