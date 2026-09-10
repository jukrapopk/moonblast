import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Settings {
  version: number;
  general: { start_with_windows: boolean; last_view: string };
  integrations: {
    moonlight_folder: string | null;
    moonlight_enabled: boolean;
    apps_enabled: boolean;
    steamgrid_key: string | null;
    /** Auto Immersive also launches the Tailscale GUI at sign-in. */
    auto_tailscale_start: boolean;
  };
  moonlight: {
    resolution: string;
    refresh_rate: string;
    bitrate: number;
    codec: string;
    fullscreen: boolean;
    fps_overlay: boolean;
    gamepad: boolean;
    mouse_smoothing: boolean;
    aspect_ratio: string;
    display_mode: string;
    video_decoder: string;
    vsync: boolean;
    hdr: boolean;
    yuv444: boolean;
    frame_pacing: boolean;
    packet_size: number | null;
    keep_awake: boolean;
    quit_after: boolean;
    game_optimization: boolean;
    audio_config: string;
    audio_on_host: boolean;
    mute_on_focus_loss: boolean;
    multi_controller: boolean;
    background_gamepad: boolean;
    swap_gamepad_buttons: boolean;
    absolute_mouse: boolean;
    mouse_buttons_swap: boolean;
    reverse_scroll_direction: boolean;
    capture_system_keys: string;
  };
  fullscreen: { suppress_explorer: boolean; auto_fullscreen: boolean; auto_immersive: boolean };
  customization: { show_time: boolean; show_date: boolean; show_wifi: boolean; show_battery: boolean; show_audio: boolean };
  machines: { name: string; address: string }[];
  app_shortcuts: { name: string; path: string; source: string; kind: string; display_name: string | null; custom_icon: string | null; use_desktop_icon: boolean; steamgrid_icon: string | null }[];
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  general: { start_with_windows: false, last_view: "apps" },
  integrations: {
    moonlight_folder: null,
    moonlight_enabled: false,
    apps_enabled: true,
    steamgrid_key: null,
    auto_tailscale_start: false,
  },
  moonlight: {
    resolution: "auto",
    refresh_rate: "auto",
    bitrate: 40,
    codec: "Auto",
    fullscreen: true,
    fps_overlay: false,
    gamepad: true,
    mouse_smoothing: false,
    aspect_ratio: "16:9",
    display_mode: "fullscreen",
    video_decoder: "auto",
    vsync: true,
    hdr: false,
    yuv444: false,
    frame_pacing: true,
    packet_size: null,
    keep_awake: true,
    quit_after: false,
    game_optimization: true,
    audio_config: "stereo",
    audio_on_host: false,
    mute_on_focus_loss: true,
    multi_controller: true,
    background_gamepad: false,
    swap_gamepad_buttons: false,
    absolute_mouse: false,
    mouse_buttons_swap: false,
    reverse_scroll_direction: false,
    capture_system_keys: "never",
  },
  fullscreen: { suppress_explorer: false, auto_fullscreen: false, auto_immersive: false },
  customization: { show_time: true, show_date: true, show_wifi: true, show_battery: true, show_audio: true },
  machines: [],
  app_shortcuts: [],
};

interface SettingsContextValue {
  settings: Settings;
  /** True once persisted settings have been loaded from disk. */
  ready: boolean;
  /** Enqueue a change: mutator receives current, returns next; persists + syncs. */
  update: (mutate: (current: Settings) => Settings) => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  ready: false,
  update: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    invoke<Settings>("get_settings")
      .then((s) => {
        setSettings(s);
        setReady(true);
      })
      .catch(() => {});
    const unlisten = listen("settings-changed", (event) => {
      setSettings(event.payload as Settings);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const update = useCallback((mutate: (current: Settings) => Settings) => {
    setSettings((current) => {
      const next = mutate(current);
      // optimistic + persist in the background
      invoke("update_settings", { settings: next }).catch(() => {});
      return next;
    });
  }, []);

  const value = useMemo(() => ({ settings, ready, update }), [settings, ready, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}