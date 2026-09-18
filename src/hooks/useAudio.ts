import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useFocusRefresh } from "./useFocusRefresh";

export interface AudioDevice {
  id: string;
  name: string;
  /** True for the current default output. */
  is_default: boolean;
}

interface AudioDeviceList {
  devices: AudioDevice[];
  default_id: string;
}

export interface AudioMaster {
  /** 0–100. */
  volume: number;
  muted: boolean;
}

export interface AudioSession {
  /** Lowercased exe name — the key for set-volume/mute. */
  id: string;
  /** Display name (`chrome.exe`). */
  name: string;
  /** 0–100. */
  volume: number;
  muted: boolean;
}

/**
 * Main mixer level for the TopBar chip. Event-driven, no polling: the Rust
 * side registers Core Audio callbacks (volume / sessions / devices) and
 * emits `audio-changed`; we just re-read on receipt, on mount, on window
 * `focus` / visible, and on explicit `refresh()`. The COM read is ~1ms on
 * a blocking thread.
 *
 * `enabled` (default `true`) suspends the mount/focus reads and the
 * `audio-changed` subscription entirely — pass `false` when the speaker
 * chip is hidden via Customization. `AudioModal` fetches its own state on
 * open, so hiding the chip never affects the modal's own live data.
 */
export function useAudioMaster(enabled = true): {
  master: AudioMaster | undefined;
  refresh: () => void;
} {
  const [master, setMaster] = useState<AudioMaster | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setMaster(await invoke<AudioMaster>("audio_master"));
    } catch {
      // No audio device (or COM hiccup) — leave the last state alone.
    }
  }, [enabled]);

  // Push channel — volume keys, other mixers, device switches.
  // Core Audio fires volume_on_notify on *every* volume step during a
  // held volume-key press (~30 events/sec). Without collapsing, each
  // event triggers an `audio_master` IPC + a TopBar re-render. Coalesce
  // bursts into one re-read per 250 ms of stillness; the trailing
  // refresh fires after the burst so the chip shows the final value
  // (e.g. the user releases the key at volume 73).
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) return; // already scheduled — coalesce
      timer = setTimeout(() => {
        timer = null;
        if (alive) void refresh();
      }, 250);
    };
    const unlisten = listen("audio-changed", () => {
      if (alive) schedule();
    });
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      void unlisten.then((f) => f());
    };
  }, [refresh, enabled]);

  useFocusRefresh(refresh, [refresh]);

  return { master, refresh };
}

export async function fetchAudioDevices(): Promise<AudioDeviceList> {
  return await invoke<AudioDeviceList>("audio_devices");
}

export async function fetchAudioMaster(): Promise<AudioMaster> {
  return await invoke<AudioMaster>("audio_master");
}

export async function fetchAudioSessions(): Promise<AudioSession[]> {
  return await invoke<AudioSession[]>("audio_sessions");
}

export async function setDefaultDevice(id: string): Promise<void> {
  await invoke("audio_set_default_device", { id });
}

export async function setMasterVolume(volume: number): Promise<void> {
  await invoke("audio_set_master_volume", { volume: Math.round(volume) });
}

export async function setMasterMute(muted: boolean): Promise<void> {
  await invoke("audio_set_master_mute", { muted });
}

export async function setSessionVolume(id: string, volume: number): Promise<void> {
  await invoke("audio_set_session_volume", { id, volume: Math.round(volume) });
}

export async function setSessionMute(id: string, muted: boolean): Promise<void> {
  await invoke("audio_set_session_mute", { id, muted });
}

/** Reset every app channel to max + unmuted. Resolves with sessions touched. */
export async function resetSessionVolumes(): Promise<number> {
  return await invoke<number>("audio_reset_sessions");
}
