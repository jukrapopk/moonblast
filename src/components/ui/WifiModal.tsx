import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import {
  Lock,
  ArrowsClockwise,
  CaretRight,
  ArrowLeft,
  Eye,
  EyeSlash,
} from "@phosphor-icons/react";
import { WifiIcon } from "./WifiIcon";
import {
  fetchWifiCurrent,
  useWifiScan,
  wifiConnect,
  wifiConnectWithPassword,
  wifiDisconnect,
  wifiForget,
  type WifiNetwork,
} from "../../hooks/useWifi";
import { useContextMenu } from "./ContextMenu";

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
  /**
   * Radio state from the parent's shared `useWifi` subscription.
   * `false` = adapter exists but radio off (skip scans, show the
   * off-hint, disable Rescan); `true`/`null` = on or unknown.
   * `null` covers loading and no-adapter — both fall back to the
   * old behavior (scan optimistically). The parent refreshes this
   * on window focus, so toggling WiFi in OS Settings with the
   * modal open updates the modal on return — no modal-local poll.
   */
  radioOn: boolean | null;
}

function signalIcon(signal: number) {
  // Per-row signals only render when the radio is on (the modal hides
  // the list entirely when off), so we always pass radioOn=true.
  return <WifiIcon signal={signal} radioOn={true} size={20} />;
}

function signalTone(signal: number) {
  if (signal >= 50) return "text-(--color-text)";
  if (signal >= 25) return "text-(--color-muted)";
  return "text-(--color-danger)";
}

/**
 * In-app password entry for a secured network with no saved profile.
 * Replaces the network list while open — the user is focused on one
 * SSID until they either back out or the connect succeeds.
 */
