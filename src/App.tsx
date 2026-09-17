import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { CircleNotch } from "@phosphor-icons/react";
import { TopBar, type View } from "./components/TopBar";
import { TitleBar } from "./components/TitleBar";
import { AppsView } from "./components/AppsView";
import { MoonlightView } from "./components/MoonlightView";
import { PowerMenu } from "./components/PowerMenu";
import { SettingsView, DisplaySettingsModal } from "./components/SettingsView";
import { useSettings, useSettingsField } from "./settings/SettingsContext";
import { useAudioMaster } from "./hooks/useAudio";
import { useBattery } from "./hooks/useBattery";
import { useFocusOnHover } from "./hooks/useFocusOnHover";
import { useLrudMode } from "./hooks/useLrudMode";
import { useSpatialController } from "./input/useSpatialController";
import { openPowerMenu, usePowerMenuTrigger } from "./hooks/usePowerMenuTrigger";
import { useWifi } from "./hooks/useWifi";
import { AudioModal } from "./components/ui/AudioModal";
import { BatteryModal } from "./components/ui/BatteryModal";
import { useContextMenu, ContextMenuHost } from "./components/ui/ContextMenu";
import { WifiModal } from "./components/ui/WifiModal";

// Session-only view override — let users refresh (F5) on the Settings page
// without losing their place, while still always booting the launcher into
// the last *content* view (apps or moonlight). sessionStorage is per-tab and
// cleared at process exit, so a fresh launch never inherits it.
const SESSION_VIEW_KEY = "moonblast.session_view";

function readSessionView(): View | null {
  try {
    const v = sessionStorage.getItem(SESSION_VIEW_KEY);
    if (v === "apps" || v === "moonlight" || v === "settings") return v;
  } catch {
    /* sessionStorage may be unavailable */
  }
  return null;
}

function writeSessionView(v: View) {
  try {
    sessionStorage.setItem(SESSION_VIEW_KEY, v);
  } catch {
    /* ignore */
  }
}

