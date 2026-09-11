import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { PageShell } from "./PageShell";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Modal } from "./ui/Modal";
import { Row } from "./ui/Row";
import { Section } from "./ui/Section";
import { Select } from "./ui/Select";
import { Toggle } from "./ui/Toggle";

type TailscaleStatus =
  | "not-found"
  | "not-running"
  | "starting"
  | "logged-out"
  | "connected"
  | "disconnected"; function TailscaleRow() {
    const [status, setStatus] = useState<TailscaleStatus | null>(null);
    const [busy, setBusy] = useState(false);

    async function refresh() {
      try {
        const info = await invoke<{ status: TailscaleStatus }>("tailscale_status");
        setStatus(info.status);
      } catch {
        setStatus("not-found");
      }
    }

    useEffect(() => {
      refresh();
      // Poll while the Settings page is mounted (it unmounts on navigation, so
      // the timer stops when you leave). Keeps the status live without any cost
      // on other pages.
      const id = setInterval(refresh, 3000);
      return () => clearInterval(id);
    }, []);

    async function toggle(up: boolean) {
      setBusy(true);
      try {
        await invoke("tailscale_set", { up });
      } catch {
        // keep current status; refresh below reflects reality
      }
      await refresh();
      setBusy(false);
    }

    if (status === null) {
      return (
        <Row label="Tailscale">
          <span className="text-sm text-(--color-muted)">Checking…</span>
        </Row>
      );
    }

    if (status === "not-found") {
      return (
        <Row label="Tailscale">
          <span className="text-sm text-(--color-muted)/60">Tailscale not found.</span>
        </Row>
      );
    }

    if (status === "not-running") {
      return (
        <Row label="Tailscale" description="Tailscale isn't running">
          <span className="text-sm text-(--color-muted)/60">Start the Tailscale app to use it.</span>
        </Row>
      );
    }

    if (status === "starting") {
      return (
        <Row label="Tailscale" description="Tailscale is starting…">
          <span className="text-sm text-(--color-muted)/60">Please wait.</span>
        </Row>
      );
    }

    if (status === "logged-out") {
      return (
        <Row label="Tailscale" description="Logged out">
          <span className="text-sm text-(--color-muted)/60">Sign in to Tailscale to connect.</span>
        </Row>
      );
    }

    const up = status === "connected";

    return (
      <Row label="Tailscale" description={up ? "Connected" : "Disconnected"}>
        <Toggle checked={up} onChange={toggle} disabled={busy} />
      </Row>
    );
  }

function MoonlightRow({
  enabled,
  onToggle,
  dir,
  onSelect,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  dir: string | null;
  onSelect: (dir: string) => void;
}) {
  const [invalid, setInvalid] = useState(false);

  async function select() {
    const picked = await open({ directory: true });
    if (typeof picked !== "string") return;
    try {
      const ok = await invoke<boolean>("validate_moonlight_dir", { path: picked });
      if (ok) {
        setInvalid(false);
        onSelect(picked);
      } else {
        setInvalid(true);
      }
    } catch {
      setInvalid(true);
    }
  }

  return (
    <Row
      label="Moonlight"
      description={
        invalid ? "Selected folder isn't a Moonlight install." : dir ?? "Select your Moonlight folder"
      }
    >
      <div className="flex items-center gap-3">
        <Button variant="outline-accent" size="md" onClick={select} className="px-4 py-1.5">
          Select
        </Button>
        <Toggle checked={enabled} onChange={onToggle} disabled={!dir} />
      </div>
    </Row>
  );
}

