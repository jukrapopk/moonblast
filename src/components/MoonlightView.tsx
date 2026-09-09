import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Plus, Play, LockKey, Monitor, Trash, GameController, ArrowsClockwise, ArrowClockwise, Broadcast, X } from "@phosphor-icons/react";
import { MoonlightSettings } from "./MoonlightSettings";
import { PageShell } from "./PageShell";
import { Modal } from "./ui/Modal";
import { Segmented } from "./ui/Segmented";
import { Toast } from "./ui/Toast";
import { useContextMenu } from "./ui/ContextMenu";
import { Input } from "./ui/Input";
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

interface Session {
  host: Host;
  app: string;
  startedAt: number;
}

function formatElapsed(startedAt: number, now: number) {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
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
  streaming,
  streamApp,
  elapsedLabel,
  onResume,
  onDisconnect,
  onContextMenu,
}: {
  host: Host;
  onApps: () => void;
  onPair: () => void;
  onRemove: () => void;
  busy: boolean;
  streaming: boolean;
  streamApp: string;
  elapsedLabel: string;
  onResume: () => void;
  onDisconnect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      onContextMenu={onContextMenu}
      className={`flex items-center gap-4 rounded-2xl border bg-(--color-surface) p-4 ${
        streaming ? "border-(--color-accent)/40" : "border-(--color-border)"
      }`}
    >
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
          streaming ? "bg-(--color-accent-soft) text-(--color-accent)" : "text-white/80"
        }`}
        style={streaming ? undefined : { background: "linear-gradient(135deg,#31416b,#2b3a5e)" }}
      >
        {streaming ? <Broadcast size={22} weight="bold" /> : <Monitor size={22} weight="bold" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-(--color-text)">{host.name}</span>
          {streaming && (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-(--color-accent-soft) px-2 py-0.5 text-xs font-medium text-(--color-accent)">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              Streaming
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-(--color-muted)">{host.address}</div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {streaming ? (
          <StreamActions
            app={streamApp}
            elapsedLabel={elapsedLabel}
            busy={busy}
            onResume={onResume}
            onDisconnect={onDisconnect}
          />
        ) : (
          <>
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
          </>
        )}
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
  streaming,
  streamApp,
  elapsedLabel,
  onResume,
  onDisconnect,
  onContextMenu,
}: {
  host: DiscoveredHost;
  onApps: () => void;
  onPair: () => void;
  onDesktop: () => void;
  busy: boolean;
  streaming: boolean;
  streamApp: string;
  elapsedLabel: string;
  onResume: () => void;
  onDisconnect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`flex items-center gap-4 rounded-2xl border bg-(--color-surface) p-4 ${
        streaming ? "border-(--color-accent)/40" : "border-(--color-border)"
      }`}
      onContextMenu={onContextMenu}
    >
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
          streaming ? "bg-(--color-accent-soft) text-(--color-accent)" : "text-white/80"
        }`}
        style={streaming ? undefined : { background: "linear-gradient(135deg,#31416b,#2b3a5e)" }}
      >
        {streaming ? <Broadcast size={22} weight="bold" /> : <Monitor size={22} weight="bold" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-(--color-text)">{host.name}</span>
          {streaming ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-(--color-accent-soft) px-2 py-0.5 text-xs font-medium text-(--color-accent)">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              Streaming
            </span>
          ) : (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                host.paired
                  ? "bg-(--color-accent-soft) text-(--color-accent)"
                  : "bg-(--color-muted-soft) text-(--color-muted)"
              }`}
            >
              {host.paired ? "Paired" : "Not paired"}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-(--color-muted)">{host.address}</div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {streaming ? (
          <StreamActions
            app={streamApp}
            elapsedLabel={elapsedLabel}
            busy={busy}
            onResume={onResume}
            onDisconnect={onDisconnect}
          />
        ) : host.paired ? (
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

/* ----------------------------- Stream actions ---------------------------- */

function StreamActions({
  app,
  elapsedLabel,
  busy,
  onResume,
  onDisconnect,
}: {
  app: string;
  elapsedLabel: string;
  busy: boolean;
  onResume: () => void;
  onDisconnect: () => void;
}) {
  return (
    <>
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-(--color-accent-soft) px-2.5 py-1 text-xs font-medium text-(--color-accent)">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
        {app} · {elapsedLabel}
      </span>
      <button
        onClick={onResume}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-2 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-40"
      >
        <ArrowClockwise size={15} weight="bold" />
        Resume
      </button>
      <button
        onClick={onDisconnect}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-full border border-(--color-border) px-3 py-2 text-sm font-medium text-(--color-muted) transition enabled:hover:border-(--color-danger) enabled:hover:text-(--color-danger) disabled:opacity-40"
      >
        <X size={15} weight="bold" />
        Disconnect
      </button>
    </>
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
        <Input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Name (optional)"
        />
        <Input
          autoFocus
          value={address}
          onChange={(e) => setAddress(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="e.g. 192.168.1.20"
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
  const ctx = useContextMenu();

  // Active streaming session (armed in Moonblast) + live elapsed timer.
  const [session, setSession] = useState<Session | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [session]);

  const elapsedLabel = session ? formatElapsed(session.startedAt, now) : "";

  // Sort so the currently-streaming host floats to the top of each list.
  const streamingAddress = session ? session.host.address : null;
  const sortedDiscovered = [...discovered].sort(
    (a, b) => Number(b.address === streamingAddress) - Number(a.address === streamingAddress)
  );
  const sortedMachines = [...machines].sort(
    (a, b) => Number(b.address === streamingAddress) - Number(a.address === streamingAddress)
  );

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

  async function startStream(host: Host, app: string) {
    setSessionBusy(true);
    try {
      const launched = await invoke<boolean>("moonlight_stream", { host: host.address, app });
      if (launched) {
        setSession({ host, app, startedAt: Date.now() });
        setNow(Date.now());
        showToast(`Streaming ${app}…`);
      } else {
        // A stream for this host+app is already open — don't reset the session.
        showToast(`Already streaming ${app} on ${host.name}`);
      }
    } catch (err) {
      showToast(String(err));
    } finally {
      setSessionBusy(false);
    }
  }

  async function streamDesktop(host: Host) {
    await startStream(host, "Desktop");
  }

  async function playApp(host: Host, app: string) {
    await startStream(host, app);
  }

  async function resumeSession() {
    if (session) await startStream(session.host, session.app);
  }

  async function disconnectSession() {
    if (!session) return;
    setSessionBusy(true);
    const host = session.host;
    try {
      await invoke("moonlight_quit", { host: host.address });
      showToast(`Disconnected from ${host.name}`);
    } catch (err) {
      showToast(String(err));
    } finally {
      setSessionBusy(false);
      setSession(null);
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
                        {sortedDiscovered.map((d) => (
                          <DiscoveredCard
                            key={d.address + d.name}
                            host={d}
                            busy={busyAddress === d.address || sessionBusy}
                            streaming={d.address === streamingAddress}
                            streamApp={session?.app ?? ""}
                            elapsedLabel={elapsedLabel}
                            onResume={resumeSession}
                            onDisconnect={disconnectSession}
                            onApps={() => setAppsHost({ name: d.name, address: d.address })}
                            onPair={() => pair({ name: d.name, address: d.address })}
                            onDesktop={() => streamDesktop({ name: d.name, address: d.address })}
                            onContextMenu={(e) =>
                              ctx.open(e, [
                                ...(d.paired
                                  ? [
                                      { label: "Stream Desktop", onClick: () => streamDesktop({ name: d.name, address: d.address }) },
                                      { label: "Apps", onClick: () => setAppsHost({ name: d.name, address: d.address }) },
                                    ]
                                  : [{ label: "Pair", onClick: () => pair({ name: d.name, address: d.address }) }]),
                                { label: "Remove", danger: true, onClick: () => removeHost(d.address) },
                              ])
                            }
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {machines.length > 0 && (
                    <div>
                      <SectionHeading>Saved machines</SectionHeading>
                      <div className="space-y-3">
                        {sortedMachines.map((m) => (
                          <MachineCard
                            key={m.address}
                            host={m}
                            busy={busyAddress === m.address || sessionBusy}
                            streaming={m.address === streamingAddress}
                            streamApp={session?.app ?? ""}
                            elapsedLabel={elapsedLabel}
                            onResume={resumeSession}
                            onDisconnect={disconnectSession}
                            onApps={() => setAppsHost(m)}
                            onPair={() => pair(m)}
                            onRemove={() => removeHost(m.address)}
                            onContextMenu={(e) =>
                              ctx.open(e, [
                                { label: "Stream Desktop", onClick: () => streamDesktop(m) },
                                { label: "Apps", onClick: () => setAppsHost(m) },
                                { label: "Pair", onClick: () => pair(m) },
                                { label: "Remove", danger: true, onClick: () => removeHost(m.address) },
                              ])
                            }
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