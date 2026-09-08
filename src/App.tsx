import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { TopBar, type View } from "./components/TopBar";
import { AppsView } from "./components/AppsView";
import { MoonlightView } from "./components/MoonlightView";
import { SettingsView } from "./components/SettingsView";

export default function App() {
  const [view, setView] = useState<View>("apps");

  return (
    <div className="flex h-full w-full flex-col">
      <TopBar view={view} onNavigate={setView} />
      <main className="relative flex-1 overflow-y-auto">
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
            <motion.div key="settings" className="mx-auto max-w-4xl p-8">
              <SettingsView />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
