import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BatteryChargingVertical, BatteryEmpty, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, SquaresFour, Monitor, Gear, Power } from "@phosphor-icons/react";
import { PowerMenu } from "./PowerMenu";
import { useTime, formatClock } from "../hooks/useTime";

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
  "flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-(--color-muted) tabular-nums";

/** Clock + battery chips shown in the TopBar's right cluster. */
function Status() {
  const time = useTime();
  const battery = useBattery();
  return (
    <div className="flex items-center gap-1.5 pr-1">
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

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-(--color-border) bg-(--color-surface-ghost) px-4">
      <nav className="flex items-center gap-1">
        {visibleLeft.map((item) => (
          <TopBarButton key={item.id} item={item} view={view} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="ml-auto" />

      <div className="relative flex items-center gap-2">
        <Status />
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
