import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import { TopBar, type View } from "./components/TopBar";
import { TitleBar } from "./components/TitleBar";
import { AppsView } from "./components/AppsView";
import { MoonlightView } from "./components/MoonlightView";
import { SettingsView } from "./components/SettingsView";
import { useSettings } from "./settings/SettingsContext";
import { useGamepad } from "./hooks/useGamepad";
import { useContextMenu, ContextMenuHost } from "./components/ui/ContextMenu";

export default function App() {
  const { settings, ready, update } = useSettings();

  // Active view is persisted so the last open tab is restored on next launch.
  const view = settings.general.last_view as View;
  const setView = (v: View) =>
    update((s) => ({ ...s, general: { ...s.general, last_view: v } }));
  const [fullscreen, setFullscreen] = useState(false);
  const [immersive, setImmersive] = useState(false);

  const moonlightEnabled = settings.integrations.moonlight_enabled;
  const moonlightDir = settings.integrations.moonlight_folder;
  const appsEnabled = settings.integrations.apps_enabled;

  useGamepad();

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
    // Auto Immersive requires Start with Windows, so reset it when that's off.
    if (!v && settings.fullscreen.auto_immersive) {
      update((s) => ({ ...s, fullscreen: { ...s.fullscreen, auto_immersive: false } }));
    }
  }
  function setAutoImmersive(v: boolean) {
    update((s) => ({ ...s, fullscreen: { ...s.fullscreen, auto_immersive: v } }));
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

  // F11 toggles windowed / fullscreen (disabled while immersed).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F11") {
        e.preventDefault();
        if (!immersive) toggleFullscreen();
      } else if (e.key === "F10") {
        e.preventDefault();
        if (immersive) exitImmersive();
        else enterImmersive();
      } else if (e.key === "Escape" && immersive) {
        e.preventDefault();
        exitImmersive();
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

  // Auto-enter Immersive Mode when enabled. Settings hydrate asynchronously, so
  // wait for `ready` and only ever fire once per session (a later toggle change
  // mid-session must not yank the user into immersive).
  const autoEntered = useRef(false);
  useEffect(() => {
    if (!ready || autoEntered.current) return;
    if (settings.fullscreen.auto_immersive && settings.general.start_with_windows) {
      autoEntered.current = true;
      void enterImmersive();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, settings.fullscreen.auto_immersive, settings.general.start_with_windows]);

  return (
    <div className="relative flex h-full w-full flex-col">
      {!fullscreen && <TitleBar fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />}
      <TopBar
        view={view}
        onNavigate={setView}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        immersive={immersive}
        onToggleImmersive={enterImmersive}
        showMoonlight={moonlightEnabled && moonlightDir !== null}
        showApps={appsEnabled}
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
