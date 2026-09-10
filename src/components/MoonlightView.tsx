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
  port: number;
}

interface PairedProbeResult {
  address: string;
  online: boolean;
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
  onDesktop,
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
  onDesktop: () => void;
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
          ) : probe?.reachable === false ? (
            // Saved but offline — can't reach the host, so Pair can't fetch
            // a new cert and Apps can't talk to GameStream. Only Remove is
            // actionable; the Online/Offline pill already explains the rest.
            <button
              onClick={onRemove}
              title="Remove"
              aria-label="Remove"
              className="flex h-9 w-9 items-center justify-center rounded-full text-(--color-muted) transition hover:text-(--color-danger)"
            >
              <Trash size={16} weight="bold" />
            </button>
          ) : probe?.paired === false ? (
            // Saved, reachable, but the Moonlight store has no `srvcert` for
            // this host — `moonlight_list_apps` would fail with "not paired".
            // Pair is the only useful action besides Remove.
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
              <button
                onClick={onRemove}
                title="Remove"
                aria-label="Remove"
                className="flex h-9 w-9 items-center justify-center rounded-full text-(--color-muted) transition hover:text-(--color-danger)"
              >
                <Trash size={16} weight="bold" />
              </button>
            </>
          ) : (
            // Saved + reachable + paired — same surface as DiscoveredCard.
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
  online,
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
  /// True if paired and the GameStream server returned 200 from /serverinfo.
  /// False = paired but offline. Undefined = not yet probed, or unpaired
  /// (we don't probe unpaired discovery entries — `Discover` only sees them
  /// via mDNS, which is itself the "reachable" signal).
  online?: boolean;
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
            {streaming ? (
              <StatusPill pulse>Streaming</StatusPill>
            ) : online !== undefined ? (
              <StatusPill tone={online ? "accent" : "muted"}>
                {online ? "Online" : "Offline"}
              </StatusPill>
            ) : null}
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
          ) : host.paired && online !== false ? (
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
          ) : host.paired ? (
            // Paired but offline — nothing to connect to. The Online/Offline
            // pill already says it, and right-click's "Stream Desktop" /
            // "Apps" are filtered out at the call site too.
            <span className="text-xs text-(--color-muted)">Host unreachable</span>
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
    const address = host.address;
    invoke<string[]>("moonlight_list_apps", { host: address })
      .then((list) => {
        if (alive) setApps(list);
      })
      .catch((err) => {
        if (alive) setError(String(err));
      });
    return () => {
      alive = false;
    };
    // Primitive deps so unrelated parent re-renders (e.g. the per-second
    // elapsed-time clock tick during an active stream) don't refire the
    // moon-light list call. Same host = same address = same fetch.
  }, [open, host?.address, host?.name]);

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
  /// Online/offline state for paired hosts, keyed by address. `true` = the
  /// host's GameStream server returned 200 from /serverinfo, matching how
  /// Moonlight itself decides online/offline. `undefined` = not yet probed.
  const [pairedOnline, setPairedOnline] = useState<Record<string, boolean>>({});
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
  //
  // Hosts the user explicitly added to `settings.machines` are excluded here
  // — they're rendered as `MachineCard` instead, which carries the Remove
  // action. Showing the same machine as both a DiscoveredCard (no Remove)
  // and a MachineCard (with Remove) was confusing. Same treatment for the
  // discovery group: a saved machine is never listed as "Discovery" even
  // if it's broadcasting but currently unpaired, because the saved card is
  // the source of truth.
  const machineAddresses = useMemo(
    () => new Set(machines.map((m) => m.address.toLowerCase())),
    [machines],
  );
  const pairedGroup = useMemo(() => {
    const byAddr = new Map<string, DiscoveredHost>();
    // A discovery entry with `paired: false` is authoritative — Moonlight's
    // CLI was just asked and said "not paired". A stale registry entry that
    // disagrees (e.g. left over from an old pairing whose cert no longer
    // matches) loses. This keeps the host under "Discovery" where the user
    // can pair again, instead of pretending it's still paired.
    const probeSaysUnpaired = new Set(
      discovered
        .filter((d) => !d.paired)
        .map((d) => d.address.toLowerCase()),
    );
    for (const p of pairedHosts) {
      if (machineAddresses.has(p.address.toLowerCase())) continue;
      if (probeSaysUnpaired.has(p.address.toLowerCase())) continue;
      byAddr.set(p.address, { hostname: p.name, name: p.name, address: p.address, paired: true });
    }
    for (const d of discovered) {
      if (!d.paired) continue;
      if (machineAddresses.has(d.address.toLowerCase())) continue;
      byAddr.set(d.address, d);
    }
    return [...byAddr.values()].sort(sortStreamingFirst);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairedHosts, discovered, streamingAddress, machineAddresses]);

  // "Discovery" = found on the network but not yet paired and not in the
  // user's saved list.
  const discoveryGroup = useMemo(
    () =>
      discovered
        .filter((d) => !d.paired && !machineAddresses.has(d.address.toLowerCase()))
        .sort(sortStreamingFirst),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [discovered, streamingAddress, machineAddresses],
  );

  const sortedMachines = [...machines].sort(sortStreamingFirst);

  // Tracks when the last scan finished so focus/visibility bursts don't
  // spam the network (alt-tabbing in and out, multiple focus events in
  // quick succession all collapse into one scan). User-initiated scans
  // (manual Refresh button, pair-complete) bypass the debounce.
  const lastScanAt = useRef(0);
  // Hold machines in a ref so `scan` can be stable across renders. Without
  // this, every machine edit rebuilds `scan` (because the closure captures
  // `machines`), which re-runs three downstream effects that depend on it
  // and re-binds their listeners (focus, visibilitychange, pair-complete).
  const machinesRef = useRef(machines);
  machinesRef.current = machines;

  const scan = useCallback(async (opts: { force?: boolean } = {}) => {
    if (!opts.force) {
      const now = Date.now();
      if (now - lastScanAt.current < 3000) return;
      lastScanAt.current = now;
    } else {
      lastScanAt.current = Date.now();
    }
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
        machinesRef.current.map(async (m) => {
          const p = await invoke<MoonlightProbe>("moonlight_probe", {
            host: m.address,
          }).catch(() => ({ reachable: false, paired: false }));
          return [m.address, p] as const;
        }),
      );
      setMachineProbe(Object.fromEntries(probes));
      setDiscovered(list);
      setPairedHosts(paired);
      // Liveness check for paired hosts — same signal Moonlight uses
      // (`GET /serverinfo` 200 = online). Run after the paired list is known
      // so we can probe each one with its stored per-host HTTP port.
      if (paired.length > 0) {
        const pairedResults = await invoke<PairedProbeResult[]>(
          "moonlight_probe_paired",
          { hosts: paired },
        ).catch(() => [] as PairedProbeResult[]);
        setPairedOnline(Object.fromEntries(pairedResults.map((r) => [r.address, r.online])));
      } else {
        setPairedOnline({});
      }
    } catch {
      // ignore discovery errors
    } finally {
      setScanning(false);
    }
  }, []);

  // Run scans only when the window is focused + page is the active view. The
  // scan hammers the network (mDNS + HTTP probes per host); doing it in the
  // background while the user isn't looking is just wasted battery.
  useEffect(() => {
    if (sub !== "machines") return;
    // Skip the initial scan if the page isn't visible — the focus/visibility
    // listener below will pick it up when the user actually looks at it.
    if (document.visibilityState !== "visible") return;
    scan();
  }, [sub, scan]);

  useEffect(() => {
    if (sub !== "machines") return;
    const refresh = () => {
      if (document.visibilityState === "visible") scan();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [sub, scan]);

  // When a pairing session completes, refresh once instead of polling.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ host: string; success: boolean }>("pair-complete", (event) => {
      const { host, success } = event.payload;
      if (pairingRef.current === host) {
        pairingRef.current = null;
        setBusyAddress(null);
        // Pairing just succeeded/failed — the paired list changed, refresh
        // immediately rather than waiting for the debounce window.
        scan({ force: true });
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
  }

  // Auto-dismiss toast after 2.5s. Bound to `toast` so rapid-fire toasts
  // (e.g. pair + forget in quick succession) reset the timer instead of
  // racing multiple setTimeouts that all clear to null.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  function addHost(host: Host) {
    update((s) => ({ ...s, machines: [...s.machines, host] }));
  }

  function removeHost(address: string) {
    update((s) => ({ ...s, machines: s.machines.filter((m) => m.address !== address) }));
  }

  /// Forget a Moonlight pairing — deletes the host's `srvcert` from
  /// Moonlight's own QSettings store so it stops appearing in the paired
  /// list. Used by the right-click "Forget pairing" entry on discovered
  /// hosts. Refreshes pairedHosts so the UI updates without a full scan.
  async function forgetPairing(address: string) {
    setBusyAddress(address);
    try {
      await invoke("moonlight_forget", { host: address });
      // Refresh paired hosts from the store we just mutated. Clear any
      // cached online state for this address — it'll be re-probed on the
      // next scan, and that probe (now authoritative) decides whether the
      // host lands under Paired or Discovery.
      const paired = await invoke<PairedHost[]>("moonlight_paired_hosts").catch(
        () => [] as PairedHost[],
      );
      setPairedHosts(paired);
      setPairedOnline((prev) => {
        if (!(address in prev)) return prev;
        const next = { ...prev };
        delete next[address];
        return next;
      });
    } catch (e) {
      showToast(`Forget failed: ${e}`);
    } finally {
      setBusyAddress((cur) => (cur === address ? null : cur));
    }
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
        {...(d.paired ? { online: pairedOnline[d.address] } : {})}
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
            ...(d.paired && pairedOnline[d.address] !== false
              ? [
                  { label: "Stream Desktop", onClick: () => streamDesktop(host) },
                  { label: "Apps", onClick: () => setAppsHost(host) },
                ]
              : [{ label: "Pair", onClick: () => pair(host) }]),
            // Forget pairing for paired hosts — drops the cert from
            // Moonlight's store so it stops showing up. Unpaired
            // discoveries have nothing to forget, so the entry is hidden.
            ...(d.paired
              ? [
                  {
                    label: "Forget pairing",
                    danger: true,
                    onClick: () => forgetPairing(d.address),
                  },
                ]
              : []),
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
                onClick={() => scan({ force: true })}
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
                            onDesktop={() => streamDesktop(m)}
                            onPair={() => pair(m)}
                            onRemove={() => removeHost(m.address)}
                            onContextMenu={(e) =>
                              ctx.open(e, [
                                // "Stream Desktop" / "Apps" need a paired,
                                // reachable host. Offline OR unpaired entries
                                // skip both — the buttons are noise there.
                                // Pair is only useful when the host is
                                // reachable but not yet paired (already
                                // paired + reachable makes it a no-op).
                                ...(machineProbe[m.address]?.reachable !== false &&
                                machineProbe[m.address]?.paired !== false
                                  ? [
                                      { label: "Stream Desktop", onClick: () => streamDesktop(m) },
                                      { label: "Apps", onClick: () => setAppsHost(m) },
                                    ]
                                  : machineProbe[m.address]?.reachable !== false
                                  ? [{ label: "Pair", onClick: () => pair(m) }]
                                  : []),
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