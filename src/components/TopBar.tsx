import { Gear, Monitor, Power, ScreencastIcon, SquaresFour } from "@phosphor-icons/react";
import { motion } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAudioMaster, type AudioMaster } from "../hooks/useAudio";
import { useBattery, type BatteryStatus } from "../hooks/useBattery";
import { usePowerMenuTrigger } from "../hooks/usePowerMenuTrigger";
import { formatClock, formatDate, useTime } from "../hooks/useTime";
import { useWifi, type WifiConnection } from "../hooks/useWifi";
import { setSpatialScope } from "../input/useSpatialController";
import { PowerMenu } from "./PowerMenu";
import { AudioModal } from "./ui/AudioModal";
import { BatteryIcon } from "./ui/BatteryIcon";
import { BatteryModal } from "./ui/BatteryModal";
import { formatDuration } from "./ui/formatDuration";
import { SpeakerIcon } from "./ui/SpeakerIcon";
import { WifiIcon } from "./ui/WifiIcon";
import { WifiModal } from "./ui/WifiModal";

export type View = "apps" | "moonlight" | "settings";

const items: { id: View; label: string; nav: "left" | "right"; icon: ReactNode }[] = [
  { id: "apps", label: "Apps", nav: "left", icon: <SquaresFour size={24} weight="bold" /> },
  { id: "moonlight", label: "Moonlight", nav: "left", icon: <ScreencastIcon size={24} weight="bold" /> },
  { id: "settings", label: "Settings", nav: "right", icon: <Gear size={24} weight="bold" /> },
];

/** Battery / WiFi / audio icon buttons shown in the TopBar's right cluster. */
function Status({
  onWifiClick,
  onAudioClick,
  onBatteryClick,
  onDisplayClick,
  batteryOpen,
  displayOpen,
  battery,
  wifi,
  audio,
  showDisplay,
  showWifi,
  showBattery,
  showAudio,
}: {
  onWifiClick: () => void;
  onAudioClick: () => void;
  onBatteryClick: () => void;
  onDisplayClick: () => void;
  batteryOpen: boolean;
  displayOpen: boolean;
  battery: BatteryStatus | null;
  wifi: WifiConnection | null | undefined;
  audio: AudioMaster | undefined;
  showDisplay: boolean;
  showWifi: boolean;
  showBattery: boolean;
  showAudio: boolean;
}) {
  // Tooltip doubles as the aria-label: status · percent · time-remaining.
  const batteryLabel = battery
    ? battery.charging
      ? `Charging · ${battery.percent >= 0 ? `${battery.percent}%` : "—"} · ${formatDuration(battery.timeRemainingSec, "short")} to full`
      : `On battery · ${battery.percent >= 0 ? `${battery.percent}%` : "—"} · ${formatDuration(battery.timeRemainingSec, "short")} left`
    : "Battery";
  // Critical flash at ≤5% on battery (the OS-driven warning band). Below the
  // static `danger` red threshold so the chip never doubles up.
  const critical = !!battery && !battery.charging && battery.percent >= 0 && battery.percent <= 5;
  return (
    <div className="flex items-center gap-1">
      {showDisplay && (
        <TopBarButton
          label="Display"
          icon={<Monitor size={24} weight="bold" />}
          onClick={onDisplayClick}
          active={displayOpen}
        />
      )}
      {showWifi && wifi && (
        <TopBarButton
          label={wifi.radioOn ? "Wi-Fi" : "Wi-Fi off"}
          icon={<WifiIcon signal={wifi.signal} radioOn={wifi.radioOn} size={24} />}
          onClick={onWifiClick}
        />
      )}
      {showBattery && battery && (
        <motion.div
          animate={critical ? { opacity: [1, 0.45, 1] } : { opacity: 1 }}
          transition={critical ? { repeat: Infinity, duration: 1.4, ease: "easeInOut" } : { duration: 0 }}
        >
          <TopBarButton
            label={batteryLabel}
            icon={<BatteryIcon percent={battery.percent} charging={battery.charging} size={24} />}
            onClick={onBatteryClick}
            active={batteryOpen}
            danger={!battery.charging && battery.percent >= 0 && battery.percent <= 10}
          />
        </motion.div>
      )}
      {showAudio && (
        <TopBarButton
          label={audio ? (audio.muted || audio.volume === 0 ? "Muted" : `Volume · ${audio.volume}%`) : "Audio"}
          icon={
            <SpeakerIcon
              volume={audio ? audio.volume : 100}
              muted={audio ? audio.muted : false}
              size={24}
            />
          }
          onClick={onAudioClick}
        />
      )}
    </div>
  );
}

