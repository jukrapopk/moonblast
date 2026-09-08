import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import { TopBar, type View } from "./components/TopBar";
import { TitleBar } from "./components/TitleBar";
import { AppsView } from "./components/AppsView";
import { MoonlightView } from "./components/MoonlightView";
import { SettingsView } from "./components/SettingsView";
import { useSettings } from "./settings/SettingsContext";
import { useGamepad } from "./hooks/useGamepad";
import { useContextMenu } from "./components/ui/ContextMenu";

export default function App() {
  const { settings, update } = useSettings();

  // Active view is persisted so the last open tab is restored on next launch.
  const view = settings.general.last_view as View;
  const setView = (v: View) =>
    update((s) => ({ ...s, general: { ...s.general, last_view: v } }));
  const [fullscreen, setFullscreen] = useState(false);

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

  // F11 toggles windowed / fullscreen.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F11") {
        e.preventDefault();
        toggleFullscreen();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full w-full flex-col">
      {!fullscreen && <TitleBar fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />}
      <TopBar
        view={view}
        onNavigate={setView}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
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
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      {pageCtx.render}
    </div>
  );
}
