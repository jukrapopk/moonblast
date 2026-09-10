import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BatteryChargingVertical, BatteryEmpty, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, WifiHigh, WifiLow, WifiMedium, WifiNone, WifiSlash, WifiX, SpeakerHigh, SpeakerLow, SpeakerNone, SpeakerX, SquaresFour, Monitor, Gear, Power } from "@phosphor-icons/react";
import { PowerMenu } from "./PowerMenu";
import { WifiModal } from "./ui/WifiModal";
import { AudioModal } from "./ui/AudioModal";
import { useTime, formatClock } from "../hooks/useTime";
import { useWifi, type WifiConnection } from "../hooks/useWifi";
import { useAudioMaster, type AudioMaster } from "../hooks/useAudio";

export type View = "apps" | "moonlight" | "settings";

const items: { id: View; label: string; nav: "left" | "right"; icon: ReactNode }[] = [
  { id: "apps", label: "Apps", nav: "left", icon: <SquaresFour size={24} weight="bold" /> },
  { id: "moonlight", label: "Moonlight", nav: "left", icon: <Monitor size={24} weight="bold" /> },
  { id: "settings", label: "Settings", nav: "right", icon: <Gear size={24} weight="bold" /> },
];

interface BatteryStatus {
  /** 0–100, or -1 when the OS reports "unknown". */
  percent: number;
  /** True when plugged in / charging. */
  charging: boolean;
}

/**
 * Polls the `battery` Rust command every 60s. Returns `null` while the
 * command is loading or when the system has no battery (desktop / VM), so
 * callers can simply skip rendering the chip.
 */
