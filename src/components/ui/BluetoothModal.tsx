import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Toggle } from "./Toggle";
import { ErrorBanner } from "./ErrorBanner";
import { EmptyMessage } from "./EmptyMessage";
import { SectionLabel } from "./SectionLabel";
import { Spinner } from "./Spinner";
import { LoadingChip } from "./LoadingChip";
import { BluetoothIcon } from "./BluetoothIcon";
import {
  Bluetooth,
  CaretRight,
  Desktop,
  DeviceMobile,
  Headphones,
  Mouse,
} from "@phosphor-icons/react";
import {
  bluetoothForget,
  bluetoothPair,
  bluetoothSetRadio,
  fetchBluetoothPairedDevices,
  useBluetoothScan,
  type BluetoothDevice,
} from "../../hooks/useBluetooth";
import { useContextMenu } from "./ContextMenu";

interface BluetoothModalProps {
  open: boolean;
  onClose: () => void;
  /** `null`/`undefined` covers loading and "no radio" — the modal treats
   *  both as "unknown" and hides the device lists until it resolves. */
  radioOn: boolean | null | undefined;
  /** Called after a radio toggle so the parent's shared subscription
   *  (and the TopBar chip) picks up the new state immediately. */
  onRadioChanged: () => void;
}

function kindIcon(kind: string) {
  switch (kind) {
    case "audio":
      return <Headphones size={20} weight="bold" />;
    case "input":
      return <Mouse size={20} weight="bold" />;
    case "phone":
      return <DeviceMobile size={20} weight="bold" />;
    case "computer":
      return <Desktop size={20} weight="bold" />;
    default:
      return <Bluetooth size={20} weight="bold" />;
  }
}

