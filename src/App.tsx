import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import { TopBar, type View } from "./components/TopBar";
import { TitleBar } from "./components/TitleBar";
import { AppsView } from "./components/AppsView";
import { MoonlightView } from "./components/MoonlightView";
import { SettingsView } from "./components/SettingsView";

export default function App() {
  const [view, setView] = useState<View>("apps");
  const [fullscreen, setFullscreen] = useState(false);
  const [moonlightEnabled, setMoonlightEnabled] = useState(false);
  const [moonlightDir, setMoonlightDir] = useState<string | null>(null);

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
      {!fullscreen && <TitleBar />}
      <TopBar
        view={view}
        onNavigate={setView}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        showMoonlight={moonlightEnabled && moonlightDir !== null}
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
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
