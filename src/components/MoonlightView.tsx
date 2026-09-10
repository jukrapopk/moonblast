import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Plus, Play, LockKey, Monitor, Trash, GameController, ArrowsClockwise, ArrowClockwise, Broadcast, X } from "@phosphor-icons/react";
import { MoonlightSettings } from "./MoonlightSettings";
import { PageShell } from "./PageShell";
import { Modal } from "./ui/Modal";
import { Segmented } from "./ui/Segmented";
import { Toast } from "./ui/Toast";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { StatusPill } from "./ui/StatusPill";
import { IconTile } from "./ui/IconTile";
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

interface PairedHost {
  name: string;
  uuid: string;
  address: string;
}

interface MoonlightProbe {
  reachable: boolean;
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
  probe,
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
  probe?: MoonlightProbe;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      onContextMenu={onContextMenu}
    >
      <Card streaming={streaming}>
        <IconTile active={streaming}>
          {streaming ? <Broadcast size={22} weight="bold" /> : <Monitor size={22} weight="bold" />}
        </IconTile>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-(--color-text)">{host.name}</span>
            {streaming && <StatusPill pulse>Streaming</StatusPill>}
            {!streaming && probe && (
              <StatusPill tone={probe.reachable ? "accent" : "muted"}>
                {probe.reachable ? "Online" : "Offline"}
              </StatusPill>
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
              <Button
                variant="outline-accent"
                size="md"
                onClick={onPair}
                disabled={busy}
                icon={<LockKey size={14} weight="bold" />}
              >
                Pair
              </Button>
              <Button
                size="md"
                onClick={onApps}
                disabled={busy}
                icon={<GameController size={14} weight="bold" />}
              >
                Apps
              </Button>
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
      </Card>
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
    <div onContextMenu={onContextMenu}>
      <Card streaming={streaming}>
        <IconTile active={streaming}>
          {streaming ? <Broadcast size={22} weight="bold" /> : <Monitor size={22} weight="bold" />}
        </IconTile>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-(--color-text)">{host.name}</span>
            {streaming ? <StatusPill pulse>Streaming</StatusPill> : null}
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
              <Button
                size="md"
                onClick={onDesktop}
                disabled={busy}
                icon={<Play size={15} weight="fill" />}
                className="px-4 py-2 font-semibold"
              >
                Desktop
              </Button>
              <Button
                variant="outline"
                size="md"
                onClick={onApps}
                disabled={busy}
                icon={<GameController size={14} weight="bold" />}
                className="py-2"
              >
                Apps
              </Button>
            </>
          ) : (
            <Button
              variant="outline-accent"
              size="md"
              onClick={onPair}
              disabled={busy}
              icon={<LockKey size={14} weight="bold" />}
            >
              Pair
            </Button>
          )}
        </div>
      </Card>
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
      <StatusPill pulse size="md">
        {app} · {elapsedLabel}
      </StatusPill>
      <Button
        size="md"
        onClick={onResume}
        disabled={busy}
        icon={<ArrowClockwise size={15} weight="bold" />}
        className="px-4 py-2 font-semibold"
      >
        Resume
      </Button>
      <Button
        variant="danger"
        size="md"
        onClick={onDisconnect}
        disabled={busy}
        icon={<X size={15} weight="bold" />}
        className="py-2"
      >
        Disconnect
      </Button>
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
          placeholder="e.g. 192.168.1.20 or mybox.tailnet.ts.net"
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="lg" onClick={onClose} className="px-4 font-normal">
            Cancel
          </Button>
          <Button size="lg" onClick={submit} disabled={!address.trim()}>
            Add
          </Button>
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
  const [pairedHosts, setPairedHosts] = useState<PairedHost[]>([]);
  const [machineProbe, setMachineProbe] = useState<Record<string, MoonlightProbe>>({});
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
  const sortStreamingFirst = (a: { address: string }, b: { address: string }) =>
    Number(b.address === streamingAddress) - Number(a.address === streamingAddress);

  // "Paired" = persisted moonlight-qt pairings, merged with paired hosts found
  // by discovery (deduped by address).
  const pairedGroup = useMemo(() => {
    const byAddr = new Map<string, DiscoveredHost>();
    for (const p of pairedHosts) {
      byAddr.set(p.address, { hostname: p.name, name: p.name, address: p.address, paired: true });
    }
    for (const d of discovered) {
      if (d.paired) byAddr.set(d.address, d);
    }
    return [...byAddr.values()].sort(sortStreamingFirst);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairedHosts, discovered, streamingAddress]);