function useBattery(): BatteryStatus | null {
  const [status, setStatus] = useState<BatteryStatus | null>(null);
  useEffect(() => {
    let alive = true;
    async function read() {
      try {
        const s = await invoke<BatteryStatus | null>("battery");
        if (alive) setStatus(s);
      } catch {
        if (alive) setStatus(null);
      }
    }
    void read();
    const id = setInterval(read, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return status;
}

/** Pick the right battery glyph for the current level + charging state. */
function batteryIcon(percent: number, charging: boolean) {
  const size = 24;
  const weight = "bold" as const;
  if (charging) return <BatteryChargingVertical size={size} weight={weight} />;
  if (percent < 0) return <BatteryWarning size={size} weight={weight} />;
  if (percent <= 10) return <BatteryEmpty size={size} weight={weight} />;
  if (percent <= 35) return <BatteryLow size={size} weight={weight} />;
  if (percent <= 75) return <BatteryMedium size={size} weight={weight} />;
  return <BatteryFull size={size} weight={weight} />;
}

function wifiChipIcon(wifi: WifiConnection) {
  const weight = "bold" as const;
  if (!wifi.radioOn) return <WifiX size={24} weight={weight} />;
  const signal = wifi.signal;
  if (signal >= 75) return <WifiHigh size={24} weight={weight} />;
  if (signal >= 50) return <WifiMedium size={24} weight={weight} />;
  if (signal >= 25) return <WifiLow size={24} weight={weight} />;
  if (signal > 0) return <WifiNone size={24} weight={weight} />;
  return <WifiSlash size={24} weight={weight} />;
}

/** Speaker glyph matching the main mixer level + mute state. */
function audioChipIcon(master: AudioMaster) {
  const weight = "bold" as const;
  if (master.muted || master.volume === 0) return <SpeakerX size={24} weight={weight} />;
  if (master.volume < 50) return <SpeakerLow size={24} weight={weight} />;
  return <SpeakerHigh size={24} weight={weight} />;
}

/** Placeholder while the master read is in flight — avoids icon pop-in. */
function audioChipFallback() {
  return <SpeakerNone size={24} weight="bold" />;
}

/** Battery / WiFi / audio icon buttons shown in the TopBar's right cluster. */
function Status({
  onWifiClick,
  onAudioClick,
  wifi,
  audio,
  showWifi,
  showBattery,
  showAudio,
}: {
  onWifiClick: () => void;
  onAudioClick: () => void;
  wifi: WifiConnection | null | undefined;
  audio: AudioMaster | undefined;
  showWifi: boolean;
  showBattery: boolean;
  showAudio: boolean;
}) {
  const battery = useBattery();
  return (
    <div className="flex items-center">
      {showBattery && battery && (
        <TopBarButton
          label={battery.charging ? `Charging · ${battery.percent}%` : `On battery · ${battery.percent}%`}
          icon={batteryIcon(battery.percent, battery.charging)}
          onClick={() => {/* TODO: open battery details */}}
          danger={!battery.charging && battery.percent >= 0 && battery.percent <= 10}
        />
      )}
      {showWifi && wifi && (
        <TopBarButton
          label={wifi.radioOn ? "WiFi" : "WiFi off"}
          icon={wifiChipIcon(wifi)}
          onClick={onWifiClick}
        />
      )}
      {showAudio && (
        <TopBarButton
          label={audio ? (audio.muted ? "Muted" : `Volume · ${audio.volume}%`) : "Audio"}
          icon={audio ? audioChipIcon(audio) : audioChipFallback()}
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
  showWifi,
  showBattery,
  showAudio,
}: {
  view: View;
  onNavigate: (v: View) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  immersive: boolean;
  onToggleImmersive: () => void;
  showMoonlight: boolean;
  showApps: boolean;
  showTime: boolean;
  showWifi: boolean;
  showBattery: boolean;
  showAudio: boolean;
}) {
  const leftItems = items.filter((i) => i.nav === "left");
  const visibleLeft = leftItems.filter((i) => {
    if (i.id === "moonlight" && !showMoonlight) return false;
    if (i.id === "apps" && !showApps) return false;
    return true;
  });
  const rightItems = items.filter((i) => i.nav === "right");
  const [powerOpen, setPowerOpen] = useState(false);
  const [wifiOpen, setWifiOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
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
  const time = useTime();

  return (
    <header className="relative flex h-14 shrink-0 items-center gap-4 border-b border-(--color-border) bg-(--color-surface-ghost) px-4">
      <nav className="flex items-center gap-1">
        {visibleLeft.map((item) => (
          <TopBarButton
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={view === item.id}
            onClick={() => onNavigate(item.id)}
          />
        ))}
      </nav>

      <div className="ml-auto" />

      {showTime && (
        <div className="absolute left-1/2 -translate-x-1/2">
          <span
            className="flex h-9 items-center rounded-full px-2 text-lg font-medium text-(--color-muted) tabular-nums"
            title={time.toLocaleString()}
          >
            {formatClock(time)}
          </span>
        </div>
      )}

      <div className="relative flex items-center gap-1">
        <Status
          onWifiClick={() => setWifiOpen(true)}
          onAudioClick={() => setAudioOpen(true)}
          wifi={wifi}
          audio={audio}
          showWifi={showWifi}
          showBattery={showBattery}
          showAudio={showAudio}
        />
        {rightItems.map((item) => (
          <TopBarButton
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={view === item.id}
            onClick={() => onNavigate(item.id)}
          />
        ))}
        <button
          onClick={() => setPowerOpen((o) => !o)}
          title="Power"
          aria-label="Power"
          aria-expanded={powerOpen}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
            powerOpen
              ? "bg-(--color-accent-soft) text-(--color-accent)"
              : "text-(--color-muted) hover:text-(--color-text)"
          }`}
        >
          <Power size={24} weight="bold" />
        </button>
        <PowerMenu
          open={powerOpen}
          onClose={() => setPowerOpen(false)}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
          immersive={immersive}
          onToggleImmersive={onToggleImmersive}
        />
        <WifiModal open={wifiOpen} onClose={() => setWifiOpen(false)} currentSsid={wifi?.ssid ?? null} radioOn={wifi?.radioOn ?? null} />
        <AudioModal open={audioOpen} onClose={() => setAudioOpen(false)} onChanged={refreshAudio} />
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
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
        active
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
