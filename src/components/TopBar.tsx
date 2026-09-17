import { Gear, Monitor, Power, ScreencastIcon, SquaresFour } from "@phosphor-icons/react";
import { motion } from "framer-motion";
import { type ReactNode } from "react";
import { type AudioMaster } from "../hooks/useAudio";
import { type BatteryStatus } from "../hooks/useBattery";
import { formatClock, formatDate, useTime } from "../hooks/useTime";
import { type WifiConnection } from "../hooks/useWifi";
import { BatteryIcon } from "./ui/BatteryIcon";
import { formatDuration } from "./ui/formatDuration";
import { SpeakerIcon } from "./ui/SpeakerIcon";
import { WifiIcon } from "./ui/WifiIcon";

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
  showMoonlight,
  showApps,
  showTime,
  showDate,
  showDisplay,
  showWifi,
  showBattery,
  showAudio,
  batteryOpen,
  onWifiClick,
  onAudioClick,
  onBatteryClick,
  displayOpen,
  onDisplayClick,
  powerOpen,
  onPowerClick,
  wifi,
  audio,
  battery,
}: {
  view: View | null;
  onNavigate: (v: View) => void;
  showMoonlight: boolean;
  showApps: boolean;
  showTime: boolean;
  showDate: boolean;
  showDisplay: boolean;
  showWifi: boolean;
  showBattery: boolean;
  showAudio: boolean;
  batteryOpen: boolean;
  onWifiClick: () => void;
  onAudioClick: () => void;
  onBatteryClick: () => void;
  displayOpen: boolean;
  onDisplayClick: () => void;
  powerOpen: boolean;
  onPowerClick: () => void;
  wifi: WifiConnection | null | undefined;
  audio: AudioMaster | undefined;
  battery: BatteryStatus | null;
}) {
  const leftItems = items.filter((i) => i.nav === "left");
  const visibleLeft = leftItems.filter((i) => {
    if (i.id === "moonlight" && !showMoonlight) return false;
    if (i.id === "apps" && !showApps) return false;
    return true;
  });
  const rightItems = items.filter((i) => i.nav === "right");
  const time = useTime();

  return (
    /* `lrud-container` on the <header> scopes arrow movement to the
     * whole topbar (left nav + status chips + right nav + Power). Tab
     * still moves between every focusable in document order — this
     * only affects arrow keys. The three inner clusters no longer
     * carry their own lrud-container so the library picks the
     * <header> as parentContainer (closest ancestor) and treats all
     * the topbar focusables as siblings.
     *
     * `data-lrud-scope-lock="horizontal"` tells the spatial controller
     * to lock Left/Right movement to this container — Right from the
     * rightmost focusable (Power) no-ops instead of escaping into the
     * page content. Up/Down are NOT locked, so Down from a topbar
     * button reaches the page content below and Up from the page
     * content reaches the topbar above. */
    <header data-lrud-scope-lock="horizontal" className="lrud-container relative flex h-14 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-surface-ghost) px-4">
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
          >
            {formatDate(time)}
          </span>
        )}
      </div>

      <Status
        onWifiClick={onWifiClick}
        onAudioClick={onAudioClick}
        onBatteryClick={onBatteryClick}
        onDisplayClick={onDisplayClick}
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
          onClick={onPowerClick}
        />
      </div>
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
      aria-label={label}
      data-active-view={active && viewId ? viewId : undefined}
      className={`flex h-9 w-9 items-center justify-center rounded-full outline-none transition-colors ${active
          ? "bg-(--color-accent-soft) text-(--color-accent) focus-visible:text-(--color-accent)"
          : danger
            ? "text-(--color-danger) hover:text-(--color-danger) focus-visible:text-(--color-danger)"
            : "text-(--color-muted) hover:text-(--color-text) focus-visible:text-(--color-text)"
        }`}
    >
      {icon}
    </button>
  );
}
