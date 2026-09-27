import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Sun } from "@phosphor-icons/react";
import { SpeakerIcon } from "./SpeakerIcon";

/** Payload of the Rust `osd-show` event (see `osd.rs`). */
interface OsdPayload {
  kind: "volume" | "brightness";
  value: number;
  muted: boolean;
  /** Bar range — brightness uses the monitor's own min/max, volume is 0–100. */
  min: number;
  max: number;
}

/**
 * Contents of the `osd` window — the volume/brightness overlay shown while
 * Immersive Mode has Explorer suppressed. Rust owns showing/hiding the window
 * (`osd.rs`); this component just renders the bar whenever an `osd-show` event
 * arrives, so a throttled hidden webview can't keep the overlay from appearing.
 */
export function Osd() {
  const [state, setState] = useState<OsdPayload | null>(null);

  useEffect(() => {
    const unlisten = listen<OsdPayload>("osd-show", (e) => setState(e.payload));
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const kind = state?.kind ?? "volume";
  const value = state?.value ?? 0;
  const muted = state?.muted ?? false;
  const min = state?.min ?? 0;
  const max = state?.max ?? 100;
  const span = Math.max(1, max - min);
  const pct = muted ? 0 : Math.round(((value - min) / span) * 100);

  return (
    <div className="flex h-full w-full items-center justify-center p-2">
      <div className="flex w-full items-center gap-3 rounded-2xl border border-(--color-border) bg-(--color-surface-2) px-4 py-3 shadow-2xl">
        {kind === "brightness" ? (
          <Sun size={26} weight="bold" />
        ) : (
          <SpeakerIcon volume={value} muted={muted} size={26} />
        )}
        <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-(--color-surface)">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-(--color-accent) transition-[width] duration-75"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="w-10 text-right text-sm tabular-nums text-(--color-muted)">
          {muted ? "Mute" : value}
        </span>
      </div>
    </div>
  );
}
