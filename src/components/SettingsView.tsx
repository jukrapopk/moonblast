import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Monitor, WifiHigh, Bluetooth, BatteryFull, SpeakerHigh, Clock } from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { PageShell } from "./PageShell";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Modal } from "./ui/Modal";
import { ColorPickerModal } from "./ui/ColorPickerModal";
import { Row } from "./ui/Row";
import { Section } from "./ui/Section";
import { Select } from "./ui/Select";
import { Toggle } from "./ui/Toggle";
import { LoadingChip } from "./ui/LoadingChip";
import { Segmented } from "./ui/Segmented";
import { useFocusRefresh } from "../hooks/useFocusRefresh";
import { ACCENT_PRESETS, presetSwatch } from "../settings/ThemeProvider";

type TailscaleStatus =
  | "not-found"
  | "not-running"
  | "starting"
  | "logged-out"
  | "connected"
  | "disconnected";

/** Mirror of `hdr::HdrStatus` from the Rust side. Used by both
 *  DisplaySettingsModal and MoonlightSettings' "Follow global HDR" row. */
export interface HdrStatus {
  supported: boolean;
  enabled: boolean;
  locked: boolean;
}

interface Monitor {
  deviceName: string;
  friendlyName: string;
  primary: boolean;
  disabled: boolean;
}

