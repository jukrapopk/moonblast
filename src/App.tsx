import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { TopBar, type View } from "./components/TopBar";
import { TitleBar } from "./components/TitleBar";
import { AppsView } from "./components/AppsView";
import { MoonlightView } from "./components/MoonlightView";
import { SettingsView } from "./components/SettingsView";
import { useSettings } from "./settings/SettingsContext";
import { useGamepad } from "./hooks/useGamepad";
import { openPowerMenu } from "./hooks/usePowerMenuTrigger";
import { useContextMenu, ContextMenuHost } from "./components/ui/ContextMenu";

export default function App() {
  const { settings, ready, update } = useSettings();

  // Active view is local state; `general.last_view` only records where to *boot*.
  // Settings is excluded from that recording (so the app opens on apps/moonlight
  // next launch) — but it must still be reachable, hence the separate state.
  const [view, setViewState] = useState<View>("apps");
  const setView = (v: View) => {
    setViewState(v);
    if (v !== "settings") {
      update((s) => ({ ...s, general: { ...s.general, last_view: v } }));
    }
  };
  // Settings hydrate asynchronously, so restore the persisted view once, on load.
  const restoredView = useRef(false);
  useEffect(() => {
    if (!ready || restoredView.current) return;
    restoredView.current = true;
    setViewState(settings.general.last_view as View);
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
        showWifi={settings.customization.show_wifi}
        showBattery={settings.customization.show_battery}
        showAudio={settings.customization.show_audio}
      />
      <main className="relative flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <AnimatePresence mode="wait">
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
                showWifi={settings.customization.show_wifi}
                onToggleShowWifi={setShowWifi}
                showBattery={settings.customization.show_battery}
                onToggleShowBattery={setShowBattery}
                showAudio={settings.customization.show_audio}
                onToggleShowAudio={setShowAudio}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      {/* Single global context menu — all views share it. */}
      <ContextMenuHost />
    </div>
  );
}