function ResolutionPicker({
  modes,
  current,
  onApply,
  onPendingChange,
  onResolved,
  deviceName,
}: {
  modes: { width: number; height: number; refreshRates: number[] }[] | null | undefined;
  current: { width: number; height: number; refreshRate: number } | null | undefined;
  onApply: (width: number, height: number, refreshRate: number) => Promise<void>;
  /** Notified whenever a pending change becomes live or resolves — the
   *  parent uses this to revert on Settings unmount. */
  onPendingChange?: (hasPending: boolean) => void;
  /** Notified when the OS display state changes (apply success, keep,
   *  revert, auto-revert) so the parent can re-read the current mode and
   *  refresh the dropdown selection. */
  onResolved?: () => void;
  /** GDI device name (`\\.\DISPLAYn`) of the monitor to target — threaded
   *  through every apply/keep/revert IPC call so multi-monitor setups
   *  don't always hit the primary. */
  deviceName: string | null;
}) {
  // Local selection state for the two dropdowns. Defaults to the
  // currently-active mode when it loads; falls back to the first entry
  // when the current mode isn't in the supported list (shouldn't happen
  // in practice — the driver only returns modes it can do).
  const [width, setWidth] = useState<number | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [refresh, setRefresh] = useState<number | null>(null);
  // Confirmation modal state. `pending` holds the values we just
  // applied; `countdown` ticks 10 → 0 and auto-reverts at 0.
  const [pending, setPending] = useState<
    { width: number; height: number; refresh: number } | null
  >(null);
  const [countdown, setCountdown] = useState(10);
  useEffect(() => {
    if (current) {
      setWidth(current.width);
      setHeight(current.height);
      setRefresh(current.refreshRate);
    }
  }, [current?.width, current?.height, current?.refreshRate]);
  // Countdown timer — only runs while the modal is open and the user
  // hasn't clicked Keep or Revert.
  useEffect(() => {
    if (!pending) return;
    onPendingChange?.(true);
    setCountdown(10);
    const id = setInterval(() => {
      setCountdown((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [pending, onPendingChange]);
  // Auto-revert when countdown hits 0.
  useEffect(() => {
    if (pending && countdown === 0) {
      invoke("revert_display_mode", { deviceName })
        .catch(() => {})
        .finally(() => onResolved?.());
      setPending(null);
    }
  }, [countdown, pending, onResolved]);
  // Notify parent when pending resolves (Keep / Revert / auto-revert).
  useEffect(() => {
    if (pending === null) onPendingChange?.(false);
  }, [pending, onPendingChange]);
  const supportedList: { width: number; height: number; refreshRates: number[] }[] = Array.isArray(
    modes,
  )
    ? modes
    : [];
  // The currently-picked resolution's available refresh rates.
  const refreshOptions =
    width !== null && height !== null
      ? supportedList.find((m) => m.width === width && m.height === height)?.refreshRates ?? []
      : [];
  const canApply =
    width !== null &&
    height !== null &&
    refresh !== null &&
    Array.isArray(modes) &&
    modes.length > 0;
  const isCurrent =
    current !== null &&
    current !== undefined &&
    width === current.width &&
    height === current.height &&
    refresh === current.refreshRate;
  function apply() {
    if (width === null || height === null || refresh === null) return;
    onApply(width, height, refresh)
      .then(() => {
        // Refresh the "current" reading so the dropdown reflects the
        // mode we just applied, then open the confirmation modal.
        onResolved?.();
        setPending({ width, height, refresh });
      })
      .catch(() => {
        // apply failed -- onApply already invoked refreshDisplay itself
        setPending(null);
      });
  }
  async function keep() {
    await invoke("keep_display_mode", { deviceName });
    onResolved?.();
    setPending(null);
  }
  async function revert() {
    await invoke("revert_display_mode", { deviceName });
    onResolved?.();
    setPending(null);
  }
  return (
    <>
      <Row
        label="Resolution"
        description={
          modes === undefined
            ? "Checking…"
            : modes === null
              ? "Couldn't read display modes."
              : current
                ? `Currently ${current.width} × ${current.height} @ ${current.refreshRate} Hz.`
                : ""
        }
      >
        <div className="flex items-center gap-2">
          <Select
            options={supportedList.map((m) => ({
              value: `${m.width}x${m.height}`,
              label: `${m.width} × ${m.height}`,
            }))}
            value={width !== null && height !== null ? `${width}x${height}` : ""}
            onChange={(v) => {
              const m = supportedList.find((mm) => `${mm.width}x${mm.height}` === v);
              if (!m) return;
              const sameRes = m.width === width && m.height === height;
              setWidth(m.width);
              setHeight(m.height);
              // Preserve the user's current refresh if it exists in the
              // new resolution's options — otherwise fall back to the
              // highest available. Picking the same resolution re-selects
              // doesn't bump the refresh.
              if (sameRes) {
                // Keep `refresh` as-is; the dropdown's value will re-render
                // against the (unchanged) refreshOptions.
              } else if (refresh !== null && m.refreshRates.includes(refresh)) {
                setRefresh(refresh);
              } else {
                setRefresh(m.refreshRates[m.refreshRates.length - 1] ?? null);
              }
            }}
          />
          <Select
            options={refreshOptions.map((r) => ({
              value: String(r),
              label: `${r} Hz`,
            }))}
            value={refresh !== null ? String(refresh) : ""}
            onChange={(v) => setRefresh(parseInt(v, 10))}
          />
          <Button
            size="md"
            onClick={apply}
            disabled={!canApply || isCurrent}
            className="px-4 py-1.5"
          >
            Apply
          </Button>
        </div>
      </Row>
      <Modal
        open={pending !== null}
        onClose={() => {
          // X button = Revert.
          revert();
        }}
        title="Display changed"
        subtitle={
          pending
            ? `Switching to ${pending.width} × ${pending.height} @ ${pending.refresh} Hz.`
            : undefined
        }
      >
        <p className="text-sm text-(--color-muted)">
          {countdown > 0
            ? `Auto-reverting in ${countdown}s…`
            : "Reverting…"}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="lg" onClick={revert} className="px-4 font-normal">
            Revert
          </Button>
          <Button size="lg" onClick={keep} className="px-6">
            Keep
          </Button>
        </div>
      </Modal>
    </>
  );
}

export function SettingsView({
  moonlightEnabled,
  onToggleMoonlight,
  moonlightDir,
  onSelectMoonlight,
  appsEnabled,
  onToggleApps,
  steamgridKey,
  onSetSteamgridKey,
  startWithWindows,
  onToggleStartWithWindows,
  autoImmersive,
  onToggleAutoImmersive,
  showTime,
  onToggleShowTime,
  showDate,
  onToggleShowDate,
  showWifi,
  onToggleShowWifi,
  showBattery,
  onToggleShowBattery,
  showAudio,
  onToggleShowAudio,
}: {
  moonlightEnabled: boolean;
  onToggleMoonlight: (v: boolean) => void;
  moonlightDir: string | null;
  onSelectMoonlight: (dir: string) => void;
  appsEnabled: boolean;
  onToggleApps: (v: boolean) => void;
  steamgridKey: string | null;
  onSetSteamgridKey: (k: string) => void;
  startWithWindows: boolean;
  onToggleStartWithWindows: (v: boolean) => void;
  autoImmersive: boolean;
  onToggleAutoImmersive: (v: boolean) => void;
  showTime: boolean;
  onToggleShowTime: (v: boolean) => void;
  showDate: boolean;
  onToggleShowDate: (v: boolean) => void;
  showWifi: boolean;
  onToggleShowWifi: (v: boolean) => void;
  showBattery: boolean;
  onToggleShowBattery: (v: boolean) => void;
  showAudio: boolean;
  onToggleShowAudio: (v: boolean) => void;
}) {
  const [sgStatus, setSgStatus] = useState<"checking" | "valid" | "invalid" | "error" | null>(null);
  // Battery hardware presence — one-shot read on mount. `undefined`
  // while checking; the toggle stays disabled until we know.
  const [hasBattery, setHasBattery] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    invoke<{ percent: number; charging: boolean } | null>("battery")
      .then((s) => {
        if (alive) setHasBattery(s !== null);
      })
      .catch(() => {
        if (alive) setHasBattery(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  // HDR on the primary display. `undefined` while we haven't checked yet
  // (description says "Checking…"); `null` after a failed IPC read; an
  // object with `supported: false` means the panel/driver don't advertise
  // HDR (toggle disabled); `locked: true` means the OS has wideColorEnforced
  // or advancedColorForceDisabled set — the SET request would be silently
  // Monitor picker. `list_monitors` returns every attached GDI adapter
  // (`\\.\DISPLAYn`) with its friendly name and the active/primary flags.
  // The dropdown drives the resolution picker — HDR always targets the
  // primary display because there's no public Win32 API to map a GDI
  // adapter name back to a `DISPLAYCONFIG_PATH_INFO`.
  const [monitors, setMonitors] = useState<
    {
      deviceName: string;
      friendlyName: string;
      primary: boolean;
      disabled: boolean;
    }[]
    | null
  >(null);
  const [selectedDeviceName, setSelectedDeviceName] = useState<string | null>(null);
  const selectedMonitor =
    selectedDeviceName === null
      ? null
      : (monitors ?? []).find((m) => m.deviceName === selectedDeviceName) ?? null;
  // Stable ref so async refresh callbacks can read the live selection
  // without re-binding effects on every change. Shared by refreshHdr,
  // refreshDisplay, and the unmount-cleanup revert path.
  const selectedMonitorRef = useRef(selectedMonitor);
  selectedMonitorRef.current = selectedMonitor;

  // HDR (toggle disabled); `locked: true` means the OS has wideColorEnforced
  // or advancedColorForceDisabled set — the SET request would be silently
  // ignored, so the toggle is disabled with a "Change in Windows display
  // settings" hint.
  const [hdrStatus, setHdrStatus] = useState<
    { supported: boolean; enabled: boolean; locked: boolean } | null | undefined
  >(undefined);
  async function refreshHdr() {
    try {
      const s = await invoke<{ supported: boolean; enabled: boolean; locked: boolean }>(
        "hdr_status",
      );
      setHdrStatus(s);
    } catch {
      setHdrStatus(null);
    }
  }
  useEffect(() => {
    refreshHdr();
  }, []);
  async function toggleHdr(enabled: boolean) {
    try {
      await invoke("set_hdr", { enabled });
    } catch {
      // ignore — refresh will reflect reality
    }
    await refreshHdr();
  }
  // Display resolution + refresh picker. Enumerate once on mount, plus
  // current selection. Picking a new mode opens a confirmation modal
  // with a 10s auto-revert countdown; the user clicks Keep to commit,
  // Revert to roll back, or walks away and the OS reverts automatically.
  // If the user leaves the Settings page with a change pending, we
  // revert on unmount so a forgotten modal can't leave the display stuck
  // on a new mode.
  const [displayModes, setDisplayModes] = useState<
    { width: number; height: number; refreshRates: number[] }[] | null | undefined
  >(undefined);
  const [currentMode, setCurrentMode] = useState<
    { width: number; height: number; refreshRate: number } | null | undefined
  >(undefined);
  const [hasPending, setHasPending] = useState(false);
  async function refreshMonitors() {
    try {
      const list = await invoke<
        {
          deviceName: string;
          friendlyName: string;
          primary: boolean;
          disabled: boolean;
        }[]
      >("list_monitors");
      setMonitors(list);
      // Auto-pick the primary monitor the first time we see a list;
      // after that, keep whatever the user selected.
      if (selectedDeviceName === null) {
        const primary = list.find((m) => m.primary && !m.disabled) ?? list.find((m) => !m.disabled);
        if (primary) setSelectedDeviceName(primary.deviceName);
      } else if (!list.some((m) => m.deviceName === selectedDeviceName)) {
        // The selected monitor was unplugged — fall back to the primary.
        const primary = list.find((m) => m.primary && !m.disabled) ?? list.find((m) => !m.disabled);
        setSelectedDeviceName(primary?.deviceName ?? null);
      }
    } catch {
      setMonitors(null);
    }
  }
  async function refreshDisplay() {
    const m = selectedMonitorRef.current;
    if (!m) {
      setDisplayModes(null);
      setCurrentMode(null);
      return;
    }
    try {
      const [modes, cur] = await Promise.all([
        invoke<{ width: number; height: number; refreshRates: number[] }[]>("display_modes", {
          deviceName: m.deviceName,
        }),
        invoke<{ width: number; height: number; refreshRate: number }>("current_display", {
          deviceName: m.deviceName,
        }),
      ]);
      setDisplayModes(modes);
      setCurrentMode(cur);
    } catch {
      setDisplayModes(null);
      setCurrentMode(null);
    }
  }
  useEffect(() => {
    refreshMonitors();
  }, []);
  // Re-fetch modes + current when the user picks a different monitor.
  // HDR refresh is wired through refreshHdr's effect above.
  useEffect(() => {
    refreshDisplay();
  }, [selectedDeviceName]);
  // Revert any pending change when leaving Settings — the modal-based
  // confirmation already covers in-page flow. Use a ref so the cleanup
  // always reads the latest hasPending value at unmount (without
  // re-firing on every state flip).
  const hasPendingRef = useRef(hasPending);
  hasPendingRef.current = hasPending;
  useEffect(() => {
    return () => {
      if (hasPendingRef.current) {
        const m = selectedMonitorRef.current;
        invoke("revert_display_mode", { deviceName: m?.deviceName ?? null }).catch(() => {});
      }
    };
  }, []);

  async function checkKey() {
    if (!steamgridKey) return;
    setSgStatus("checking");
    try {
      const s = await invoke<string>("check_steamgrid_key", { key: steamgridKey });
      setSgStatus(s === "valid" ? "valid" : s === "invalid" ? "invalid" : "error");
    } catch {
      setSgStatus("error");
    }
  }
  return (
    <PageShell title="Settings" subtitle="App-level settings.">
      <Section title="General">
        <Row label="Start with Windows" description="Launch Moonblast when you sign in to Windows.">
          <Toggle checked={startWithWindows} onChange={onToggleStartWithWindows} />
        </Row>
        <div className="flex items-start justify-between gap-4 py-4">
          <div className="flex-1">
            <div className="text-base font-medium text-(--color-text)">Auto Immersive Mode</div>
            <div className="mt-0.5 text-sm text-(--color-muted)">
              {startWithWindows
                ? "Sign in straight into Moonblast instead of the Windows desktop. Applies from your next sign-in — turning this on won't change anything right now. It:"
                : 'Requires "Start with Windows" to be enabled.'}
            </div>
            {startWithWindows && (
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-(--color-muted)">
                <li>Launches Moonblast fullscreen before anything else</li>
                <li>Never starts the desktop or taskbar, so nothing flashes on the way in</li>
                <li>Skips your Windows startup apps — the desktop is what launches them</li>
                <li>Minimizes other open windows so they don't show behind</li>
                <li>Hands the desktop back when you exit Immersive Mode or close Moonblast</li>
                <li>Hold Shift while signing in to boot to the normal desktop</li>
              </ul>
            )}
          </div>
          <Toggle
            checked={autoImmersive}
            onChange={onToggleAutoImmersive}
            disabled={!startWithWindows}
          />
        </div>
      </Section>

      <Section title="Display">
        <Row
          label="Monitor"
          description={
            monitors === null
              ? "Couldn't enumerate monitors."
              : selectedMonitor
                ? selectedMonitor.disabled
                  ? `${selectedMonitor.friendlyName} (disabled — not in the desktop)`
                  : `Resolution target: ${selectedMonitor.friendlyName}${selectedMonitor.primary ? " (primary)" : ""}.`
                : ""
          }
        >
          <Select
            options={(monitors ?? []).map((m) => ({
              value: m.deviceName,
              label: `${m.friendlyName}${m.primary ? " (primary)" : ""}${m.disabled ? " — disabled" : ""}`,
            }))}
            value={selectedDeviceName ?? ""}
            onChange={setSelectedDeviceName}
          />
        </Row>
        <Row
          label="HDR"
          description={
            hdrStatus === undefined
              ? "Checking…"
              : hdrStatus === null
                ? "Couldn't detect display capabilities."
                : !hdrStatus.supported
                  ? "This display doesn't support HDR."
                  : hdrStatus.locked
                    ? "Locked by Windows color settings — change HDR / wide-color in Display Settings."
                    : hdrStatus.enabled
                      ? "HDR is on (primary display)."
                      : "HDR is off (primary display)."
          }
        >
          <Toggle
            checked={hdrStatus?.enabled ?? false}
            onChange={toggleHdr}
            disabled={
              hdrStatus === undefined ||
              hdrStatus === null ||
              !hdrStatus.supported ||
              hdrStatus.locked
            }
          />
        </Row>
        <ResolutionPicker
          modes={displayModes}
          current={currentMode}
          onPendingChange={setHasPending}
          onResolved={refreshDisplay}
          deviceName={selectedMonitor?.deviceName ?? null}
          onApply={async (width, height, refreshRate) => {
            await invoke("apply_display_mode", {
              deviceName: selectedMonitor?.deviceName ?? null,
              width,
              height,
              refreshRate,
            });
          }}
        />
      </Section>

      <Section title="Customization">
        <Row label="Show Time" description="Show the clock in the TopBar.">
          <Toggle checked={showTime} onChange={onToggleShowTime} />
        </Row>
        <Row label="Show Date" description="Show the date beside the clock in the TopBar.">
          <Toggle checked={showDate} onChange={onToggleShowDate} />
        </Row>
        <Row
          label="Show Battery"
          description={
            hasBattery === false
              ? "No battery detected on this machine."
              : "Only shown on battery-powered machines."
          }
        >
          <Toggle checked={showBattery} onChange={onToggleShowBattery} disabled={hasBattery !== true} />
        </Row>
        <Row label="Show WiFi" description="Show the WiFi status icon in the TopBar.">
          <Toggle checked={showWifi} onChange={onToggleShowWifi} />
        </Row>
        <Row label="Show Audio" description="Show the volume control in the TopBar.">
          <Toggle checked={showAudio} onChange={onToggleShowAudio} />
        </Row>
      </Section>

      <Section title="Integrations">
        <TailscaleRow />
        <Row label="Apps" description="Discover and launch installed Windows apps.">
          <Toggle checked={appsEnabled} onChange={onToggleApps} />
        </Row>
        <Row label="SteamGridDB" description="Optional API key for nicer game icons (falls back to the extracted icon).">
          <div className="flex items-center gap-2">
            <div className="w-56">
              <Input
                value={steamgridKey ?? ""}
                onChange={(e) => {
                  onSetSteamgridKey(e.currentTarget.value);
                  setSgStatus(null);
                }}
                placeholder="API key"
              />
            </div>
            <Button
              variant="outline-accent"
              size="md"
              onClick={checkKey}
              disabled={!steamgridKey || sgStatus === "checking"}
              className="px-4 py-1.5"
            >
              Check
            </Button>
          </div>
        </Row>
        {sgStatus && (
          <div
            className={`px-1 py-2 text-sm ${sgStatus === "valid"
                ? "text-(--color-accent)"
                : sgStatus === "checking"
                  ? "text-(--color-muted)"
                  : "text-(--color-danger)"
              }`}
          >
            {sgStatus === "checking"
              ? "Checking…"
              : sgStatus === "valid"
                ? "✓ Key is valid."
                : sgStatus === "invalid"
                  ? "✕ Key was rejected."
                  : "Couldn't reach SteamGridDB."}
          </div>
        )}
        <MoonlightRow
          enabled={moonlightEnabled}
          onToggle={onToggleMoonlight}
          dir={moonlightDir}
          onSelect={onSelectMoonlight}
        />
      </Section>

      <Section title="About">
        <div className="py-4 text-base text-(--color-muted)">
          Moonblast is a lightweight Fullscreen Mode alternative built on Tauri + Rust.
          Moonlight streaming settings live on the Moonlight page.
        </div>
      </Section>
    </PageShell>
  );
}