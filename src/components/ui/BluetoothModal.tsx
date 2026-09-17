import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Toggle } from "./Toggle";
import { ErrorBanner } from "./ErrorBanner";
import { EmptyMessage } from "./EmptyMessage";
import { Spinner } from "./Spinner";
import { LoadingChip } from "./LoadingChip";
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
  fetchBluetoothRadioStatus,
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
    // for arbitrary paired devices either. Forget lives in the context
    // menu, reached here via right-click or the Shift+F10 / ContextMenu
    // keyboard shortcut — both need the row to be focusable, so it still
    // gets a tabIndex despite having no click action of its own.
    return (
      <div
        tabIndex={0}
        onContextMenu={(e) => onMenu(e, device, paired)}
        data-context-menu
        data-bt-row={device.id}
        aria-label={`${device.name}, ${device.connected ? "connected" : "paired"}`}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 outline-none focus-visible:bg-(--color-surface) ${
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

  // Local copy of the radio state so the toggle reflects a just-performed
  // change immediately. Seeded from the parent's shared subscription on
  // open, but refreshed with a direct one-shot fetch (bypassing that
  // subscription's `useDebouncedRead` 2s collapse window) after every
  // toggle here — mirrors WifiModal's `liveSsid`. Without this, toggling
  // shortly after open (well within 2s of the open-triggered refresh)
  // silently collapsed with the earlier read and the switch never
  // visually updated, even though the radio itself did flip.
  const [liveOn, setLiveOn] = useState<boolean | null>(radioOn ?? null);
  useEffect(() => {
    if (open) setLiveOn(radioOn ?? null);
  }, [open, radioOn]);

  const radioKnown = liveOn === true || liveOn === false;
  const radioOff = liveOn === false;

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
      const status = await fetchBluetoothRadioStatus();
      setLiveOn(status?.on ?? next);
      // Nudge the parent's shared subscription too, so the TopBar chip
      // catches up — its own debounce/cadence is fine for a background
      // chip, unlike this modal's own toggle which needs to be exact.
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

  // Single unified list, mirroring the Wifi modal: connected first, then
  // paired-but-not-connected, then everything else (discovered/unpaired),
  // alphabetical within each tier. Dedupe by id — a device shouldn't
  // normally appear in both buckets (scan only surfaces unpaired
  // devices), but the paired entry wins if it ever does.
  const merged: (BluetoothDevice & { paired: boolean })[] = (() => {
    const byId = new Map<string, BluetoothDevice & { paired: boolean }>();
    for (const d of paired) byId.set(d.id, { ...d, paired: true });
    for (const d of other) {
      if (!byId.has(d.id)) byId.set(d.id, { ...d, paired: false });
    }
    return Array.from(byId.values()).sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      if (a.paired !== b.paired) return a.paired ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  })();

  const nothingFound = merged.length === 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bluetooth"
      width="max-w-sm"
      headerAction={
        radioBusy ? (
          <Spinner size={14} />
        ) : (
          <Toggle
            checked={liveOn === true}
            onChange={(v) => void handleToggleRadio(v)}
            disabled={!radioKnown}
          />
        )
      }
    >
      {error && <ErrorBanner>{error}</ErrorBanner>}

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
              merged.map((d) => (
                <DeviceRow
                  key={d.id}
                  device={d}
                  paired={d.paired}
                  onPair={handlePair}
                  onMenu={openDeviceMenu}
                  busy={busy && busy.id === d.id ? { kind: busy.kind } : null}
                  anyBusy={busy !== null}
                />
              ))
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
