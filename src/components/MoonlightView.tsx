import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Plus, Play, LockKey, Monitor, Trash, GameController, ArrowsClockwise } from "@phosphor-icons/react";
import { MoonlightSettings } from "./MoonlightSettings";
import { PageShell } from "./PageShell";
import { Modal } from "./ui/Modal";
import { Segmented } from "./ui/Segmented";
import { Toast } from "./ui/Toast";
import { useSettings } from "../settings/SettingsContext";

interface Host {
  name: string;
  address: string;
}

interface DiscoveredHost {
  hostname: string;
  name: string;
  address: string;
  paired: boolean;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 mt-2 text-sm font-semibold uppercase tracking-wider text-(--color-muted)">{children}</h2>;
}

function MachineCard({
  host,
  onApps,
  onPair,
  onRemove,
  busy,
}: {
  host: Host;
  onApps: () => void;
  onPair: () => void;
  onRemove: () => void;
  busy: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex items-center gap-4 rounded-2xl border border-(--color-border) bg-(--color-surface) p-4"
    >
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white/80"
        style={{ background: "linear-gradient(135deg,#31416b,#2b3a5e)" }}
      >
        <Monitor size={22} weight="bold" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-(--color-text)">{host.name}</div>
        <div className="mt-0.5 truncate text-xs text-(--color-muted)">{host.address}</div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={onPair}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-full border border-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent) transition enabled:hover:bg-(--color-accent-soft) disabled:opacity-40"
        >
          <LockKey size={14} weight="bold" />
          Pair
        </button>
        <button
          onClick={onApps}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-white transition enabled:hover:brightness-110 disabled:opacity-40"
        >
          <GameController size={14} weight="bold" />
          Apps
        </button>
        <button
          onClick={onRemove}
          title="Remove"
          aria-label="Remove"
          className="flex h-9 w-9 items-center justify-center rounded-full text-(--color-muted) transition hover:text-(--color-danger)"
        >
          <Trash size={16} weight="bold" />
        </button>
      </div>
    </motion.div>
  );
}

/* ------------------------------ Discovered ------------------------------ */