  // "Discovery" = found on the network but not yet paired.
  const discoveryGroup = useMemo(
    () => discovered.filter((d) => !d.paired).sort(sortStreamingFirst),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [discovered, streamingAddress],
  );

  const sortedMachines = [...machines].sort(sortStreamingFirst);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const list = await invoke<DiscoveredHost[]>("discover_hosts").catch(
        () => [] as DiscoveredHost[],
      );
      const paired = await invoke<PairedHost[]>("moonlight_paired_hosts").catch(
        () => [] as PairedHost[],
      );
      // Probe every saved machine (LAN or Tailscale `*.ts.net`) so they show
      // as online/offline without relying on mDNS.
      const probes = await Promise.all(
        machines.map(async (m) => {
          const p = await invoke<MoonlightProbe>("moonlight_probe", {
            host: m.address,
          }).catch(() => ({ reachable: false, paired: false }));
          return [m.address, p] as const;
        }),
      );
      setMachineProbe(Object.fromEntries(probes));
      setDiscovered(list);
      setPairedHosts(paired);
    } catch {
      // ignore discovery errors
    } finally {
      setScanning(false);
    }
  }, [machines]);

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
    try {
      await invoke("moonlight_quit", {
        host: session.host.address,
        app: session.app,
      });
      // Silent on success — the user clicked the button, the streaming
      // window is closing, the toast would just be confirming what they
      // already did. Errors still surface (e.g. Moonlight exe missing).
    } catch (err) {
      showToast(String(err));
    } finally {
      setSessionBusy(false);
      setSession(null);
    }
  }

  const renderDiscoveredCard = (d: DiscoveredHost) => {
    const host = { name: d.name, address: d.address };
    return (
      <DiscoveredCard
        key={d.address + d.name}
        host={d}
        busy={busyAddress === d.address || sessionBusy}
        streaming={d.address === streamingAddress}
        streamApp={session?.app ?? ""}
        elapsedLabel={elapsedLabel}
        onResume={resumeSession}
        onDisconnect={disconnectSession}
        onApps={() => setAppsHost(host)}
        onPair={() => pair(host)}
        onDesktop={() => streamDesktop(host)}
        onContextMenu={(e) =>
          ctx.open(e, [
            ...(d.paired
              ? [
                  { label: "Stream Desktop", onClick: () => streamDesktop(host) },
                  { label: "Apps", onClick: () => setAppsHost(host) },
                ]
              : [{ label: "Pair", onClick: () => pair(host) }]),
            { label: "Remove", danger: true, onClick: () => removeHost(d.address) },
          ])
        }
      />
    );
  };

  return (
    <>
      <PageShell
        title="Moonlight"
        subtitle="Your streaming hosts."
        actions={
          sub === "machines" ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="md"
                onClick={scan}
                disabled={scanning}
                icon={<ArrowsClockwise size={16} weight="bold" className={scanning ? "animate-spin" : ""} />}
                className="h-9 bg-(--color-surface) px-4 disabled:opacity-50"
              >
                Scan
              </Button>
              <Button
                size="md"
                onClick={() => setAddOpen(true)}
                icon={<Plus size={16} weight="bold" />}
                className="px-4 py-2"
              >
                Add machine
              </Button>
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
              {pairedGroup.length === 0 && discoveryGroup.length === 0 && machines.length === 0 ? (
                <Card dashed className="p-10 text-center text-sm text-(--color-muted)">
                  {scanning
                    ? "Scanning your network…"
                    : "No hosts found. Scan again or add a machine manually."}
                </Card>
              ) : (
                <div className="space-y-6">
                  {pairedGroup.length > 0 && (
                    <div>
                      <SectionHeading>Paired</SectionHeading>
                      <div className="space-y-3">{pairedGroup.map(renderDiscoveredCard)}</div>
                    </div>
                  )}
                  {discoveryGroup.length > 0 && (
                    <div>
                      <SectionHeading>Discovery</SectionHeading>
                      <div className="space-y-3">{discoveryGroup.map(renderDiscoveredCard)}</div>
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
                            probe={machineProbe[m.address]}
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