function TailscaleRow() {
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
          <span className="text-sm text-(--color-muted)">Checking</span>
        </Row>
      );
    }

    if (status === "not-found") {
      return (
        <Row label="Tailscale">
          <span className="text-sm text-(--color-muted)/60">Tailscale not installed</span>
        </Row>
      );
    }

    if (status === "not-running") {
      return (
        <Row label="Tailscale" description="Tailscale isn't running">
          <span className="text-sm text-(--color-muted)/60">Open Tailscale to connect</span>
        </Row>
      );
    }

    if (status === "starting") {
      return (
        <Row label="Tailscale" description="Tailscale is starting">
          <span className="text-sm text-(--color-muted)/60">Please wait</span>
        </Row>
      );
    }

    if (status === "logged-out") {
      return (
        <Row label="Tailscale" description="Signed out">
          <span className="text-sm text-(--color-muted)/60">Sign in to Tailscale to connect</span>
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
        invalid ? "That folder isn't a Moonlight install" : dir ?? "Select your Moonlight folder"
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
  loading = false,
  onApply,
  onPendingChange,
  onResolved,
  deviceName,
}: {
  modes: { width: number; height: number; refreshRates: number[] }[] | null | undefined;
  current: { width: number; height: number; refreshRate: number } | null | undefined;
  /** True while the parent is fetching modes for the selected monitor.
   *  Renders a loading chip in place of both dropdowns so the row
   *  doesn't show an empty `Select` for the IPC roundtrip. */
  loading?: boolean;
  /** Apply handler — invoked immediately when the user picks a new
   *  resolution or refresh rate. The picker no longer has its own
   *  "Apply" button; the keep/revert modal handles confirmation. */
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
  // Apply handler shared by both dropdowns. Called immediately on
  // change; the keep/revert modal handles confirmation. We bail if the
  // pick is the current selection (no-op) or if any field is unset
  // (modes haven't loaded yet).
  function apply(width: number, height: number, refresh: number) {
    if (current && width === current.width && height === current.height && refresh === current.refreshRate) {
      return;
    }
    setWidth(width);
    setHeight(height);
    setRefresh(refresh);
    onApply(width, height, refresh)
      .then(() => {
        onResolved?.();
        setPending({ width, height, refresh });
      })
      .catch(() => {
        // apply failed — onApply already invoked refreshDisplay itself
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
          loading
            ? "Reading display modes…"
            : modes === undefined
              ? "Checking"
              : modes === null
                ? "Couldn't read display modes"
                : current
                  ? `Currently ${current.width} × ${current.height} @ ${current.refreshRate} Hz`
                  : ""
        }
      >
        <div className="flex items-center gap-2">
          {loading ? (
            <LoadingChip label="Reading modes" />
          ) : (
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
                let nextRefresh = refresh;
                if (sameRes) {
                  // No-op — same resolution picked again. We still
                  // re-apply only if the user later changes refresh.
                } else if (refresh !== null && m.refreshRates.includes(refresh)) {
                  nextRefresh = refresh;
                } else {
                  nextRefresh = m.refreshRates[m.refreshRates.length - 1] ?? null;
                }
                if (nextRefresh === null) return;
                apply(m.width, m.height, nextRefresh);
              }}
            />
          )}
        </div>
      </Row>
      <Row
        label="Refresh rate"
        description={
          loading
            ? "Reading display modes…"
            : current
              ? `Currently ${current.refreshRate} Hz`
              : refreshOptions.length > 0
                ? `${refreshOptions.length} options`
                : ""
        }
      >
        {loading ? (
          <LoadingChip label="Reading modes" />
        ) : (
          <Select
            options={refreshOptions.map((r) => ({
              value: String(r),
              label: `${r} Hz`,
            }))}
            value={refresh !== null ? String(refresh) : ""}
            onChange={(v) => {
              const r = parseInt(v, 10);
              if (width === null || height === null) return;
              apply(width, height, r);
            }}
          />
        )}
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
            ? `Switching to ${pending.width} × ${pending.height} @ ${pending.refresh} Hz`
            : undefined
        }
      >
        <p className="text-sm text-(--color-muted)">
          {countdown > 0 ? `Reverting in ${countdown}s…` : "Reverting…"}
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

/** Display settings modal — reuses the ResolutionPicker + HDR + Monitor
 *  logic that used to live directly on the Display section. Owns its
 *  own monitor/HDR/display-mode state so the rest of SettingsView
 *  doesn't need to track display internals. */
export function DisplaySettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [hdrStatus, setHdrStatus] = useState<HdrStatus | null | undefined>(undefined);
  const [monitors, setMonitors] = useState<Monitor[] | null | undefined>(undefined);
  const [selectedDeviceName, setSelectedDeviceName] = useState<string | null>(null);
  // `monitors ?? []` while monitors is `undefined` (loading) — the
  // `.find` will simply miss and `selectedMonitor` stays null, which
  // gates `refreshDisplay` from racing a stale selection.
  const selectedMonitor =
    selectedDeviceName === null
      ? null
      : (monitors ?? []).find((m) => m.deviceName === selectedDeviceName) ?? null;
  // Stable ref so async refresh callbacks can read the live selection
  // without re-binding effects on every change. Shared by refreshHdr,
  // refreshDisplay, and the unmount-cleanup revert path.
  const selectedMonitorRef = useRef(selectedMonitor);
  selectedMonitorRef.current = selectedMonitor;

  async function refreshMonitors() {
    try {
      const list = await invoke<Monitor[]>("list_monitors");
      setMonitors(list);
      if (selectedDeviceName === null) {
        const primary = list.find((m) => m.primary && !m.disabled) ?? list.find((m) => !m.disabled);
        if (primary) setSelectedDeviceName(primary.deviceName);
      } else if (!list.some((m) => m.deviceName === selectedDeviceName)) {
        const primary = list.find((m) => m.primary && !m.disabled) ?? list.find((m) => !m.disabled);
        setSelectedDeviceName(primary?.deviceName ?? null);
      }
    } catch {
      // `null` = error. `undefined` = loading (set on first mount).
      setMonitors(null);
    }
  }

  const refreshHdr = useCallback(async () => {
    try {
      const s = await invoke<HdrStatus>("hdr_status");
      setHdrStatus(s);
    } catch {
      setHdrStatus(null);
    }
  }, []);
  // Refresh HDR when the window comes back into focus — catches the
  // case where the user toggled HDR in Windows Settings (which doesn't
  // push a Tauri event). Only runs while the modal is open.
  useFocusRefresh(() => {
    if (!open) return;
    void refreshHdr();
  }, [open, refreshHdr]);

  const [displayModes, setDisplayModes] = useState<
    { width: number; height: number; refreshRates: number[] }[] | null | undefined
  >(undefined);
  const [currentMode, setCurrentMode] = useState<
    { width: number; height: number; refreshRate: number } | null | undefined
  >(undefined);
  const [hasPending, setHasPending] = useState(false);

  async function refreshDisplay() {
    const m = selectedMonitorRef.current;
    if (!m) {
      // No monitor selected yet (still loading monitors, or none
      // available). Leave displayModes/currentMode as `undefined` so
      // the rows keep showing the loading chip — setting `null` here
      // would flash an error description before the user has seen a
      // load attempt.
      return;
    }
    // Mark as loading so the Resolution / Refresh rows show the
    // spinner chip until the new modes arrive (otherwise the row
    // briefly shows stale modes from the previous monitor).
    setDisplayModes(undefined);
    setCurrentMode(undefined);
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
    if (!open) return;
    refreshMonitors();
    refreshHdr();
    refreshDisplay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    refreshDisplay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeviceName]);

  // Revert any pending change when the modal unmounts so a forgotten
  // confirmation modal can't leave the display stuck on a new mode.
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

  async function toggleHdr(enabled: boolean) {
    try {
      await invoke("set_hdr", { enabled });
    } catch {
      // ignore — refresh will reflect reality
    }
    await refreshHdr();
  }

  return (
    <Modal open={open} onClose={onClose} title="Display" width="max-w-lg">
      <Row
        label="Monitor"
        description={
          monitors === undefined
            ? "Detecting monitors…"
            : monitors === null
              ? "Couldn't enumerate monitors"
              : selectedMonitor
                ? selectedMonitor.disabled
                  ? `${selectedMonitor.friendlyName} — not in the desktop`
                  : `${selectedMonitor.friendlyName}${selectedMonitor.primary ? " · primary" : ""}`
                : "No monitors detected"
        }
      >
        {monitors === undefined ? (
          <LoadingChip label="Detecting" />
        ) : (
          <Select
            options={(monitors ?? []).map((m) => ({
              value: m.deviceName,
              label: `${m.friendlyName}${m.primary ? " (primary)" : ""}${m.disabled ? " — disabled" : ""}`,
              disabled: m.disabled,
            }))}
            value={selectedDeviceName ?? ""}
            onChange={setSelectedDeviceName}
          />
        )}
      </Row>
      <Row
        label="HDR"
        description={
          hdrStatus === undefined
            ? "Checking HDR support…"
            : hdrStatus === null
              ? "Couldn't detect display capabilities"
              : !hdrStatus.supported
                ? "This display doesn't support HDR"
                : hdrStatus.locked
                  ? "Locked by Windows color settings — open HDR settings to change"
                  : hdrStatus.enabled
                    ? "HDR is on"
                    : "HDR is off"
        }
      >
        {hdrStatus === undefined ? (
          <LoadingChip label="Checking" />
        ) : (
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
        )}
      </Row>
      <ResolutionPicker
        modes={displayModes}
        current={currentMode}
        loading={displayModes === undefined}
        onPendingChange={setHasPending}
        onResolved={refreshDisplay}
        deviceName={selectedMonitor?.deviceName ?? null}
        onApply={async (width, height, refreshRate) => {
          try {
            await invoke("apply_display_mode", {
              deviceName: selectedMonitor?.deviceName ?? null,
              width,
              height,
              refreshRate,
            });
          } catch {
            await refreshDisplay();
          }
        }}
      />
    </Modal>
  );
}

