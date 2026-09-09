import { useEffect } from "react";
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
} from "@phosphor-icons/react";
import { useWifiScan, type WifiNetwork } from "../../hooks/useWifi";

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

function NetworkRow({ net, currentSsid }: { net: WifiNetwork; currentSsid: string | null }) {
  const isCurrent = currentSsid === net.ssid && net.connected;
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
          {isCurrent ? "Connected" : net.known ? "Saved" : `${net.signal}%`}
        </div>
      </div>
      {isCurrent && (
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-(--color-accent)">
          <Check size={14} weight="bold" />
        </span>
      )}
    </div>
  );
}

export function WifiModal({ open, onClose, currentSsid }: WifiModalProps) {
  const { networks, loading, scan } = useWifiScan();
  useEffect(() => {
    if (open) scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="WiFi" subtitle={currentSsid ?? "Not connected"} width="max-w-sm">
      <div className="mb-3 flex justify-end">
        <Button
          variant="ghost"
          size="md"
          onClick={scan}
          disabled={loading}
          icon={<ArrowsClockwise size={14} weight="bold" className={loading ? "animate-spin" : ""} />}
        >
          Rescan
        </Button>
      </div>
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {loading && networks.length === 0 ? (
          <p className="py-6 text-center text-sm text-(--color-muted)">Scanning…</p>
        ) : networks.length === 0 ? (
          <p className="py-6 text-center text-sm text-(--color-muted)">
            No networks found. Make sure WiFi is on and try again.
          </p>
        ) : (
          networks.map((net) => <NetworkRow key={net.ssid} net={net} currentSsid={currentSsid} />)
        )}
      </div>
      <p className="mt-4 text-xs text-(--color-muted)">
        To connect to a new network or enter a password, open the Windows WiFi settings.
      </p>
    </Modal>
  );
}