function DeviceRow({
  device,
  paired,
  onPair,
  onMenu,
  busy,
  anyBusy,
}: {
  device: BluetoothDevice;
  paired: boolean;
  onPair: (id: string) => void;
  onMenu: (e: React.MouseEvent, device: BluetoothDevice, paired: boolean) => void;
  busy: { kind: "pair" | "forget" } | null;
  anyBusy: boolean;
}) {
  const subtitle = busy
    ? busy.kind === "pair"
      ? "Pairing"
      : "Forgetting"
    : paired
      ? device.connected
        ? "Connected"
        : "Paired"
      : null;

  const rowBody = (
    <>
      <span className="flex w-7 shrink-0 items-center justify-center text-(--color-muted)">
        {kindIcon(device.kind)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-(--color-text)">{device.name}</span>
        </div>
        {subtitle && (
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-(--color-muted)">
            {busy && <Spinner size={11} />}
            <span>{subtitle}</span>
          </div>
        )}
      </div>
      {!busy && !paired && (
        <CaretRight size={13} weight="bold" className="shrink-0 text-(--color-muted)" />
      )}
    </>
  );

  if (paired) {
    // No visible action — Windows doesn't expose manual connect/disconnect
    // for arbitrary paired devices either. Forget lives in the context menu.
    return (
      <div
        onContextMenu={(e) => onMenu(e, device, paired)}
        data-context-menu
        data-bt-row={device.id}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${
          device.connected ? "bg-(--color-accent-soft)" : ""
        } ${busy ? "opacity-40" : ""}`}
      >
        {rowBody}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onPair(device.id)}
      onContextMenu={(e) => onMenu(e, device, paired)}
      data-context-menu
      data-bt-row={device.id}
      disabled={anyBusy}
      aria-label={`Pair with ${device.name}`}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors focus:bg-(--color-surface) focus:outline-none disabled:opacity-40"
    >
      {rowBody}
    </button>
  );
}

export function BluetoothModal({ open, onClose, radioOn, onRadioChanged }: BluetoothModalProps) {
  const [paired, setPaired] = useState<BluetoothDevice[]>([]);
  const { devices: other, loading, scan, clear } = useBluetoothScan();
  const [busy, setBusy] = useState<{ id: string; kind: "pair" | "forget" } | null>(null);
  const [radioBusy, setRadioBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const radioKnown = radioOn === true || radioOn === false;
  const radioOff = radioOn === false;

  async function refreshPaired() {
    setPaired(await fetchBluetoothPairedDevices());
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    void refreshPaired();
    if (radioOff) {
      clear();
    } else {
      scan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, radioOff]);

  useEffect(() => {
    if (!open) {
      setBusy(null);
      setRadioBusy(false);
    }
  }, [open]);

  async function handleToggleRadio(next: boolean) {
    setRadioBusy(true);
    setError(null);
    try {
      await bluetoothSetRadio(next);
      onRadioChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setRadioBusy(false);
    }
  }

  async function runAction(id: string, kind: "pair" | "forget", fn: () => Promise<void>) {
    setBusy({ id, kind });
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handlePair(id: string) {
    await runAction(id, "pair", async () => {
      await bluetoothPair(id);
      await refreshPaired();
      await scan();
    });
  }

  async function handleForget(id: string) {
    await runAction(id, "forget", async () => {
      await bluetoothForget(id);
      await refreshPaired();
    });
  }

  const ctx = useContextMenu();
  function openDeviceMenu(e: React.MouseEvent, device: BluetoothDevice, isPaired: boolean) {
    ctx.open(e, [
      isPaired
        ? {
            label: "Forget",
            danger: true,
            disabled: busy !== null,
            onClick: () => void handleForget(device.id),
          }
        : {
            label: "Pair",
            disabled: busy !== null,
            onClick: () => void handlePair(device.id),
          },
    ]);
  }

  const nothingFound = paired.length === 0 && other.length === 0;

  return (
    <Modal open={open} onClose={onClose} title="Bluetooth" width="max-w-sm">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="mb-3 flex items-center justify-between rounded-xl px-1 py-1.5">
        <div className="flex items-center gap-2.5">
          <BluetoothIcon radioOn={radioOn === true} connected={paired.some((d) => d.connected)} size={20} />
          <span className="text-sm font-medium text-(--color-text)">Bluetooth</span>
        </div>
        {radioBusy ? (
          <Spinner size={14} />
        ) : (
          <Toggle
            checked={radioOn === true}
            onChange={(v) => void handleToggleRadio(v)}
            disabled={!radioKnown}
          />
        )}
      </div>

      {radioOff ? (
        <EmptyMessage>Turn Bluetooth on to see devices</EmptyMessage>
      ) : (
        <>
          <div className="max-h-72 space-y-1 overflow-y-auto p-1.5">
            {loading && nothingFound ? (
              <div className="flex items-center justify-center py-4">
                <LoadingChip label="Scanning for devices" variant="plain" />
              </div>
            ) : nothingFound ? (
              <EmptyMessage>No devices found</EmptyMessage>
            ) : (
              <>
                {paired.length > 0 && (
                  <>
                    <SectionLabel>Paired</SectionLabel>
                    {paired.map((d) => (
                      <DeviceRow
                        key={d.id}
                        device={d}
                        paired
                        onPair={handlePair}
                        onMenu={openDeviceMenu}
                        busy={busy && busy.id === d.id ? { kind: busy.kind } : null}
                        anyBusy={busy !== null}
                      />
                    ))}
                  </>
                )}
                {other.length > 0 && (
                  <>
                    <SectionLabel>Other devices</SectionLabel>
                    {other.map((d) => (
                      <DeviceRow
                        key={d.id}
                        device={d}
                        paired={false}
                        onPair={handlePair}
                        onMenu={openDeviceMenu}
                        busy={busy && busy.id === d.id ? { kind: busy.kind } : null}
                        anyBusy={busy !== null}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          <div className="mt-5 flex items-center justify-between gap-2 border-t border-(--color-border) pt-4">
            <Button
              variant="ghost"
              size="md"
              aria-disabled={loading || busy !== null}
              onClick={() => {
                if (loading || busy !== null) return;
                scan();
              }}
              className={`${loading || busy !== null ? "cursor-not-allowed opacity-40" : ""}`}
              icon={<Spinner size={14} spinning={loading} />}
            >
              Rescan
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