function DiscoveredCard({
  host,
  onApps,
  onPair,
  onDesktop,
  busy,
}: {
  host: DiscoveredHost;
  onApps: () => void;
  onPair: () => void;
  onDesktop: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-(--color-border) bg-(--color-surface) p-4">
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white/80"
        style={{ background: "linear-gradient(135deg,#31416b,#2b3a5e)" }}
      >
        <Monitor size={22} weight="bold" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-(--color-text)">{host.name}</span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
              host.paired
                ? "bg-(--color-accent-soft) text-(--color-accent)"
                : "bg-(--color-muted-soft) text-(--color-muted)"
            }`}
          >
            {host.paired ? "Paired" : "Not paired"}
          </span>
        </div>
        <div className="mt-0.5 truncate text-xs text-(--color-muted)">{host.address}</div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {host.paired ? (
          <>
            <button
              onClick={onDesktop}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-2 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-40"
            >
              <Play size={15} weight="fill" />
              Desktop
            </button>
            <button
              onClick={onApps}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full border border-(--color-border) px-3 py-2 text-sm font-medium text-(--color-muted) transition enabled:hover:text-(--color-text) disabled:opacity-40"
            >
              <GameController size={14} weight="bold" />
              Apps
            </button>
          </>
        ) : (
          <button
            onClick={onPair}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full border border-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent) transition enabled:hover:bg-(--color-accent-soft) disabled:opacity-40"
          >
            <LockKey size={14} weight="bold" />
            Pair
          </button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Add machine ----------------------------- */

function AddMachineModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (host: Host) => void;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setAddress("");
    }
  }, [open]);

  function submit() {
    const addr = address.trim();
    if (!addr) return;
    onAdd({ name: name.trim() || addr, address: addr });
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add machine"
      subtitle="Enter the address of your Sunshine host."
    >
      <div className="space-y-3">
        <input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Name (optional)"
          className="h-11 w-full rounded-xl border border-(--color-border) bg-(--color-surface) px-4 text-sm text-(--color-text) outline-none transition placeholder:text-(--color-muted) focus:border-(--color-accent)"
        />
        <input
          autoFocus
          value={address}
          onChange={(e) => setAddress(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="e.g. 192.168.1.20"
          className="h-11 w-full rounded-xl border border-(--color-border) bg-(--color-surface) px-4 text-sm text-(--color-text) outline-none transition placeholder:text-(--color-muted) focus:border-(--color-accent)"
        />
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-full px-4 py-2 text-sm text-(--color-muted) transition hover:text-(--color-text)"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!address.trim()}
            className="rounded-full bg-(--color-accent) px-5 py-2 text-sm font-medium text-white transition enabled:hover:brightness-110 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------- Apps picker ---------------------------- */

function AppsModal({
  open,
  onClose,
  host,
  onPlay,
}: {
  open: boolean;
  onClose: () => void;
  host: Host | null;
  onPlay: (app: string) => void;
}) {
  const [apps, setApps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !host) return;
    let alive = true;
    setApps([]);
    setError(null);
    invoke<string[]>("moonlight_list_apps", { host: host.address })
      .then((list) => {
        if (alive) setApps(list);
      })
      .catch((err) => {
        if (alive) setError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [open, host]);

  return (
    <Modal open={open} onClose={onClose} title={host ? `${host.name}` : ""} subtitle="Choose an app to stream.">
      {error ? (
        <p className="py-4 text-sm text-(--color-danger)">
          {error}
          <span className="mt-1 block text-(--color-muted)">
            It may need pairing first — press Pair on the machine.
          </span>
        </p>
      ) : apps.length === 0 ? (
        <p className="py-6 text-center text-sm text-(--color-muted)">
          {error ? "Couldn't load apps." : "Loading apps…"}
        </p>
      ) : (
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {apps.map((app) => (
            <button
              key={app}
              onClick={() => onPlay(app)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-base font-medium text-(--color-text) transition-colors hover:bg-(--color-surface)"
            >
              <Play size={16} weight="bold" />
              {app}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------- Main view ------------------------------- */

export function MoonlightView() {
  const { settings, update } = useSettings();
  const machines = settings.machines;
  const [sub, setSub] = useState<"machines" | "settings">("machines");
  const [addOpen, setAddOpen] = useState(false);
  const [appsHost, setAppsHost] = useState<Host | null>(null);
  const [busyAddress, setBusyAddress] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredHost[]>([]);
  const [scanning, setScanning] = useState(false);
  const pairingRef = useRef<string | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const list = await invoke<DiscoveredHost[]>("discover_hosts");
      setDiscovered(list);
    } catch {
      // ignore discovery errors
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (sub === "machines") scan();
  }, [sub, scan]);

  // When a pairing session completes, refresh once instead of polling.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ host: string; success: boolean }>("pair-complete", (event) => {
      const { host, success } = event.payload;
      if (pairingRef.current === host) {
        pairingRef.current = null;
        setBusyAddress(null);
        scan();
        showToast(success ? `Paired with ${host}` : `Pairing ${host} failed`);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [scan]);

  function showToast(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 2500);
  }

  function addHost(host: Host) {
    update((s) => ({ ...s, machines: [...s.machines, host] }));
  }

  function removeHost(address: string) {
    update((s) => ({ ...s, machines: s.machines.filter((m) => m.address !== address) }));
  }

  async function pair(host: Host) {
    pairingRef.current = host.address;
    setBusyAddress(host.address);
    showToast(`Pairing ${host.name}…`);
    try {
      await invoke("moonlight_pair", { host: host.address });
    } catch (err) {
      pairingRef.current = null;
      setBusyAddress(null);
      showToast(String(err));
    }
  }

  async function streamDesktop(host: Host) {
    try {
      await invoke("moonlight_stream", { host: host.address, app: "Desktop" });
      showToast(`Streaming ${host.name} Desktop…`);
    } catch (err) {
      showToast(String(err));
    }
  }

  async function playApp(host: Host, app: string) {
    try {
      await invoke("moonlight_stream", { host: host.address, app });
      showToast(`Streaming ${app}…`);
    } catch (err) {
      showToast(String(err));
    }
  }

  return (
    <>
      <PageShell
        title="Moonlight"
        subtitle="Your streaming hosts."
        actions={
          sub === "machines" ? (
            <div className="flex items-center gap-2">
              <button
                onClick={scan}
                disabled={scanning}
                className="flex h-9 items-center gap-1.5 rounded-full border border-(--color-border) bg-(--color-surface) px-4 text-sm font-medium text-(--color-muted) transition enabled:hover:text-(--color-text) disabled:opacity-50"
              >
                <ArrowsClockwise size={16} weight="bold" className={scanning ? "animate-spin" : ""} />
                Scan
              </button>
              <button
                onClick={() => setAddOpen(true)}
                className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-2 text-sm font-medium text-white transition hover:brightness-110"
              >
                <Plus size={16} weight="bold" />
                Add machine
              </button>
            </div>
          ) : undefined
        }
        tabs={
          <Segmented
            value={sub}
            onChange={setSub}
            options={[
              { id: "machines", label: "Machines" },
              { id: "settings", label: "Settings" },
            ]}
          />
        }
      >
        <AnimatePresence mode="wait">
          {sub === "machines" ? (
            <motion.div
              key="machines"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              {discovered.length === 0 && machines.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-(--color-border) p-10 text-center text-sm text-(--color-muted)">
                  {scanning
                    ? "Scanning your network…"
                    : "No hosts found. Scan again or add a machine manually."}
                </div>
              ) : (
                <div className="space-y-6">
                  {discovered.length > 0 && (
                    <div>
                      <SectionHeading>Found on your network</SectionHeading>
                      <div className="space-y-3">
                        {discovered.map((d) => (
                          <DiscoveredCard
                            key={d.address + d.name}
                            host={d}
                            busy={busyAddress === d.address}
                            onApps={() => setAppsHost({ name: d.name, address: d.address })}
                            onPair={() => pair({ name: d.name, address: d.address })}
                            onDesktop={() => streamDesktop({ name: d.name, address: d.address })}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {machines.length > 0 && (
                    <div>
                      <SectionHeading>Saved machines</SectionHeading>
                      <div className="space-y-3">
                        {machines.map((m) => (
                          <MachineCard
                            key={m.address}
                            host={m}
                            busy={busyAddress === m.address}
                            onApps={() => setAppsHost(m)}
                            onPair={() => pair(m)}
                            onRemove={() => removeHost(m.address)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <MoonlightSettings />
            </motion.div>
          )}
        </AnimatePresence>
      </PageShell>

      <AddMachineModal open={addOpen} onClose={() => setAddOpen(false)} onAdd={addHost} />

      {appsHost && (
        <AppsModal
          open={!!appsHost}
          onClose={() => setAppsHost(null)}
          host={appsHost}
          onPlay={(app) => playApp(appsHost, app)}
        />
      )}

      <Toast message={toast} />
    </>
  );
}