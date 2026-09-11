import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { CircleNotch } from "@phosphor-icons/react";
import { TopBar, type View } from "./components/TopBar";
import { TitleBar } from "./components/TitleBar";
import { AppsView } from "./components/AppsView";
import { MoonlightView } from "./components/MoonlightView";
import { SettingsView, DisplaySettingsModal } from "./components/SettingsView";
import { useSettings } from "./settings/SettingsContext";
import { useGamepad } from "./hooks/useGamepad";
import { openPowerMenu } from "./hooks/usePowerMenuTrigger";
import { useContextMenu, ContextMenuHost } from "./components/ui/ContextMenu";

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  const [fullscreen, setFullscreen] = useState(false);
  const [immersive, setImmersive] = useState(false);

  const moonlightEnabled = settings.integrations.moonlight_enabled;
  const moonlightDir = settings.integrations.moonlight_folder;
  const appsEnabled = settings.integrations.apps_enabled;

  useGamepad();

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

  // Kill the WebView's native context menu and provide our own "Back/Refresh" menu
  // for any right-click not handled by a more specific menu.
  const pageCtx = useContextMenu();
  useEffect(() => {
    function onCapture(e: Event) {
      e.preventDefault();
    }
    // Any input/textarea right-click is handled by the shared `Input`/textarea
    // components (they stopPropagation), so here we only serve the generic menu.
    function onBubble(e: Event) {
      const me = e as MouseEvent;
      pageCtx.openAt(me.clientX, me.clientY, [
        { label: "Back", disabled: history.length <= 1, onClick: () => window.history.back() },
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

  // Tab / Shift+Tab switches the top-level view (keyboard + gamepad LB/RB).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Tab") {
        e.preventDefault();
        if (view === null) return;
        const order: View[] = ["apps", "moonlight", "settings"];
        let i = order.indexOf(view);
        if (e.shiftKey) i = (i - 1 + order.length) % order.length;
        else i = (i + 1) % order.length;
        setView(order[i]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  // If apps are disabled, fall back to another view so we don't stay stuck.
  useEffect(() => {
    if (!appsEnabled && view === "apps") setView("moonlight");
  }, [appsEnabled, view]);

  // Modal open state — owned at the App level so both the TopBar chips
  // and the Preferences gear buttons in Settings can open the same
  // WifiModal / AudioModal / BatteryModal. The modals themselves stay
  // in TopBar (rendered alongside the chips) since they need the hook
  // data (currentSsid, master volume, battery percent) that's bound
  // there.
  const [wifiOpen, setWifiOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [batteryOpen, setBatteryOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);

  function setAppsEnabled(v: boolean) {
    update((s) => ({ ...s, integrations: { ...s.integrations, apps_enabled: v } }));
  }
  function setSteamgridKey(k: string) {
    update((s) => ({ ...s, integrations: { ...s.integrations, steamgrid_key: k || null } }));
  }

  function setMoonlightEnabled(v: boolean) {
    update((s) => ({
      ...s,
      integrations: { ...s.integrations, moonlight_enabled: v },
    }));
  }
  function setMoonlightDir(dir: string) {
    update((s) => ({
      ...s,
      integrations: { ...s.integrations, moonlight_folder: dir },
    }));
  }
  function setStartWithWindows(v: boolean) {
    update((s) => ({ ...s, general: { ...s.general, start_with_windows: v } }));
    void invoke("set_start_with_windows", { enabled: v }).catch(() => {});
    // Auto Immersive builds on starting with Windows, so turning that off also
    // disarms it — including unregistering the shell, or the takeover would
    // survive with no visible setting left switched on.
    if (!v && settings.fullscreen.auto_immersive) {
      update((s) => ({ ...s, fullscreen: { ...s.fullscreen, auto_immersive: false } }));
      void invoke("set_replace_desktop", { enabled: false }).catch(() => {});
    }
  }
  // One switch: registers Moonblast as the Windows shell *and* arms Immersive
  // Mode for the next sign-in. Deliberately does not enter Immersive Mode now.
  function setAutoImmersive(v: boolean) {
    update((s) => ({ ...s, fullscreen: { ...s.fullscreen, auto_immersive: v } }));
    void invoke("set_replace_desktop", { enabled: v }).catch(() => {});
  }
  function setShowTime(v: boolean) {
    update((s) => ({ ...s, customization: { ...s.customization, show_time: v } }));
  }
  function setShowDate(v: boolean) {
    update((s) => ({ ...s, customization: { ...s.customization, show_date: v } }));
  }
  function setShowDisplay(v: boolean) {
    update((s) => ({ ...s, customization: { ...s.customization, show_display: v } }));
  }
  function setShowWifi(v: boolean) {
    update((s) => ({ ...s, customization: { ...s.customization, show_wifi: v } }));
  }
  function setShowBattery(v: boolean) {
    update((s) => ({ ...s, customization: { ...s.customization, show_battery: v } }));
  }
  function setShowAudio(v: boolean) {
    update((s) => ({ ...s, customization: { ...s.customization, show_audio: v } }));
  }

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
        if (boot) void enterImmersive();
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
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        immersive={immersive}
        onToggleImmersive={immersive ? exitImmersive : enterImmersive}
        showMoonlight={moonlightEnabled && moonlightDir !== null}
        showApps={appsEnabled}
        showTime={settings.customization.show_time}
        showDate={settings.customization.show_date}
        showDisplay={settings.customization.show_display}
        showWifi={settings.customization.show_wifi}
        showBattery={settings.customization.show_battery}
        showAudio={settings.customization.show_audio}
        wifiOpen={wifiOpen}
        setWifiOpen={setWifiOpen}
        audioOpen={audioOpen}
        setAudioOpen={setAudioOpen}
        batteryOpen={batteryOpen}
        setBatteryOpen={setBatteryOpen}
        displayOpen={displayOpen}
        setDisplayOpen={setDisplayOpen}
      />
      <main className="relative flex-1 overflow-y-auto [scrollbar-gutter:stable]">
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
                startWithWindows={settings.general.start_with_windows}
                onToggleStartWithWindows={setStartWithWindows}
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
    </div>
  );
}
