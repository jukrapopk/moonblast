import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Plus, Play, LockKey, Monitor, Trash, GameController, ArrowClockwise, Broadcast, X } from "@phosphor-icons/react";
import { MoonlightSettings } from "./MoonlightSettings";
import { PageShell } from "./PageShell";
import { Modal } from "./ui/Modal";
import { Segmented } from "./ui/Segmented";
import { Toast, useToast } from "./ui/Toast";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { StatusPill } from "./ui/StatusPill";
import { IconTile } from "./ui/IconTile";
import { useContextMenu } from "./ui/ContextMenu";
import { Input } from "./ui/Input";
import { useSettings } from "../settings/SettingsContext";
import { useFocusRefresh } from "../hooks/useFocusRefresh";
import { useAutoFocus } from "../input/useSpatialController";
import { Spinner } from "./ui/Spinner";

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

interface MoonlightProbe {
  reachable: boolean;
  paired: boolean;
}

interface Session {
  host: Host;
  app: string;
  startedAt: number;
}

/**
 * One unified entry per logical host, derived by merging the three input
 * lists (settings.machines / moonlight-paired registry / mDNS discovery)
 * into a single map keyed by case-insensitive name. Each entry records
 * which sources contributed to it and carries the *active* address used
 * for probes and stream-launch — saved machines override paired (which
 * override discovery) so a saved Tailscale address wins over the paired
 * record's stale LAN address.
 */
interface HostEntry {
  /** Display name (first non-empty among saved / paired / discovered). */
  name: string;
  /** Canonical lowercase key used for dedup. */
  key: string;
  /** Address the launcher actually probes / streams to. */
  address: string;
  /** True when the Moonlight store has a `srvcert` for this host. */
  paired: boolean;
  /** True when the user has this host in settings.machines. */
  saved: boolean;
  /** True when the host was visible via mDNS in the latest scan. */
  discovery: boolean;
  /** Saved machine record (if any). */
  savedInfo?: Host;
  /** Paired record (if any). */
  pairedInfo?: PairedHost;
  /** Discovered record (if any). */
  discoveredInfo?: DiscoveredHost;
  /** Latest probe result; undefined when not yet probed. */
  probe?: MoonlightProbe;
}

/**
 * Pure function — builds the unified host set from the three sources.
 * Extracted out of `useMemo` so `scan()` can call it synchronously on
 * fresh data without going through the React state cycle.
 *
 * Dedup key is the case-insensitive name (not address) because the
 * whole point of the Saved Machines override is the same host living
 * at different addresses without showing two cards. Override
 * precedence is: saved address > paired address > discovered address.
 */
function buildUnified(
  discovered: DiscoveredHost[],
  paired: PairedHost[],
  machines: Host[],
): HostEntry[] {
  const byKey = new Map<string, HostEntry>();
  const lower = (s: string) => s.toLowerCase();
  for (const d of discovered) {
    const key = lower(d.name);
    byKey.set(key, {
      name: d.name,
      key,
      address: d.address,
      paired: d.paired,
      saved: false,
      discovery: true,
      discoveredInfo: d,
    });
  }
  for (const p of paired) {
    const key = lower(p.name);
    const existing = byKey.get(key);
    if (existing) {
      existing.paired = true;
      existing.pairedInfo = p;
      if (existing.discovery && !existing.saved) existing.address = p.address;
    } else {
      byKey.set(key, {
        name: p.name,
        key,
        address: p.address,
        paired: true,
        saved: false,
        discovery: false,
        pairedInfo: p,
      });
    }
  }
  for (const s of machines) {
    const key = lower(s.name);
    const existing = byKey.get(key);
    if (existing) {
      existing.saved = true;
      existing.savedInfo = s;
      existing.address = s.address;
    } else {
      byKey.set(key, {
        name: s.name,
        key,
        address: s.address,
        paired: false,
        saved: true,
        discovery: false,
        savedInfo: s,
      });
    }
  }
  return [...byKey.values()];
}