export default function App() {
  useLrudMode();
  useFocusOnHover();
  const { settings, ready, update } = useSettings();

  // `view` starts at `null` so the first paint doesn't flash the default
  // (apps) before settings hydrate and we restore the persisted one. The
  // loader below is shown instead.
  const [view, setViewState] = useState<View | null>(null);
  const setView = (v: View) => {
    setViewState(v);
    // Track the active view in sessionStorage so F5 / Ctrl+R on the
    // Settings page keeps you there, but the persisted `last_view` is
    // only updated for content views — that's what dictates the next
    // launch's landing page.
    writeSessionView(v);
    if (v !== "settings") {
      update((s) => ({ ...s, general: { ...s.general, last_view: v } }));
    }
  };
  // Settings hydrate asynchronously. Restore the persisted view once, on
  // load. Order of preference: session-only override (refresh on Settings
  // page) > persisted last_view > default.
  const restoredView = useRef(false);
  useEffect(() => {
    if (!ready || restoredView.current) return;
    restoredView.current = true;
    const sessionView = readSessionView();
    setViewState(sessionView ?? (settings.general.last_view as View));
    // Focus the active TopBar nav button on launch so the user has a
    // starting point for keyboard nav without an initial Tab. Double
    // `requestAnimationFrame` defers past the loader's exit-animation
    // AND past the React commit for the view-state update above —
    // guarantees the `[data-active-view]` attribute is on the right
    // button before we look it up. Single-shot via the `restoredView`
    // guard.
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const active = document.querySelector<HTMLElement>(
          '[data-active-view]:not([data-active-view=""]):not([data-active-view="false"])',
        );
        active?.focus();
      }),
    );
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  const [fullscreen, setFullscreen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  // Current Windows accent color (DWM colorization). Pushed by the
  // Rust watcher via `windows-accent-changed`. Surfaced into the
  // Appearance → Color picker so the "Auto" swatch can preview the
  // live value.
  const [windowsAccent, setWindowsAccent] = useState<string | null>(null);
  useEffect(() => {
    invoke<string | null>("windows_accent_color")
      .then(setWindowsAccent)
      .catch(() => {});
    const unlistenP = listen<string>("windows-accent-changed", (e) => {
      setWindowsAccent(e.payload);
    });
    return () => {
      unlistenP.then((f) => f());
    };
  }, []);

  const moonlightEnabled = settings.integrations.moonlight_enabled;
  const moonlightDir = settings.integrations.moonlight_folder;
  const appsEnabled = settings.integrations.apps_enabled;

  // Single global keyboard listener. Arrow keys route through the
  // spatial manager; Escape goes to the LIFO stack of modal/menu
  // handlers. Tab is intentionally not intercepted — native browser
  // focus traversal handles form controls / buttons / links in
  // document order.
  useSpatialController();

  // Rust intercepts Alt+F4 / taskbar-Close while in Immersive Mode and
  // asks the frontend to open the Power menu via this event. The
  // interception lives in `on_window_event` in lib.rs.
  useEffect(() => {
    const unlisten = listen("request-power-menu", () => {
      openPowerMenu();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Kill the WebView's native context menu and provide our own "Refresh" menu
  // for any right-click not handled by a more specific menu. An element is
  // considered "specific" when it (or an ancestor) carries the
  // `data-context-menu` attribute — AppsView AppTiles, MoonlightView
  // HostCards, WifiModal NetworkRows, and the shared Input all set it.
  // The Shift+F10 / ContextMenu-key shortcut in `useSpatialController`
  // synthesises a contextmenu event on `document.activeElement`, which
  // bubbles up the same way a real right-click would.
  const pageCtx = useContextMenu();
  useEffect(() => {
    function onCapture(e: Event) {
      e.preventDefault();
    }
    function onBubble(e: Event) {
      const target = e.target as Element | null;
      if (target?.closest("[data-context-menu]")) return;
      const me = e as MouseEvent;
      // Propagate the keyboard flag the spatial controller stamps on
      // synthetic contextmenu events so the menu knows whether to
      // autoFocus its first item (keyboard) or stay mouse-only (mouse
      // right-click).
      const keyboard = "__keyboard" in me && (me as MouseEvent & { __keyboard?: boolean }).__keyboard === true;
      pageCtx.openAt(me.clientX, me.clientY, keyboard, [
        { label: "Refresh", onClick: () => window.location.reload() },
      ]);
    }
    document.addEventListener("contextmenu", onCapture, true);
    document.addEventListener("contextmenu", onBubble);
    return () => {
      document.removeEventListener("contextmenu", onCapture, true);
      document.removeEventListener("contextmenu", onBubble);
    };
  }, []);

  // Suppress the focus shift that the browser performs on right-click
  // mousedown so right-clicking an element to open its context menu
  // doesn't draw a focus ring under the menu and doesn't move focus
  // off the previously-focused element. The context menu's own
  // close-time focus restoration (in ContextMenu.tsx) lands back on
  // whatever had focus before — which is correct when right-click
  // never moved focus in the first place.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2) e.preventDefault();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  // If apps are disabled, fall back to another view so we don't stay stuck.
  useEffect(() => {
    if (!appsEnabled && view === "apps") setView("moonlight");
  }, [appsEnabled, view]);

  // Modal open state — owned at the App level so both the TopBar chips
  // and the Preferences gear buttons in Settings can open the same
  // modals. The modals themselves also render at the App level (alongside
  // `<main>` and DisplaySettingsModal) so they're not descendants of the
  // TopBar `<header>` — keeping them out of the TopBar's lrud-container
  // ancestor chain means TopBar's `data-lrud-scope-lock="horizontal"`
  // can't override the modal's spatial scope and leak arrows out to the
  // TopBar buttons.
  const [wifiOpen, setWifiOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [batteryOpen, setBatteryOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [powerOpen, setPowerOpen] = useState(false);

  // Data hooks for the status modals. Live here (not in TopBar) so the
  // modals can render at the App root.
  const { current: wifi, refresh: refreshWifi } = useWifi();
  useEffect(() => {
    refreshWifi();
  }, [wifiOpen, refreshWifi]);
  const { master: audio, refresh: refreshAudio } = useAudioMaster();
  useEffect(() => {
    if (!audioOpen) refreshAudio();
  }, [audioOpen, refreshAudio]);
  const { status: battery, refresh: refreshBattery } = useBattery();
  useEffect(() => {
    if (!batteryOpen) refreshBattery();
  }, [batteryOpen, refreshBattery]);

  // Rust intercepts Alt+F4 / taskbar-Close while in Immersive Mode and
  // asks us to open the Power menu. Subscribe here so the trigger reaches
  // App-owned state (TopBar no longer manages PowerMenu).
  const { subscribe: subscribePower } = usePowerMenuTrigger();
  useEffect(() => subscribePower(() => setPowerOpen(true)), [subscribePower]);

  const setAppsEnabled = useSettingsField("integrations", "apps_enabled");
  const setMoonlightEnabled = useSettingsField("integrations", "moonlight_enabled");
  const setMoonlightDir = useSettingsField("integrations", "moonlight_folder");
  // Empty-string → null keeps an accidentally-cleared key from being
  // persisted as the string "".
  function setSteamgridKey(k: string) {
    update((s) => ({ ...s, integrations: { ...s.integrations, steamgrid_key: k || null } }));
  }

  // One switch: registers Moonblast as the Windows shell *and* arms Immersive
  // Mode for the next sign-in. Deliberately does not enter Immersive Mode now.
  // The shell stub is the only boot-launch path; nothing else to coordinate.
  function setAutoImmersive(v: boolean) {
    update((s) => ({ ...s, fullscreen: { ...s.fullscreen, auto_immersive: v } }));
    void invoke("apply_auto_immersive", { autoImmersive: v }).catch(() => {});
  }

  const setShowTime = useSettingsField("customization", "show_time");
  const setShowDate = useSettingsField("customization", "show_date");
  const setShowDisplay = useSettingsField("customization", "show_display");
  const setShowWifi = useSettingsField("customization", "show_wifi");
  const setShowBattery = useSettingsField("customization", "show_battery");
  const setShowAudio = useSettingsField("customization", "show_audio");

  // Appearance — ThemeProvider observes settings.appearance via the
  // SettingsContext, so writing here triggers a re-apply on the next
  // render. The inline bootstrap script in index.html reads
  // localStorage to avoid a flash on subsequent loads.
  const setTheme = useSettingsField("appearance", "theme");
  const setAccent = useSettingsField("appearance", "accent");
  const setCustomAccent = useSettingsField("appearance", "custom_accent");

  // Sync the initial fullscreen state.
  useEffect(() => {
    invoke<boolean>("is_fullscreen").then(setFullscreen).catch(() => {});
  }, []);

  async function toggleFullscreen() {
    try {
      const next = await invoke<boolean>("toggle_fullscreen");
      setFullscreen(next);
    } catch {
      // ignore
    }
  }

  // F11 toggles windowed / fullscreen (disabled while immersed). Immersive
  // Mode is exited only through the Power menu — there's no keyboard
  // shortcut for it, by design (immersive is meant to feel inescapable
  // while the user is gaming).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F11") {
        e.preventDefault();
        if (!immersive) toggleFullscreen();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [immersive]);

  async function enterImmersive() {
    try {
      await invoke("enter_immersive");
      setImmersive(true);
      setFullscreen(true);
    } catch {
      // ignore
    }
  }
  async function exitImmersive() {
    try {
      await invoke("exit_immersive");
    } catch {
      // ignore
    }
    // Bring the window back to windowed (immersive forced fullscreen).
    if (fullscreen) {
      try {
        await invoke("toggle_fullscreen");
      } catch {
        // ignore
      }
    }
    setImmersive(false);
    setFullscreen(false);
  }

  // Auto-enter Immersive Mode, but only when the shell stub started us at
  // sign-in (`booted_as_shell`). The decision is made once, the moment settings
  // hydrate — so toggling the setting later never yanks the user into it.
  const autoEntered = useRef(false);
  useEffect(() => {
    if (!ready || autoEntered.current) return;
    autoEntered.current = true;
    if (!settings.fullscreen.auto_immersive) return;
    void invoke<boolean>("booted_as_shell")
      .then((boot) => {
        if (boot) {
          void enterImmersive();
          // Apps flagged with `auto_launch` fire here too — staggered 250 ms
          // apart on the Rust side so multiple autolaunch apps don't fight
          // for focus. Gated on `booted_as_shell` because manual launches
          // shouldn't surprise the user with an autostart cascade.
          void invoke("launch_autolaunch_apps").catch(() => {});
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <div className="relative flex h-full w-full flex-col">
      {!fullscreen && <TitleBar fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />}
      <TopBar
        view={view}
        onNavigate={setView}
        showMoonlight={moonlightEnabled && moonlightDir !== null}
        showApps={appsEnabled}
        showTime={settings.customization.show_time}
        showDate={settings.customization.show_date}
        showDisplay={settings.customization.show_display}
        showWifi={settings.customization.show_wifi}
        showBattery={settings.customization.show_battery}
        showAudio={settings.customization.show_audio}
        batteryOpen={batteryOpen}
        onWifiClick={() => setWifiOpen(true)}
        onAudioClick={() => setAudioOpen(true)}
        onBatteryClick={() => setBatteryOpen(true)}
        displayOpen={displayOpen}
        onDisplayClick={() => setDisplayOpen(true)}
        powerOpen={powerOpen}
        onPowerClick={() => setPowerOpen((o) => !o)}
        wifi={wifi}
        audio={audio}
        battery={battery}
      />
      <main data-lrud-scope-lock="all" className="relative flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <AnimatePresence mode="wait">
          {view === null && (
            <motion.div
              key="loading"
              className="flex h-full items-center justify-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              <CircleNotch
                size={28}
                weight="bold"
                className="animate-spin text-(--color-muted)"
              />
            </motion.div>
          )}
          {view === "apps" && (
            <motion.div key="apps" className="p-8">
              <AppsView />
            </motion.div>
          )}
          {view === "moonlight" && (
            <motion.div key="moonlight" className="p-8">
              <MoonlightView />
            </motion.div>
          )}
          {view === "settings" && (
            <motion.div key="settings" className="p-8">
              <SettingsView
                moonlightEnabled={moonlightEnabled}
                onToggleMoonlight={setMoonlightEnabled}
                moonlightDir={moonlightDir}
                onSelectMoonlight={setMoonlightDir}
                appsEnabled={appsEnabled}
                onToggleApps={setAppsEnabled}
                steamgridKey={settings.integrations.steamgrid_key}
                onSetSteamgridKey={setSteamgridKey}
                autoImmersive={settings.fullscreen.auto_immersive}
                onToggleAutoImmersive={setAutoImmersive}
                showTime={settings.customization.show_time}
                onToggleShowTime={setShowTime}
                showDate={settings.customization.show_date}
                onToggleShowDate={setShowDate}
                showDisplay={settings.customization.show_display}
                onToggleShowDisplay={setShowDisplay}
                showWifi={settings.customization.show_wifi}
                onToggleShowWifi={setShowWifi}
                showBattery={settings.customization.show_battery}
                onToggleShowBattery={setShowBattery}
                showAudio={settings.customization.show_audio}
                onToggleShowAudio={setShowAudio}
                onOpenWifi={() => setWifiOpen(true)}
                onOpenAudio={() => setAudioOpen(true)}
                onOpenBattery={() => setBatteryOpen(true)}
                onOpenDisplay={() => setDisplayOpen(true)}
                theme={settings.appearance.theme}
                onSetTheme={setTheme}
                accent={settings.appearance.accent}
                customAccent={settings.appearance.custom_accent}
                windowsAccent={windowsAccent}
                onSetAccent={setAccent}
                onSetCustomAccent={setCustomAccent}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      {/* Single global context menu — all views share it. */}
      <ContextMenuHost />
      <DisplaySettingsModal
        open={displayOpen}
        onClose={() => setDisplayOpen(false)}
      />
      <WifiModal
        open={wifiOpen}
        onClose={() => setWifiOpen(false)}
        currentSsid={wifi?.ssid ?? null}
        radioOn={wifi?.radioOn ?? null}
      />
      <AudioModal
        open={audioOpen}
        onClose={() => setAudioOpen(false)}
        onChanged={refreshAudio}
      />
      <BatteryModal open={batteryOpen} onClose={() => setBatteryOpen(false)} />
      <PowerMenu
        open={powerOpen}
        onClose={() => setPowerOpen(false)}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        immersive={immersive}
        onToggleImmersive={immersive ? exitImmersive : enterImmersive}
      />
    </div>
  );
}