/** Appearance section — light/dark/auto theme + color picker.
 *  Theme + color are persisted in `settings.appearance`; the
 *  ThemeProvider (above App) reads them and applies to <html>. The
 *  Windows OS app mode + accent color are queried via Rust IPC and
 *  pushed as `windows-theme-changed` / `windows-accent-changed`
 *  events by the Rust watcher. */
function AppearanceSection({
  theme,
  accent,
  customAccent,
  windowsAccent,
  onSetTheme,
  onSetAccent,
  onSetCustomAccent,
}: {
  theme: string;
  accent: string;
  customAccent: string | null;
  windowsAccent: string | null;
  onSetTheme: (v: string) => void;
  onSetAccent: (id: string) => void;
  onSetCustomAccent: (hex: string | null) => void;
}) {
  return (
    <Section title="Appearance">
      <Row label="Theme">
        <Segmented
          variant="value"
          options={[
            { id: "dark", label: "Dark" },
            { id: "light", label: "Light" },
            { id: "auto", label: "Auto" },
          ]}
          value={theme}
          onChange={onSetTheme}
        />
      </Row>
      <Row label="Color">
        <ColorPicker
          accent={accent}
          customAccent={customAccent}
          windowsAccent={windowsAccent}
          theme={theme}
          onSetAccent={onSetAccent}
          onSetCustomAccent={onSetCustomAccent}
        />
      </Row>
    </Section>
  );
}

/** 12 named swatches + "Auto" (uses the live Windows accent) +
 *  "Custom" (opens an in-app `ColorPickerModal` — pure-DOM SV area +
 *  hue strip + hex input, no native dialog). Active swatch gets a
 *  ring. The Auto swatch shows the current Windows accent as a
 *  diagonal split so the user can see what they're getting without
 *  needing to commit to it.
 *
 *  The picker modal is opened by clicking the Custom circle (or by
 *  clicking Custom when it's already active — reopens to tweak). The
 *  picker commits every change directly to `customAccent` so closing
 *  it has no separate "save" step; the picker *is* the live value. */
