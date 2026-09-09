import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BatteryChargingVertical, BatteryEmpty, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, WifiHigh, WifiLow, WifiMedium, WifiNone, WifiSlash, SquaresFour, Monitor, Gear, Power } from "@phosphor-icons/react";
import { PowerMenu } from "./PowerMenu";
import { WifiModal } from "./ui/WifiModal";
import { useTime, formatClock } from "../hooks/useTime";
import { useWifi } from "../hooks/useWifi";

export type View = "apps" | "moonlight" | "settings";

const items: { id: View; label: string; nav: "left" | "right"; icon: View }[] = [
  { id: "apps", label: "Apps", nav: "left", icon: "apps" },
  { id: "moonlight", label: "Moonlight", nav: "left", icon: "moonlight" },
  { id: "settings", label: "Settings", nav: "right", icon: "settings" },
];

function Icon({ name }: { name: View }) {
  const props = { size: 24, weight: "bold" as const };
  switch (name) {
    case "apps":
      return <SquaresFour {...props} />;
    case "moonlight":
      return <Monitor {...props} />;
    case "settings":
      return <Gear {...props} />;
    default:
      return null;
  }
}

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
  const size = 18;
  const weight = "bold" as const;
  if (charging) return <BatteryChargingVertical size={size} weight={weight} />;
  if (percent < 0) return <BatteryWarning size={size} weight={weight} />;
  if (percent <= 10) return <BatteryEmpty size={size} weight={weight} />;
  if (percent <= 35) return <BatteryLow size={size} weight={weight} />;
  if (percent <= 75) return <BatteryMedium size={size} weight={weight} />;
  return <BatteryFull size={size} weight={weight} />;
}

const chipBase =
  "flex h-9 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-(--color-muted) tabular-nums";

function wifiChipIcon(signal: number) {
  const weight = "bold" as const;
  if (signal >= 75) return <WifiHigh size={16} weight={weight} />;
  if (signal >= 50) return <WifiMedium size={16} weight={weight} />;
  if (signal >= 25) return <WifiLow size={16} weight={weight} />;
  if (signal > 0) return <WifiNone size={16} weight={weight} />;
  return <WifiSlash size={16} weight={weight} />;
}

/** Clock + battery + WiFi chips shown in the TopBar's right cluster. */
function Status({ onWifiClick, ssid }: { onWifiClick: () => void; ssid: string | null }) {
  const time = useTime();
  const battery = useBattery();
  const wifi = useWifi();
  return (
    <div className="flex items-center">
      <span className={chipBase} title={time.toLocaleString()}>
        {formatClock(time)}
      </span>
      {battery && (
        <span
          className={`${chipBase} ${
            !battery.charging && battery.percent <= 10 ? "text-(--color-danger)" : ""
          }`}
          title={battery.charging ? `Charging · ${battery.percent}%` : `On battery · ${battery.percent}%`}
        >
          {batteryIcon(battery.percent, battery.charging)}
          {battery.percent >= 0 ? `${battery.percent}%` : ""}
        </span>
      )}
      {wifi && (
        <button
          onClick={onWifiClick}
          className={`${chipBase} hover:text-(--color-text) cursor-pointer`}
          title={ssid ? `${ssid} · ${wifi.signal}%` : "WiFi · click to scan"}
        >
          {wifiChipIcon(wifi.signal)}
          {ssid && <span className="max-w-32 truncate">{ssid}</span>}
        </button>
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
}: {
  view: View;
  onNavigate: (v: View) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  immersive: boolean;
  onToggleImmersive: () => void;
  showMoonlight: boolean;
  showApps: boolean;
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
  // Subscribed separately so the chip and the modal can both render the
  // current SSID without coordinating state.
  const wifi = useWifi();

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-(--color-border) bg-(--color-surface-ghost) px-4">
      <nav className="flex items-center gap-1">
        {visibleLeft.map((item) => (
          <TopBarButton key={item.id} item={item} view={view} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="ml-auto" />

      <div className="relative flex items-center gap-1">
        <Status onWifiClick={() => setWifiOpen(true)} ssid={wifi?.ssid ?? null} />
        {rightItems.map((item) => (
          <TopBarButton key={item.id} item={item} view={view} onNavigate={onNavigate} />
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
        <WifiModal open={wifiOpen} onClose={() => setWifiOpen(false)} currentSsid={wifi?.ssid ?? null} />
      </div>
    </header>
  );
}

function TopBarButton({
  item,
  view,
  onNavigate,
}: {
  item: { id: View; label: string; icon: View };
  view: View;
  onNavigate: (v: View) => void;
}) {
  const active = view === item.id;
  return (
    <button
      onClick={() => onNavigate(item.id)}
      title={item.label}
      aria-label={item.label}
      className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
        active
          ? "bg-(--color-accent-soft) text-(--color-accent)"
          : "text-(--color-muted) hover:text-(--color-text)"
      }`}
    >
      <Icon name={item.icon} />
    </button>
  );
}
