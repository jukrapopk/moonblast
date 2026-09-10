import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface AudioDevice {
  id: string;
  name: string;
  /** True for the current default output. */
  is_default: boolean;
}

export interface AudioDeviceList {
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
 */
export function useAudioMaster(): {
  master: AudioMaster | undefined;
  refresh: () => void;
} {
  const [master, setMaster] = useState<AudioMaster | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setMaster(await invoke<AudioMaster>("audio_master"));
    } catch {
      // No audio device (or COM hiccup) — leave the last state alone.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const safe = () => {
      if (alive) void refresh();
    };
    safe();
    // Push channel — volume keys, other mixers, device switches.
    void listen("audio-changed", safe).then((f) => {
      unlisten = f;
    });
    function onFocus() {
      safe();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") safe();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      unlisten?.();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

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