function ColorPicker({
  accent,
  customAccent,
  windowsAccent,
  theme,
  onSetAccent,
  onSetCustomAccent,
}: {
  accent: string;
  customAccent: string | null;
  windowsAccent: string | null;
  theme: string;
  onSetAccent: (id: string) => void;
  onSetCustomAccent: (hex: string | null) => void;
}) {
  // For untinted presets (Neutral / Gray), the swatch matches the
  // applied bg in each theme — dark gray / white for Neutral,
  // slightly different shades for Gray. For tinted presets the
  // swatch is the static color. "Auto" is special: it shows the
  // live Windows accent color.
  const swatchMode: "light" | "dark" = theme === "light" ? "light" : "dark";
  const [pickerOpen, setPickerOpen] = useState(false);
  function handleCustomClick() {
    if (accent !== "custom") onSetAccent("custom");
    setPickerOpen(true);
  }
  return (
    <>
      <div className="flex items-center gap-2">
        {ACCENT_PRESETS.map((p) => {
          const active = accent === p.id;
          const swatchColor =
            p.id === "auto"
              ? (windowsAccent ?? "#6f78c8")
              : presetSwatch(p, swatchMode);
          const isAuto = p.id === "auto";
          return (
            <button
              key={p.id}
              onClick={() => onSetAccent(p.id)}
              aria-label={p.label}
              aria-pressed={active}
              className={`relative h-7 w-7 rounded-full border-2 transition ${
                active
                  ? "scale-110 border-(--color-text)"
                  : "border-(--color-border) focus-visible:border-(--color-muted)"
              }`}
              style={{ background: swatchColor }}
            >
              {isAuto && (
                <span className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] font-bold leading-none text-white drop-shadow-[0_1px_2px_rgb(0_0_0_/_0.6)]">
                  A
                </span>
              )}
            </button>
          );
        })}
        <button
          onClick={handleCustomClick}
          aria-label="Custom color"
          aria-pressed={accent === "custom"}
          // Outer ring = conic rainbow, inner dot = the live custom
          // accent (or fallback when nothing picked yet). The
          // ring/dot split gives the swatch a stable "this opens the
          // picker" affordance (the rainbow never changes) AND a live
          // preview of the picked color (the inner dot updates as
          // soon as the user commits in the modal). Selection is
          // communicated only by the border color.
          className={`relative flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border-2 transition ${
            accent === "custom"
              ? "border-(--color-text)"
              : "border-(--color-border) focus-visible:border-(--color-muted)"
          }`}
          style={{
            backgroundImage:
              "conic-gradient(from 0deg, #e74c3c, #f1c40f, #2ecc71, #3498db, #9b59b6, #e74c3c)",
          }}
        >
          {/* Live custom-color dot. Smaller than the outer ring so the
              rainbow stays visible as an affordance, large enough to
              preview the picked color at a glance. Sits in the
              geometric center; pointer-events-none so the click
              always hits the <button> underneath, not the dot. */}
          <span
            aria-hidden="true"
            className="pointer-events-none h-4 w-4 rounded-full border border-white"
            style={{ background: customAccent ?? "#6f78c8" }}
          />
        </button>
      </div>
      <ColorPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        value={customAccent}
        onChange={(hex) => onSetCustomAccent(hex)}
      />
    </>
  );
}

/** Preferences section — one group per TopBar system item. Each
 *  group has a title + a gear (opens the existing system modal) on the
 *  right, and below it the "Show X in Top Bar" sub-toggles. */