export function TopBar({
  view,
  onNavigate,
  fullscreen,
  onToggleFullscreen,
  immersive,
  onToggleImmersive,
  showMoonlight,
  showApps,
  showTime,
  showDate,
  showDisplay,
  showWifi,
  showBattery,
  showAudio,
  wifiOpen,
  setWifiOpen,
  audioOpen,
  setAudioOpen,
  batteryOpen,
  setBatteryOpen,
  displayOpen,
  setDisplayOpen,
}: {
  view: View | null;
  onNavigate: (v: View) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  immersive: boolean;
  onToggleImmersive: () => void;
  showMoonlight: boolean;
  showApps: boolean;
  showTime: boolean;
  showDate: boolean;
  showDisplay: boolean;
  showWifi: boolean;
  showBattery: boolean;
  showAudio: boolean;
  // Modal open state — owned by the App level so the Preferences gear
  // buttons in Settings can also open these (TopBar renders the modals
  // because that's where the data hooks live).
  wifiOpen: boolean;
  setWifiOpen: (v: boolean) => void;
  audioOpen: boolean;
  setAudioOpen: (v: boolean) => void;
  batteryOpen: boolean;
  setBatteryOpen: (v: boolean) => void;
  displayOpen: boolean;
  setDisplayOpen: (v: boolean) => void;
}) {
  const leftItems = items.filter((i) => i.nav === "left");
  const visibleLeft = leftItems.filter((i) => {
    if (i.id === "moonlight" && !showMoonlight) return false;
    if (i.id === "apps" && !showApps) return false;
    return true;
  });
  const rightItems = items.filter((i) => i.nav === "right");
  const [powerOpen, setPowerOpen] = useState(false);
  // Rust intercepts Alt+F4 (and taskbar-Close) while in Immersive Mode
  // and asks us to open the Power menu via the global trigger. Subscribe
  // directly so every request reaches us even if the menu is already
  // open (e.g. user alt-F4s again) — setPowerOpen(true) is idempotent.
  const { subscribe: subscribePower } = usePowerMenuTrigger();
  useEffect(() => subscribePower(() => setPowerOpen(true)), [subscribePower]);
  const closePower = () => setPowerOpen(false);
  // One subscription shared by the chip (Status) and the modal prop.
  // `refreshWifi` is also called on modal open/close so the chip picks
  // up any state change the user made in the modal right away.
  const { current: wifi, refresh: refreshWifi } = useWifi();
  useEffect(() => {
    refreshWifi();
  }, [wifiOpen, refreshWifi]);
  // Master mixer level for the speaker chip. Refreshed on modal close
  // (plus focus + a slow poll inside the hook) so the icon tracks
  // volume-key / external-mixer changes.
  const { master: audio, refresh: refreshAudio } = useAudioMaster();
  useEffect(() => {
    if (!audioOpen) refreshAudio();
  }, [audioOpen, refreshAudio]);
  // Battery: hook drives the chip and the modal. On modal close we
  // force-refresh so the chip reflects the latest state (same pattern
  // as WiFi — the hook's 5s poll is the steady-state refresh path).
  const { status: battery, refresh: refreshBattery } = useBattery();
  useEffect(() => {
    if (!batteryOpen) refreshBattery();
  }, [batteryOpen, refreshBattery]);
  const time = useTime();

  // Lock the spatial navigation scope to the topbar header while a
  // topbar button has focus. The LRUD library searches within
  // parentContainer first, then falls back to the document scope if
  // no candidates are in the requested direction. Locking scope =
  // header means the fallback also only considers topbar focusables,
  // so Right from Power (the rightmost focusable) doesn't escape
  // into the page content area — it just no-ops. Setting scope to
  // null on focusout lets the controller fall back to default scope
  // (document.body) when the user tabs out into the page.
  const headerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    function onFocusIn(e: FocusEvent) {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (headerRef.current?.contains(target)) {
        setSpatialScope(headerRef.current);
      }
    }
    function onFocusOut(e: FocusEvent) {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      // Only clear when focus is actually leaving the topbar (not
      // just moving between buttons inside it). relatedTarget is
      // null on blur in some browsers; fall back to checking if the
      // new activeElement is inside the header.
      if (!headerRef.current?.contains(target)) return;
      const next = e.relatedTarget as Node | null;
      if (!next || !headerRef.current?.contains(next)) {
        setSpatialScope(null);
      }
    }
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  return (
    /* `lrud-container` on the <header> scopes arrow movement to the
     * whole topbar (left nav + status chips + right nav + Power). Tab
     * still moves between every focusable in document order — this
     * only affects arrow keys. The three inner clusters no longer
     * carry their own lrud-container so the library picks the
     * <header> as parentContainer (closest ancestor) and treats all
     * the topbar focusables as siblings. */
    <header ref={headerRef} className="lrud-container relative flex h-14 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-surface-ghost) px-4">
      {/* Left nav cluster */}
      <nav className="flex items-center gap-1">
        {visibleLeft.map((item) => (
          <TopBarButton
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={view === item.id}
            onClick={() => onNavigate(item.id)}
            viewId={item.id}
          />
        ))}
      </nav>

      <div className="ml-auto" />

      <div className="absolute left-1/2 -translate-x-1/2 flex items-center">
        {showTime && (
          <span
            className="flex h-9 items-center rounded-full px-2 text-lg font-medium text-(--color-muted) tabular-nums"
            title={time.toLocaleString()}
          >
            {formatClock(time)}
          </span>
        )}
        {showTime && showDate && (
          <span aria-hidden className="text-(--color-muted)">·</span>
        )}
        {showDate && (
          <span
            className="flex h-9 items-center rounded-full px-2 text-lg font-medium text-(--color-muted) tabular-nums"
            title={time.toLocaleString()}
          >
            {formatDate(time)}
          </span>
        )}
      </div>

      <Status
        onWifiClick={() => setWifiOpen(true)}
        onAudioClick={() => setAudioOpen(true)}
        onBatteryClick={() => setBatteryOpen(true)}
        onDisplayClick={() => setDisplayOpen(true)}
        batteryOpen={batteryOpen}
        displayOpen={displayOpen}
        battery={battery}
        wifi={wifi}
        audio={audio}
        showDisplay={showDisplay}
        showWifi={showWifi}
        showBattery={showBattery}
        showAudio={showAudio}
      />
      <div className="flex items-center gap-1">
        <div aria-hidden className="mx-1 h-6 w-px bg-(--color-border)" />
        {rightItems.map((item) => (
          <TopBarButton
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={view === item.id}
            onClick={() => onNavigate(item.id)}
            viewId={item.id}
          />
        ))}
        <TopBarButton
          label="Power"
          icon={<Power size={24} weight="bold" />}
          active={powerOpen}
          onClick={() => setPowerOpen((o) => !o)}
        />
      </div>
      <PowerMenu
        open={powerOpen}
        onClose={closePower}
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
        immersive={immersive}
        onToggleImmersive={onToggleImmersive}
      />
      <WifiModal open={wifiOpen} onClose={() => setWifiOpen(false)} currentSsid={wifi?.ssid ?? null} radioOn={wifi?.radioOn ?? null} />
      <AudioModal open={audioOpen} onClose={() => setAudioOpen(false)} onChanged={refreshAudio} />
      <BatteryModal open={batteryOpen} onClose={() => setBatteryOpen(false)} />
    </header>
  );
}

/**
 * Shared circular icon button used for every TopBar control — nav items
 * (Apps / Moonlight / Settings), system status (battery, WiFi, audio), and the
 * power button. Two visual states:
 *   - `active` (default false): the current nav view — soft accent
 *     background + accent icon.
 *   - `danger` (default false): a status condition that needs attention
 *     (e.g. low battery) — red icon, no background.
 */
function TopBarButton({
  label,
  icon,
  onClick,
  active = false,
  danger = false,
  // When set, exposes the active nav button via a DOM attribute so
  // `useSpatialController`'s default-Escape handler can return focus to
  // it (Escape with no modal open → focus the active view's nav button).
  viewId,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  viewId?: View;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      data-active-view={active && viewId ? viewId : undefined}
      className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${active
          ? "bg-(--color-accent-soft) text-(--color-accent)"
          : danger
            ? "text-(--color-danger)"
            : "text-(--color-muted) hover:text-(--color-text)"
        }`}
    >
      {icon}
    </button>
  );
}
