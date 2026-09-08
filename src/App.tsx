import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { TopBar, type View } from "./components/TopBar";
import { HomeView } from "./components/HomeView";
import { LibraryView } from "./components/LibraryView";
import { SettingsView } from "./components/SettingsView";

export default function App() {
  const [view, setView] = useState<View>("home");

  // TODO (later step): launch Moonlight for the selected game via the Rust backend.
  function openGame(gameId: string) {
    console.log("open game", gameId);
  }

  return (
    <div className="flex h-full w-full flex-col">
      <TopBar view={view} onNavigate={setView} />
      <main className="relative flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {view === "home" && (
            <motion.div key="home" className="p-8">
              <HomeView onOpenGame={openGame} />
            </motion.div>
          )}
          {view === "library" && (
            <motion.div key="library" className="mx-auto max-w-6xl p-8">
              <LibraryView onOpenGame={openGame} />
            </motion.div>
          )}
          {view === "settings" && (
            <motion.div key="settings" className="mx-auto max-w-4xl p-8">
              <SettingsView />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