function PreferencesSection({
  showTime,
  showDate,
  showDisplay,
  showWifi,
  showBluetooth,
  showBattery,
  showAudio,
  onToggleShowTime,
  onToggleShowDate,
  onToggleShowDisplay,
  onToggleShowWifi,
  onToggleShowBluetooth,
  onToggleShowBattery,
  onToggleShowAudio,
  onOpenWifi,
  onOpenBluetooth,
  onOpenAudio,
  onOpenBattery,
  onOpenDisplay,
  hasBattery,
}: {
  showTime: boolean;
  showDate: boolean;
  showDisplay: boolean;
  showWifi: boolean;
  showBluetooth: boolean;
  showBattery: boolean;
  showAudio: boolean;
  onToggleShowTime: (v: boolean) => void;
  onToggleShowDate: (v: boolean) => void;
  onToggleShowDisplay: (v: boolean) => void;
  onToggleShowWifi: (v: boolean) => void;
  onToggleShowBluetooth: (v: boolean) => void;
  onToggleShowBattery: (v: boolean) => void;
  onToggleShowAudio: (v: boolean) => void;
  onOpenWifi: () => void;
  onOpenBluetooth: () => void;
  onOpenAudio: () => void;
  onOpenBattery: () => void;
  onOpenDisplay: () => void;
  hasBattery: boolean | undefined;
}) {
  // Display has its own richer modal (Monitor / Resolution / Refresh /
  // HDR). The other groups share their existing TopBar modals — gear
  // click opens the same modal the chip would.

  return (
    <Section title="Preferences">
      <PreferenceGroup
        title="Date & Time"
        icon={<Clock size={20} weight="bold" />}
      >
        <Row label="Show time in Top Bar">
          <Toggle checked={showTime} onChange={onToggleShowTime} />
        </Row>
        <Row label="Show date in Top Bar">
          <Toggle checked={showDate} onChange={onToggleShowDate} />
        </Row>
      </PreferenceGroup>

      <PreferenceGroup
        title="Display"
        icon={<Monitor size={20} weight="bold" />}
        onIconClick={onOpenDisplay}
      >
        <Row label="Show Display in Top Bar">
          <Toggle checked={showDisplay} onChange={onToggleShowDisplay} />
        </Row>
      </PreferenceGroup>

      <PreferenceGroup
        title="Wi-Fi"
        icon={<WifiHigh size={20} weight="bold" />}
        onIconClick={onOpenWifi}
      >
        <Row label="Show Wi-Fi in Top Bar">
          <Toggle checked={showWifi} onChange={onToggleShowWifi} />
        </Row>
      </PreferenceGroup>

      <PreferenceGroup
        title="Bluetooth"
        icon={<Bluetooth size={20} weight="bold" />}
        onIconClick={onOpenBluetooth}
      >
        <Row label="Show Bluetooth in Top Bar">
          <Toggle checked={showBluetooth} onChange={onToggleShowBluetooth} />
        </Row>
      </PreferenceGroup>

      {hasBattery === true && (
        <PreferenceGroup
          title="Battery"
          icon={<BatteryFull size={20} weight="bold" />}
          onIconClick={onOpenBattery}
        >
          <Row label="Show Battery in Top Bar">
            <Toggle checked={showBattery} onChange={onToggleShowBattery} />
          </Row>
        </PreferenceGroup>
      )}

      <PreferenceGroup
        title="Audio"
        icon={<SpeakerHigh size={20} weight="bold" />}
        onIconClick={onOpenAudio}
      >
        <Row label="Show Audio in Top Bar">
          <Toggle checked={showAudio} onChange={onToggleShowAudio} />
        </Row>
      </PreferenceGroup>

      {/* <DisplaySettingsModal> is rendered at the App level so both the
       *  TopBar Display chip and the Preferences gear open the same
       *  instance. The open state lives in App. */}
    </Section>
  );
}

/** A preference group: a header row with the title on the left. When
 *  `onIconClick` is provided, a gear-shaped button (with the item's
 *  own icon inside, color-coded) appears on the right. Clicking opens
 *  additional settings for that item. When omitted, no button is
 *  rendered — used for groups with no deeper settings today. */
