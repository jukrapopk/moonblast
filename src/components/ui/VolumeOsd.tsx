import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { SpeakerIcon } from "./SpeakerIcon";

/** Payload of the Rust `volume-key` event (see `osd.rs` / `mediakeys.rs`). */
interface VolumeKey {
  volume: number;
  muted: boolean;
}

/**
 * Contents of the `osd` window — the volume level shown while Immersive Mode
 * has Explorer suppressed. Rust owns showing/hiding the window (`osd.rs`); this
 * component just renders the bar whenever a `volume-key` event arrives, so a
 * throttled hidden webview can't keep the overlay from appearing.
 */
export function VolumeOsd() {
  const [level, setLevel] = useState<VolumeKey>({ volume: 0, muted: false });

  useEffect(() => {
    const unlisten = listen<VolumeKey>("volume-key", (e) => setLevel(e.payload));
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const muted = level.muted;
  const pct = muted ? 0 : level.volume;

  return (
    <div className="flex h-full w-full items-center justify-center p-2">
      <div className="flex w-full items-center gap-3 rounded-2xl border border-(--color-border) bg-(--color-surface-2) px-4 py-3 shadow-2xl">
        <SpeakerIcon volume={level.volume} muted={muted} size={26} />
        <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-(--color-surface)">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-(--color-accent) transition-[width] duration-75"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="w-10 text-right text-sm tabular-nums text-(--color-muted)">
          {muted ? "Mute" : level.volume}
        </span>
      </div>
    </div>
  );
}