function PasswordForm({
  network,
  busy,
  error,
  onSubmit,
  onBack,
}: {
  network: WifiNetwork;
  busy: boolean;
  error: string | null;
  onSubmit: (net: WifiNetwork, password: string) => void;
  onBack: () => void;
}) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const canSubmit = !busy && password.length > 0;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={onBack}
          disabled={busy}
          className="flex h-7 w-7 items-center justify-center rounded-full text-(--color-muted) transition-colors hover:bg-(--color-surface) hover:text-(--color-text) disabled:opacity-40"
          aria-label="Back to network list"
        >
          <ArrowLeft size={14} weight="bold" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-(--color-text)">{network.ssid}</div>
          <div className="text-xs text-(--color-muted)">
            {network.auth ?? "Secured"} · {network.signal}%
          </div>
        </div>
        <Lock size={14} weight="bold" className="shrink-0 text-(--color-muted)" />
      </div>
      <div className="space-y-2">
        <div className="relative">
          <input
            type={show ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) {
                onSubmit(network, password);
              }
            }}
            autoFocus
            disabled={busy}
            placeholder="Network security key"
            className="h-10 w-full rounded-full border border-(--color-border) bg-(--color-surface-2) px-4 pr-12 text-sm text-(--color-text) placeholder:text-(--color-muted) outline-none transition focus:border-(--color-accent) disabled:opacity-40"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full text-(--color-muted) hover:text-(--color-text)"
            aria-label={show ? "Hide password" : "Show password"}
            tabIndex={-1}
          >
            {show ? <EyeSlash size={14} weight="bold" /> : <Eye size={14} weight="bold" />}
          </button>
        </div>
        {error && (
          <p className="rounded-lg border border-(--color-danger)/30 bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="md" onClick={onBack} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="md"
            onClick={() => canSubmit && onSubmit(network, password)}
            disabled={!canSubmit}
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function NetworkRow({
  net,
  currentSsid,
  onConnect,
  onNeedsPassword,
  onDisconnect,
  onMenu,
  /** In-flight action on this row (spinner + subtitle) — `null` when idle. */
  busy,
  /** True if any row is currently busy — used to disable clicks on
   *  every other row while one is in flight. */
  anyBusy,
}: {
  net: WifiNetwork;
  currentSsid: string | null;
  onConnect: (ssid: string) => void;
  /** Click on a secured network with no saved profile — show the
   *  in-app password prompt instead of opening Windows settings. */
  onNeedsPassword: (net: WifiNetwork) => void;
  onDisconnect: () => void;
  /** Right-click — opens the row's context menu (same actions as click). */
  onMenu: (e: React.MouseEvent, net: WifiNetwork) => void;
  /** In-flight action on this row (spinner + subtitle) — `null` when idle. */
  busy: { kind: "connect" | "disconnect" | "forget" } | null;
  anyBusy: boolean;
}) {
  const isCurrent = currentSsid === net.ssid && net.connected;
  const needsSignIn = net.secured && !net.known;

  // Subtitle text: shows the in-flight state for the row that's busy,
  // otherwise the standard "Connected" / "Saved" status.
  const subtitle = busy
    ? busy.kind === "connect"
      ? "Connecting…"
      : busy.kind === "forget"
        ? "Forgetting…"
        : "Disconnecting…"
    : isCurrent
      ? "Connected"
      : net.known
        ? "Saved"
        : null;

  const rowBody = (
    <>
      <div className="relative flex w-7 shrink-0 items-center justify-center">
        <span className={signalTone(net.signal)}>{signalIcon(net.signal)}</span>
        {net.gen && (
          <span className="absolute -bottom-0.5 right-0.5 text-[10px] font-bold leading-none text-(--color-muted)">
            {net.gen}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-(--color-text)">{net.ssid}</span>
        </div>
        {subtitle && (
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-(--color-muted)">
            {busy && (
              <ArrowsClockwise size={11} weight="bold" className="animate-spin" />
            )}
            <span>{subtitle}</span>
          </div>
        )}
      </div>
      {/* Decorative icon — shows the user what kind of network this row
          is (saved vs. needs sign-in). Hidden while busy: the spinner
          takes the right-side slot. The whole row is the click target. */}
      {!busy && !isCurrent && needsSignIn && (
        <Lock size={13} weight="bold" className="shrink-0 text-(--color-muted)" />
      )}
      {!busy && !isCurrent && !needsSignIn && net.known && (
        <CaretRight size={13} weight="bold" className="shrink-0 text-(--color-muted)" />
      )}
      {isCurrent && busy?.kind !== "disconnect" && (
        <Button
          variant="ghost"
          size="md"
          onClick={onDisconnect}
          disabled={anyBusy}
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
      <div
        onContextMenu={(e) => onMenu(e, net)}
        className={`flex items-center gap-3 rounded-xl bg-(--color-accent-soft) px-3 py-2.5 ${
          busy?.kind === "disconnect" ? "opacity-40" : ""
        }`}
      >
        {rowBody}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        if (needsSignIn) onNeedsPassword(net);
        else onConnect(net.ssid);
      }}
      onContextMenu={(e) => onMenu(e, net)}
      disabled={anyBusy}
      aria-label={needsSignIn ? `Sign in to ${net.ssid}` : `Connect to ${net.ssid}`}
      title={needsSignIn ? "Sign in" : "Connect"}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-(--color-surface) focus:bg-(--color-surface) focus:outline-none disabled:opacity-40"
    >
      {rowBody}
    </button>
  );
}

export function WifiModal({ open, onClose, currentSsid, radioOn }: WifiModalProps) {
  const { networks, loading, scan, clear } = useWifiScan();
  // Per-row in-flight state (the row that the user is currently acting
  // on). `null` when nothing is happening.
  const [busy, setBusy] = useState<{ ssid: string; kind: "connect" | "disconnect" | "forget" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Derived from the parent's subscription — no local fetch, no poll.
  // When off, scans are pointless (`netsh show networks` can only
  // return the empty cache), so the list stays empty with an off-hint
  // and Rescan is disabled until the radio comes back on.
  const radioOff = radioOn === false;
  // Local copy of the current SSID so connect/disconnect reflect
  // immediately. Seeded from the prop on open; re-fetched from the
  // OS after every connect/disconnect, and synced from the parent
  // subscription (which refreshes on window focus) while open.
  const [liveSsid, setLiveSsid] = useState<string | null>(currentSsid);
  useEffect(() => {
    if (open) setLiveSsid(currentSsid);
  }, [open, currentSsid]);
  // When set, the modal shows the password-entry form for this network
  // instead of the list. Cleared on submit-success / back / modal close.
  const [passwordTarget, setPasswordTarget] = useState<WifiNetwork | null>(null);
  useEffect(() => {
    if (!open) setPasswordTarget(null);
  }, [open]);
  // Clear in-flight state when the modal closes so a fresh open doesn't
  // show a stale in-flight subtitle. The chip picks up the real state
  // immediately via the parent's refresh effect.
  useEffect(() => {
    if (!open) setBusy(null);
  }, [open]);

  // Scan on open and on off→on transitions (parent refreshes `radioOn`
  // on window focus, so returning from OS Settings auto-populates).
  // On→off clears the now-stale list so the off-hint shows.
  useEffect(() => {
    if (!open) return;
    if (radioOff) {
      clear();
      return;
    }
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, radioOff]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleConnect(ssid: string) {
    setBusy({ ssid, kind: "connect" });
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
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect() {
    setBusy(liveSsid ? { ssid: liveSsid, kind: "disconnect" } : null);
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

  async function handleForget(ssid: string) {
    setBusy({ ssid, kind: "forget" });
    setError(null);
    try {
      await wifiForget(ssid);
      // Profile deletion is synchronous — just re-read the list so
      // the `known` flag (and connection, if it was current) updates.
      await scan();
      const c = await fetchWifiCurrent();
      setLiveSsid(c?.ssid ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleConnectWithPassword(
    net: WifiNetwork,
    password: string,
  ) {
    setBusy({ ssid: net.ssid, kind: "connect" });
    setError(null);
    try {
      await wifiConnectWithPassword(net.ssid, password, net.auth ?? "");
      await waitForState(net.ssid);
      setPasswordTarget(null);
      await scan();
      const c = await fetchWifiCurrent();
      setLiveSsid(c?.ssid ?? null);
    } catch (e) {
      // Stay on the form so the user can correct the password.
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Right-click menu per row — same actions as left-click, plus
  // forgetting saved networks. Built in the parent (AppsView pattern)
  // so failures can surface in the modal's error slot.
  const ctx = useContextMenu();
  function openNetMenu(e: React.MouseEvent, net: WifiNetwork) {
    const isCurrent = net.connected && liveSsid !== null && net.ssid === liveSsid;
    const needsSignIn = net.secured && !net.known;
    ctx.open(e, [
      isCurrent
        ? {
            label: "Disconnect",
            disabled: busy !== null,
            onClick: () => void handleDisconnect(),
          }
        : {
            label: "Connect",
            disabled: busy !== null,
            // Secured with no saved profile → password form first.
            onClick: () =>
              needsSignIn ? setPasswordTarget(net) : void handleConnect(net.ssid),
          },
      ...(net.known
        ? [
            {
              label: "Forget",
              danger: true,
              disabled: busy !== null,
              onClick: () => void handleForget(net.ssid),
            },
          ]
        : []),
    ]);
  }

  return (
    <Modal open={open} onClose={onClose} title="WiFi" width="max-w-sm">
      {passwordTarget ? (
        <PasswordForm
          network={passwordTarget}
          busy={busy !== null && busy.ssid === passwordTarget.ssid && busy.kind === "connect"}
          error={error}
          onSubmit={handleConnectWithPassword}
          onBack={() => {
            setPasswordTarget(null);
            setError(null);
          }}
        />
      ) : (
        <>
          {error && (
            <p className="mb-3 rounded-lg border border-(--color-danger)/30 bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
              {error}
            </p>
          )}

          <div className="max-h-72 space-y-1 overflow-y-auto">
            {loading && networks.length === 0 ? (
              <p className="py-4 text-center text-sm text-(--color-muted)">Scanning…</p>
            ) : networks.length === 0 ? (
              <p className="py-4 text-center text-sm text-(--color-muted)">
                {radioOff ? "Wi-Fi is off — turn it on in WiFi Settings." : "No networks found"}
              </p>
            ) : (
              networks.map((net) => {
                // Per-row busy state: this row shows the spinner only
                // when it's the one being acted on.
                const rowBusy: { kind: "connect" | "disconnect" | "forget" } | null =
                  busy && busy.ssid === net.ssid ? { kind: busy.kind } : null;
                return (
                  <NetworkRow
                    key={net.ssid}
                    net={net}
                    currentSsid={liveSsid}
                    onConnect={handleConnect}
                    onNeedsPassword={setPasswordTarget}
                    onDisconnect={handleDisconnect}
                    onMenu={openNetMenu}
                    busy={rowBusy}
                    anyBusy={busy !== null}
                  />
                );
              })
            )}
          </div>

          <div className="mt-5 flex items-center justify-between gap-2 border-t border-(--color-border) pt-4">
            <Button
              variant="ghost"
              size="md"
              onClick={scan}
              disabled={loading || busy !== null || radioOff}
              icon={<ArrowsClockwise size={14} weight="bold" className={loading ? "animate-spin" : ""} />}
            >
              Rescan
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