function PreferenceGroup({
  title,
  icon,
  onIconClick,
  children,
}: {
  title: string;
  icon: ReactNode;
  onIconClick?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="pt-4 pb-2">
      <div className="mb-1 flex items-center justify-between pl-1 pr-1">
        <span className="text-base font-medium text-(--color-text)">{title}</span>
        {onIconClick && (
          <button
            onClick={onIconClick}
            aria-label={`${title} settings`}
            className="flex h-9 w-9 items-center justify-center rounded-full text-(--color-muted) transition focus:bg-(--color-surface-2) focus:text-(--color-text) focus:outline-none"
          >
            {icon}
          </button>
        )}
      </div>
      {/* `lrud-container` keeps the group's own controls (toggles,
       *  buttons) navigable as one cluster — Up/Down moves between
       *  groups, Left/Right stays inside. */}
      <div className="lrud-container pl-9">{children}</div>
    </div>
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
  autoImmersive,
  onToggleAutoImmersive,
  showTime,
  onToggleShowTime,
  showDate,
  onToggleShowDate,
  showDisplay,
  onToggleShowDisplay,
  showWifi,
  onToggleShowWifi,
  showBluetooth,
  onToggleShowBluetooth,
  showBattery,
  onToggleShowBattery,
  showAudio,
  onToggleShowAudio,
  onOpenWifi,
  onOpenBluetooth,
  onOpenAudio,
  onOpenBattery,
  onOpenDisplay,
  theme,
  onSetTheme,
  accent,
  customAccent,
  windowsAccent,
  onSetAccent,
  onSetCustomAccent,
}: {
  moonlightEnabled: boolean;
  onToggleMoonlight: (v: boolean) => void;
  moonlightDir: string | null;
  onSelectMoonlight: (dir: string) => void;
  appsEnabled: boolean;
  onToggleApps: (v: boolean) => void;
  steamgridKey: string | null;
  onSetSteamgridKey: (k: string) => void;
  autoImmersive: boolean;
  onToggleAutoImmersive: (v: boolean) => void;
  showTime: boolean;
  onToggleShowTime: (v: boolean) => void;
  showDate: boolean;
  onToggleShowDate: (v: boolean) => void;
  showDisplay: boolean;
  onToggleShowDisplay: (v: boolean) => void;
  showWifi: boolean;
  onToggleShowWifi: (v: boolean) => void;
  showBluetooth: boolean;
  onToggleShowBluetooth: (v: boolean) => void;
  showBattery: boolean;
  onToggleShowBattery: (v: boolean) => void;
  showAudio: boolean;
  onToggleShowAudio: (v: boolean) => void;
  onOpenWifi: () => void;
  onOpenBluetooth: () => void;
  onOpenAudio: () => void;
  onOpenBattery: () => void;
  onOpenDisplay: () => void;
  theme: string;
  onSetTheme: (v: string) => void;
  accent: string;
  customAccent: string | null;
  windowsAccent: string | null;
  onSetAccent: (id: string) => void;
  onSetCustomAccent: (hex: string | null) => void;
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
  // (description says "Checking"); `null` after a failed IPC read; an
  // object with `supported: false` means the panel/driver don't advertise
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
    <PageShell title="Settings" subtitle="Customize Moonblast">
      <div className="lrud-container space-y-6">
        <Section title="General">
        <div className="flex items-start justify-between gap-4 py-4">
          <div className="flex-1">
            <div className="text-base font-medium text-(--color-text)">Auto Immersive Mode</div>
            <div className="mt-0.5 text-sm text-(--color-muted)">
              {autoImmersive
                ? "Sign in goes straight to Moonblast instead of the desktop. Hold Shift at sign-in to boot to the desktop once."
                : "Replace the desktop at sign-in with Moonblast."}
            </div>
          </div>
          <Toggle checked={autoImmersive} onChange={onToggleAutoImmersive} />
        </div>
      </Section>

      <AppearanceSection
        theme={theme}
        accent={accent}
        customAccent={customAccent}
        windowsAccent={windowsAccent}
        onSetTheme={onSetTheme}
        onSetAccent={onSetAccent}
        onSetCustomAccent={onSetCustomAccent}
      />

      <PreferencesSection
        showTime={showTime}
        showDate={showDate}
        showDisplay={showDisplay}
        showBattery={showBattery}
        showWifi={showWifi}
        showBluetooth={showBluetooth}
        showAudio={showAudio}
        onToggleShowTime={onToggleShowTime}
        onToggleShowDate={onToggleShowDate}
        onToggleShowDisplay={onToggleShowDisplay}
        onToggleShowBattery={onToggleShowBattery}
        onToggleShowWifi={onToggleShowWifi}
        onToggleShowBluetooth={onToggleShowBluetooth}
        onToggleShowAudio={onToggleShowAudio}
        onOpenWifi={onOpenWifi}
        onOpenBluetooth={onOpenBluetooth}
        onOpenAudio={onOpenAudio}
        onOpenBattery={onOpenBattery}
        onOpenDisplay={onOpenDisplay}
        hasBattery={hasBattery}
      />

      <Section title="Integrations">
        <TailscaleRow />
        <Row label="Apps" description="Discover and launch apps">
          <Toggle checked={appsEnabled} onChange={onToggleApps} />
        </Row>
        <Row label="SteamGridDB" description="Use nicer icons for your games">
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
              ? "Checking"
              : sgStatus === "valid"
                ? "Key is valid"
                : sgStatus === "invalid"
                  ? "Key was rejected"
                  : "Couldn't reach SteamGridDB"}
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
          Moonblast is a lightweight Fullscreen Mode launcher built on Tauri and Rust.
          Moonlight streaming settings live on the Moonlight page.
        </div>
      </Section>
      </div>
    </PageShell>
  );
}