function formatElapsed(startedAt: number, now: number) {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Single card UI for the unified host list. Wraps its action buttons in
 * an `lrud-container` so the spatial library keeps Left/Right arrow
 * movement within the card (Desktop → Apps → Forget) while Up/Down
 * jump between cards. Container distance is *not* enabled for the card
 * itself — only its inner buttons are focusable.
 */
function HostCard({
  entry,
  busy,
  streaming,
  streamApp,
  elapsedLabel,
  onResume,
  onDisconnect,
  onApps,
  onDesktop,
  onPair,
  onRemoveSaved,
  onContextMenu,
}: {
  entry: HostEntry;
  busy: boolean;
  streaming: boolean;
  streamApp: string;
  elapsedLabel: string;
  onResume: () => void;
  onDisconnect: () => void;
  onApps: () => void;
  onDesktop: () => void;
  onPair: () => void;
  onRemoveSaved: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  // Show "Saved" badge when the user has this host in settings.machines and
  // the saved address differs from the paired record's address — that's the
  // "remote address" case the user set up for Tailscale / outside-LAN. When
  // the addresses match the saved flag is just bookkeeping.
  const showSavedBadge =
    entry.saved &&
    !!entry.pairedInfo &&
    entry.savedInfo?.address !== entry.pairedInfo.address;
  // Probe is still in flight for saved/paired hosts — we render a "Checking"
  // pill and reserve the action-button slots in their disabled final size so
  // nothing jumps when the probe lands. Only applies to paired/saved hosts;
  // unpaired discovery-only entries never get probed (mDNS is the signal)
  // and resolve straight to "online".
  const pending = !streaming && (entry.paired || entry.saved) && entry.probe === undefined;
  // Online/offline pill: prefer the explicit probe (works for saved +
  // paired entries); fall back to mDNS visibility for unpaired discovery
  // entries that never get probed. While pending we surface a "Checking"
  // pill so the wait is visible — the alternative was a 3–5 s gap with
  // just a name + address and no signal that anything was happening.
  const status: "streaming" | "online" | "offline" | "checking" | null = streaming
    ? "streaming"
    : pending
      ? "checking"
      : entry.probe
        ? entry.probe.reachable
          ? "online"
          : "offline"
        : entry.discovery && !entry.paired
          ? "online"
          : null;
  // Reachability (with a small unpaired-discovery fallback). Used to gate
  // both Stream and Pair buttons — Pair can't fetch a cert from an
  // unreachable host, and Stream needs a paired host to talk to GameStream.
  const reachable =
    entry.probe?.reachable === true ||
    (entry.probe === undefined && entry.discovery && !entry.paired);
  // Stream actions (Desktop / Apps) need a paired host. Pair is the only
  // useful action for a reachable-but-unpaired host; for unreachable hosts
  // we render neither — the Offline pill already explains the situation
  // and right-click is the escape hatch.
  const showStream = !streaming && entry.paired && reachable;
  const showPair = !streaming && !entry.paired && reachable;
  // During pending we still want the Desktop/Apps buttons visible (disabled)
  // so the card layout doesn't shift when the probe lands — only the
  // disabled state flips. The Pair button is hidden because pairing only
  // applies to unpaired hosts, which aren't pending.
  const renderStream = showStream || (pending && entry.paired);
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
            <span className="truncate font-medium text-(--color-text)">{entry.name}</span>
            {showSavedBadge && (
              <StatusPill tone="muted">Saved</StatusPill>
            )}
            {status === "streaming" && <StatusPill pulse>Streaming</StatusPill>}
            {status === "online" && <StatusPill tone="accent">Online</StatusPill>}
            {status === "offline" && <StatusPill tone="muted">Offline</StatusPill>}
            {status === "checking" && <StatusPill tone="muted" pulse>Checking</StatusPill>}
          </div>
          <div className="mt-0.5 truncate text-xs text-(--color-muted)">{entry.address}</div>
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
            // `lrud-container` keeps Left/Right arrow movement contained
            // within the card's action buttons. Up/Down naturally moves
            // between cards because the LRUD library treats the cards'
            // own container as siblings at the page level.
            <div className="lrud-container flex items-center gap-2">
              {renderStream && (
                <>
                  <Button
                    size="md"
                    onClick={onDesktop}
                    disabled={busy || pending}
                    icon={<Play size={15} weight="fill" />}
                    className="px-4 py-2 font-semibold"
                  >
                    Desktop
                  </Button>
                  <Button
                    variant="outline"
                    size="md"
                    onClick={onApps}
                    disabled={busy || pending}
                    icon={<GameController size={14} weight="bold" />}
                    className="py-2"
                  >
                    Apps
                  </Button>
                </>
              )}
              {showPair && (
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
              {entry.saved && (
                <button
                  onClick={onRemoveSaved}
                  title="Forget saved address"
                  aria-label="Forget saved address"
                  className="flex h-9 w-9 items-center justify-center rounded-full text-(--color-muted) transition hover:text-(--color-danger) focus:text-(--color-danger) focus:outline-none"
                >
                  <Trash size={16} weight="bold" />
                </button>
              )}
            </div>
          )}
        </div>
      </Card>
    </motion.div>
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
    <div className="lrud-container flex items-center gap-2">
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
      subtitle="Save a custom address — useful for Tailscale or other remote networks."
      initialFocus="input[placeholder*='192.168']"
    >
      <div className="space-y-3">
        <Input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Name (optional)"
        />
        <Input
          value={address}
          onChange={(e) => setAddress(e.currentTarget.value)}
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
    <Modal open={open} onClose={onClose} title={host ? `${host.name}` : ""} subtitle="Choose an app to stream">
      {error ? (
        <p className="py-4 text-sm text-(--color-danger)">
          {error}
          <span className="mt-1 block text-(--color-muted)">
            Pair the host first if you haven't yet.
          </span>
        </p>
      ) : apps.length === 0 ? (
        <p className="py-6 text-center text-sm text-(--color-muted)">
          {error ? "Couldn't load apps" : "Loading apps"}
        </p>
      ) : (
        <div className="lrud-container max-h-80 space-y-1 overflow-y-auto">
          {apps.map((app) => (
            <button
              key={app}
              onClick={() => onPlay(app)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-base font-medium text-(--color-text) transition-colors hover:bg-(--color-surface) focus:bg-(--color-surface) focus:outline-none"
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
  const { message: toast, show: showToast } = useToast();
  const [discovered, setDiscovered] = useState<DiscoveredHost[]>([]);
  const [pairedHosts, setPairedHosts] = useState<PairedHost[]>([]);
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

  /**
   * Build one HostEntry per logical host. The dedup key is the **name**
   * (case-insensitive) — not the address — because the whole point of the
   * Saved Machines override is that the same host can be at different
   * addresses (LAN vs Tailscale) without showing two cards. The override
   * precedence is: saved address > paired address > discovered address.
   */
  const unifiedHosts = useMemo<HostEntry[]>(
    () => buildUnified(discovered, pairedHosts, machines),
    [discovered, pairedHosts, machines],
  );

  const [probes, setProbes] = useState<Record<string, MoonlightProbe>>({});
  // Stitch the latest probes onto each HostEntry so the card can read its
  // own reachability without having to scan a side-table.
  const hostsWithProbe = useMemo(
    () => unifiedHosts.map((h) => ({ ...h, probe: probes[h.address] })),
    [unifiedHosts, probes],
  );
  const pairedGroup = useMemo(
    () => hostsWithProbe.filter((h) => h.paired).sort(sortStreamingFirst),
    [hostsWithProbe, streamingAddress],
  );
  const discoveryGroup = useMemo(
    () =>
      hostsWithProbe
        .filter((h) => !h.paired && h.discovery)
        .sort(sortStreamingFirst),
    [hostsWithProbe, streamingAddress],
  );

  // Claim initial focus on the first card's first action button so the
  // user can immediately Up/Down through the list with arrow keys.
  const listRef = useRef<HTMLDivElement>(null);
  useAutoFocus(listRef.current, () => sub === "machines" && (pairedGroup.length > 0 || discoveryGroup.length > 0));

  // Tracks when the last scan finished so focus/visibility bursts don't
  // spam the network. User-initiated scans bypass the debounce.
  const lastScanAt = useRef(0);
  // Hold the unified hosts in a ref so `scan` can be stable across renders
  // — the closure otherwise captures `unifiedHosts` and re-binds every
  // dependent effect on every machine edit. Reading from the ref means
  // `scan` always sees the latest values without forcing a re-create.
  const unifiedHostsRef = useRef(unifiedHosts);
  unifiedHostsRef.current = unifiedHosts;
  // Same pattern for `machines` — `scan` reads from this ref so it can
  // build a fresh unified set without depending on the React state cycle.
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
      const [list, paired] = await Promise.all([
        invoke<DiscoveredHost[]>("discover_hosts").catch(() => [] as DiscoveredHost[]),
        invoke<PairedHost[]>("moonlight_paired_hosts").catch(() => [] as PairedHost[]),
      ]);
      setDiscovered(list);
      setPairedHosts(paired);
      // Build the unified set from the FRESH lists (not the stale ref) so
      // we probe exactly the addresses the next render will use. Without
      // this, an address that just changed (LAN → Tailscale, new host
      // appeared, etc.) gets probed under its old key and the new entry
      // lands on the page with `probe === undefined` — stuck on the
      // "Checking" pill until the next scan.
      const freshUnified = buildUnified(list, paired, machinesRef.current);
      const addresses = new Set<string>();
      for (const e of freshUnified) {
        if (e.saved || e.paired) addresses.add(e.address);
      }
      const entries = await Promise.all(
        [...addresses].map(async (addr) => {
          const p = await invoke<MoonlightProbe>("moonlight_probe", { host: addr })
            .catch(() => ({ reachable: false, paired: false }));
          return [addr, p] as const;
        }),
      );
      setProbes(Object.fromEntries(entries));
    } catch {
      // ignore
    } finally {
      setScanning(false);
    }
  }, []);

  // `useFocusRefresh` already runs once on mount and re-runs on
  // window.focus / visibilitychange→visible. Guarded here so only the
  // Machines sub-tab triggers a scan; the Settings sub-tab stays put.
  useFocusRefresh(() => {
    if (sub !== "machines") return;
    if (document.visibilityState !== "visible") return;
    scan();
  }, [sub, scan]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ host: string; success: boolean }>("pair-complete", (event) => {
      const { host, success } = event.payload;
      if (pairingRef.current === host) {
        pairingRef.current = null;
        setBusyAddress(null);
        scan({ force: true });
        showToast(success ? `Paired with ${host}` : `Couldn't pair with ${host}`);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [scan]);

  function addHost(host: Host) {
    update((s) => ({ ...s, machines: [...s.machines, host] }));
  }

  function removeSaved(name: string) {
    update((s) => ({ ...s, machines: s.machines.filter((m) => m.name !== name) }));
  }

  /// Forget a Moonlight pairing — deletes the host's `srvcert` from
  /// Moonlight's own QSettings store so it stops appearing in the paired
  /// list. Refreshes pairedHosts so the UI updates without a full scan.
  async function forgetPairing(name: string) {
    setBusyAddress(name);
    try {
      // forget takes an address; the paired record's address is what we
      // want here. If the host has a saved override the saved address is
      // the right thing to forget against — but actually the cert lives
      // against the original paired address, so pass that.
      const entry = unifiedHostsRef.current.find((e) => e.name.toLowerCase() === name.toLowerCase() && e.paired);
      const addr = entry?.pairedInfo?.address ?? entry?.address;
      if (!addr) return;
      await invoke("moonlight_forget", { host: addr });
      const paired = await invoke<PairedHost[]>("moonlight_paired_hosts").catch(
        () => [] as PairedHost[],
      );
      setPairedHosts(paired);
    } catch (e) {
      showToast(`Couldn't forget ${name}: ${e}`);
    } finally {
      setBusyAddress((cur) => (cur === name ? null : cur));
    }
  }

  async function pair(entry: HostEntry) {
    pairingRef.current = entry.address;
    setBusyAddress(entry.name);
    showToast(`Pairing with ${entry.name}…`);
    try {
      await invoke("moonlight_pair", { host: entry.address });
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
    } catch (err) {
      showToast(String(err));
    } finally {
      setSessionBusy(false);
      setSession(null);
    }
  }

  /** Render a HostEntry as the new HostCard with the right-click menu. */
  const renderHost = (entry: HostEntry) => {
    const host = { name: entry.name, address: entry.address };
    // Mirror the HostCard's gating logic so the right-click doesn't offer
    // actions the buttons don't show. Pair is offered only when the host
    // is reachable (we can't pair an unreachable host).
    const reachable =
      entry.probe?.reachable === true ||
      (entry.probe === undefined && entry.discovery && !entry.paired);
    const menuItems: { label: string; onClick: () => void; danger?: boolean }[] = [
      ...(entry.paired && reachable
        ? [
            { label: "Stream Desktop", onClick: () => streamDesktop(host) },
            { label: "Apps", onClick: () => setAppsHost(host) },
          ]
        : []),
      ...(!entry.paired && reachable
        ? [{ label: "Pair", onClick: () => pair(entry) }]
        : []),
      // Forget pairing — only meaningful for paired hosts. Doesn't remove
      // the saved address.
      ...(entry.paired
        ? [
            {
              label: "Forget pairing",
              danger: true,
              onClick: () => forgetPairing(entry.name),
            },
          ]
        : []),
      // Remove saved address — only for hosts in settings.machines.
      ...(entry.saved
        ? [
            {
              label: "Forget saved address",
              danger: true,
              onClick: () => removeSaved(entry.name),
            },
          ]
        : []),
    ];
    return (
      <HostCard
        key={entry.key}
        entry={entry}
        busy={busyAddress === entry.name || sessionBusy}
        streaming={entry.address === streamingAddress}
        streamApp={session?.app ?? ""}
        elapsedLabel={elapsedLabel}
        onResume={resumeSession}
        onDisconnect={disconnectSession}
        onApps={() => setAppsHost(host)}
        onDesktop={() => streamDesktop(host)}
        onPair={() => pair(entry)}
        onRemoveSaved={() => removeSaved(entry.name)}
        onContextMenu={(e) => ctx.open(e, menuItems)}
      />
    );
  };

  return (
    <>
      <PageShell
        title="Moonlight"
        subtitle="Start streaming directly from here"
        actions={
          sub === "machines" ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="md"
                onClick={() => scan({ force: true })}
                disabled={scanning}
                icon={<Spinner size={16} spinning={scanning} />}
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
              {pairedGroup.length === 0 && discoveryGroup.length === 0 ? (
                <Card dashed className="p-10 text-center text-sm text-(--color-muted)">
                  {scanning
                    ? "Scanning your network…"
                    : "No hosts found. Scan again or add a machine."}
                </Card>
              ) : (
                // `lrud-container` keeps arrow movement inside the host
                // list — Up/Down moves between cards, Left/Right stays
                // within a card's action buttons (Desktop → Apps → Forget).
                <div ref={listRef} tabIndex={-1} className="lrud-container space-y-6 outline-none focus:outline-none">
                  {pairedGroup.length > 0 && (
                    <div>
                      <h2 className="mb-3 mt-2 text-sm font-semibold uppercase tracking-wider text-(--color-muted)">Paired</h2>
                      <div className="space-y-3">{pairedGroup.map(renderHost)}</div>
                    </div>
                  )}
                  {discoveryGroup.length > 0 && (
                    <div>
                      <h2 className="mb-3 mt-2 text-sm font-semibold uppercase tracking-wider text-(--color-muted)">Other hosts</h2>
                      <div className="space-y-3">{discoveryGroup.map(renderHost)}</div>
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
