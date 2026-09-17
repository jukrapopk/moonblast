import { useCallback, useEffect, useRef, useState } from "react";
import { pushEscapeHandler } from "../../input/useSpatialController";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Toggle } from "./Toggle";
import { Input } from "./Input";
import { ErrorBanner } from "./ErrorBanner";
import { EmptyMessage } from "./EmptyMessage";
import {
  Lock,
  CaretRight,
  Eye,
  EyeSlash,
} from "@phosphor-icons/react";
import { Spinner } from "./Spinner";
import { WifiIcon } from "./WifiIcon";
import { LoadingChip } from "./LoadingChip";
import {
  fetchWifiCurrent,
  useWifiScan,
  wifiConnect,
  wifiConnectWithPassword,
  wifiDisconnect,
  wifiForget,
  wifiSetRadio,
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
   * Radio state from the parent's shared `useWifi` subscription. Seeds
   * the modal's own `liveRadioOn` on open; `false` = adapter exists but
   * radio off (skip scans, show the off-hint, disable Rescan); `true`/
   * `null` = on or unknown. `null` covers loading and no-adapter — both
   * fall back to the old behavior (scan optimistically).
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

  // Escape from the password form returns to the network list
  // instead of closing the entire Wi-Fi modal. Pushes onto the
  // controller's LIFO escape stack so it wins over the modal's
  // close handler; pops on unmount so a second Escape (or
  // any later interaction) closes the modal as before.
  useEffect(() => {
    const pop = pushEscapeHandler(() => onBack());
    return pop;
  }, [onBack]);
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-(--color-text)">{network.ssid}</div>
          <div className="text-xs text-(--color-muted)">
            {network.auth ?? "Secured"} · {network.signal}%
          </div>
        </div>
        <Lock size={14} weight="bold" className="shrink-0 text-(--color-muted)" />
      </div>
      <div className="space-y-2">
        <Input
          type={show ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) {
              onSubmit(network, password);
            }
          }}
          disabled={busy}
          // Mouse-only, matching the Apps search field — Left/Right inside
          // a text field would otherwise be caret movement (universal input
          // convention), which conflicts with the surrounding spatial-nav
          // row. The eye-toggle and Submit buttons stay focusable via
          // keyboard; the user can click into the input with the mouse
          // and type, then press Enter to submit (handled above).
          tabIndex={-1}
          placeholder="Network security key"
          trailing={
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-(--color-muted) focus-visible:text-(--color-text)"
              aria-label={show ? "Hide password" : "Show password"}
              tabIndex={-1}
            >
              {show ? <EyeSlash size={14} weight="bold" /> : <Eye size={14} weight="bold" />}
            </button>
          }
        />
        {error && <ErrorBanner className="mb-0">{error}</ErrorBanner>}
        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="ghost"
            size="md"
            onClick={onBack}
            disabled={busy}
            // Modal `initialFocus` selector — when this form is the only
            // content of the Wi-Fi modal, the focus trap's autoFocus
            // lands on the Back button instead of the X Close or the
            // password input. The selector only matches when Back is
            // rendered (i.e. the password form is showing), so the
            // network-list view still focuses its first row.
            data-modal-back=""
          >
            Back
          </Button>
          <Button
            size="md"
            onClick={() => canSubmit && onSubmit(network, password)}
            disabled={!canSubmit}
          >
            {busy ? "Connecting" : "Connect"}
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
      ? "Connecting"
      : busy.kind === "forget"
        ? "Forgetting"
        : "Disconnecting"
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
            {busy && <Spinner size={11} />}
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
          // Refocus target after a successful connect — the wrapper
          // div isn't focusable (only the Disconnect button is), so
          // focus restoration lands here instead of on the row.
          data-network-disconnect=""
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
        data-context-menu
        data-network-row={net.ssid}
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
      data-context-menu
      data-network-row={net.ssid}
      disabled={anyBusy}
      aria-label={needsSignIn ? `Sign in to ${net.ssid}` : `Connect to ${net.ssid}`}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors focus:bg-(--color-surface) focus:outline-none disabled:opacity-40"
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
  const [radioBusy, setRadioBusy] = useState(false);
  // Local copy of the radio state so the header toggle reflects a
  // just-performed change immediately. Seeded from the parent's shared
  // subscription on open, but refreshed with a direct one-shot fetch
  // (bypassing that subscription's `useDebouncedRead` 2s collapse
  // window) after every toggle here — mirrors `liveSsid` below, and the
  // same fix applied to the Bluetooth modal's radio toggle. Without
  // this, toggling shortly after the modal's open-triggered refresh can
  // silently collapse with that earlier read and never visually update,
  // even though the radio itself did flip.
  const [liveRadioOn, setLiveRadioOn] = useState<boolean | null>(radioOn);
  useEffect(() => {
    if (open) setLiveRadioOn(radioOn);
  }, [open, radioOn]);
  // When off, scans are pointless (`netsh show networks` can only
  // return the empty cache), so the list stays empty with an off-hint
  // and Rescan is disabled until the radio comes back on.
  const radioOff = liveRadioOn === false;
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
  const [passwordTarget, _setPasswordTarget] = useState<WifiNetwork | null>(null);
  // SSID of the last network the user entered the password form for.
  // Captured when the form opens so the Back button can return focus
  // to that exact row (otherwise the focus trap would land on the
  // X Close or the first network — neither matches user intent).
  const [lastNetworkSsid, setLastNetworkSsid] = useState<string | null>(null);
  // Wrapper that mirrors `passwordTarget` into `lastNetworkSsid` so the
  // list view can restore focus to the row the user came from. Called
  // both from the row's left-click and from its context-menu Connect.
  const setPasswordTarget = (net: WifiNetwork | null) => {
    if (net) setLastNetworkSsid(net.ssid);
    _setPasswordTarget(net);
  };
  useEffect(() => {
    if (!open) {
      _setPasswordTarget(null);
      setLastNetworkSsid(null);
    }
  }, [open]);
  // Clear in-flight state when the modal closes so a fresh open doesn't
  // show a stale in-flight subtitle. The chip picks up the real state
  // immediately via the parent's refresh effect.
  useEffect(() => {
    if (!open) {
      setBusy(null);
      setRadioBusy(false);
    }
  }, [open]);

  // Scan on open and on off→on transitions (including the in-app toggle
  // below). On→off clears the now-stale list so the off-hint shows, and
  // backs out of the password form (its target network is no longer
  // reachable).
  useEffect(() => {
    if (!open) return;
    if (radioOff) {
      clear();
      setPasswordTarget(null);
      return;
    }
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, radioOff]);

  async function handleToggleRadio(next: boolean) {
    setRadioBusy(true);
    setError(null);
    try {
      await wifiSetRadio(next);
      const c = await fetchWifiCurrent();
      setLiveRadioOn(c ? c.radioOn : next);
    } catch (e) {
      setError(String(e));
    } finally {
      setRadioBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Common envelope for every wifi action: spin up the per-row busy
   *  state, run the action, swallow errors into the modal's error slot,
   *  clear the busy state when done. */
  async function runAction(
    busySsid: string | null,
    kind: "connect" | "disconnect" | "forget",
    fn: () => Promise<void>,
  ) {
    setBusy(busySsid ? { ssid: busySsid, kind } : null);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // When a row triggers a connect / disconnect / forget, the row itself
  // gets disabled (`anyBusy` flips on) and the browser drops focus to
  // `<body>`. After the action completes and the row re-enables, restore
  // focus to the row the user acted on so arrow-nav continues from
  // where they left off. Tracked via a ref so a refocused-then-reclicked
  // sequence doesn't double-fire (the ref is consumed once per action).
  //
  // The password-form connect path doesn't need this: `setPasswordTarget
  // (null)` after success flips `initialFocus` and the focus trap's
  // re-run picks up the matching `[data-network-row]` selector
  // automatically.
  const lastBusySsid = useRef<string | null>(null);
  useEffect(() => {
    if (busy?.ssid) {
      lastBusySsid.current = busy.ssid;
      return;
    }
    // busy just flipped to null — refocus the row the action came from,
    // unless the password form is open (form's focus trap owns focus
    // there) or the modal was closed mid-action.
    if (!lastBusySsid.current || passwordTarget || !open) {
      lastBusySsid.current = null;
      return;
    }
    const ssid = lastBusySsid.current;
    lastBusySsid.current = null;
    // Defer past React's commit so the freshly-rerendered row is in the
    // DOM (and re-enabled) before we focus it.
    const id = requestAnimationFrame(() => {
      const escaped = CSS.escape(ssid);
      const row = document.querySelector<HTMLElement>(
        `[data-network-row="${escaped}"]`,
      );
      // After a successful connect, the row becomes "connected": the
      // wrapper switches from <button> to <div> with a Disconnect
      // button inside. The wrapper is non-focusable, so target the
      // button — that's the natural next action after connecting.
      const disconnect = row?.querySelector<HTMLElement>(
        "[data-network-disconnect]",
      );
      const target = disconnect ?? row;
      // The row may be gone (Forget on the only matching SSID, or the
      // row vanished mid-scan) — fall back to the first network row so
      // focus isn't lost on body.
      (target ?? document.querySelector<HTMLElement>("[data-network-row]"))?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [busy, passwordTarget, open]);

  // Re-scan the visible-network list and re-read the live connection so
  // the modal reflects whatever just changed. Used after every mutating
  // action (connect / disconnect / forget / connect-with-password).
  async function refreshAfter() {
    await scan();
    const c = await fetchWifiCurrent();
    setLiveSsid(c?.ssid ?? null);
  }

  async function handleConnect(ssid: string) {
    await runAction(ssid, "connect", async () => {
      await wifiConnect(ssid);
      // The connect command may take a few seconds to actually take
      // effect; poll the OS a few times to wait for the state to land
      // before refreshing the modal.
      await waitForState(ssid);
      await refreshAfter();
    });
  }

  async function handleDisconnect() {
    await runAction(liveSsid, "disconnect", async () => {
      await wifiDisconnect();
      // The disconnect command may also be async on the wlan service;
      // poll briefly so the modal reflects the real state.
      await waitForState(null);
      await refreshAfter();
    });
  }

  async function handleForget(ssid: string) {
    await runAction(ssid, "forget", async () => {
      await wifiForget(ssid);
      // Profile deletion is synchronous — skip the state-poll, just
      // re-read the list so the `known` flag (and the connection, if
      // it was current) update.
      await refreshAfter();
    });
  }

  async function handleConnectWithPassword(
    net: WifiNetwork,
    password: string,
  ) {
    await runAction(net.ssid, "connect", async () => {
      await wifiConnectWithPassword(net.ssid, password, net.auth ?? "");
      await waitForState(net.ssid);
      // Dismiss the password form on success; the list is back.
      // `runAction` captures failures into the error slot — staying on
      // the form lets the user correct the password.
      setPasswordTarget(null);
      await refreshAfter();
    });
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

  // Memoized so the password form's escape-handler effect (which
  // depends on this callback) doesn't re-register its handler on
  // every render.
  const handlePasswordBack = useCallback(() => {
    setPasswordTarget(null);
    setError(null);
  }, []);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Wi-Fi"
      width="max-w-sm"
      headerAction={
        radioBusy ? (
          <Spinner size={14} />
        ) : (
          <Toggle
            checked={liveRadioOn === true}
            onChange={(v) => void handleToggleRadio(v)}
            disabled={liveRadioOn === null}
          />
        )
      }
      // Focus the Back button when the password form is the modal's
      // content. When returning from the password form back to the
      // list, focus the row the user came from (their last-targeted
      // network) — the form's onBack clears `passwordTarget` but keeps
      // the SSID in `lastNetworkSsid` for this exact selector match.
      // Falls back to the first network row when there's no last-target
      // (e.g. modal opened directly into the list).
      initialFocus={
        passwordTarget
          ? "[data-modal-back]"
          : lastNetworkSsid
            ? `[data-network-row="${lastNetworkSsid}"]`
            : undefined
      }
    >
      {passwordTarget ? (
        <PasswordForm
          network={passwordTarget}
          busy={busy !== null && busy.ssid === passwordTarget.ssid && busy.kind === "connect"}
          error={error}
          onSubmit={handleConnectWithPassword}
          onBack={handlePasswordBack}
        />
      ) : (
        <>
          {error && <ErrorBanner>{error}</ErrorBanner>}

          <div className="max-h-72 space-y-1 overflow-y-auto p-1.5">
            {loading && networks.length === 0 ? (
              <div className="flex items-center justify-center py-4">
                <LoadingChip label="Scanning networks" variant="plain" />
              </div>
            ) : networks.length === 0 ? (
              <EmptyMessage>
                {radioOff ? "Turn Wi-Fi on to see networks" : "No networks found"}
              </EmptyMessage>
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
              // `aria-disabled` instead of `disabled` — keeps the button
              // in the spatial-nav focusable list while still being
              // non-clickable. The library's `getFocusables` filters by
              // the HTML `[disabled]` attribute, which would drop focus
              // to <body> when scanning starts; `aria-disabled` is a
              // CSS-attribute-only signal the library ignores. The
              // onClick guard below is the actual gate.
              aria-disabled={loading || busy !== null || radioOff}
              onClick={() => {
                if (loading || busy !== null || radioOff) return;
                scan();
              }}
              className={`${loading || busy !== null || radioOff ? "cursor-not-allowed opacity-40" : ""}`}
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
