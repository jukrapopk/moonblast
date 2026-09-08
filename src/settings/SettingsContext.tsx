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
  general: { start_with_windows: boolean };
  integrations: {
    moonlight_folder: string | null;
    moonlight_enabled: boolean;
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
  };
  fullscreen: { suppress_explorer: boolean; auto_fullscreen: boolean };
  machines: { name: string; address: string }[];
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  general: { start_with_windows: false },
  integrations: {
    moonlight_folder: null,
    moonlight_enabled: false,
  },
  moonlight: {
    resolution: "1920×1080",
    refresh_rate: "60 Hz",
    bitrate: 40,
    codec: "Auto",
    fullscreen: true,
    fps_overlay: false,
    gamepad: true,
    mouse_smoothing: false,
  },
  fullscreen: { suppress_explorer: false, auto_fullscreen: false },
  machines: [],
};

interface SettingsContextValue {
  settings: Settings;
  /** Enqueue a change: mutator receives current, returns next; persists + syncs. */
  update: (mutate: (current: Settings) => Settings) => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  update: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    invoke<Settings>("get_settings")
      .then(setSettings)
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

  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}