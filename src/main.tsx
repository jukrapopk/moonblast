import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import { Osd } from "./components/ui/Osd";
import { SettingsProvider } from "./settings/SettingsContext";
import { ThemeProvider } from "./settings/ThemeProvider";
import "./styles.css";

// The `osd` window is the always-on-top volume/brightness overlay shown while
// Immersive Mode has suppressed Explorer's own flyout. It shares this bundle
// but renders a different root; the label is how Rust created it (see osd.rs).
const isOsd = getCurrentWebviewWindow().label === "osd";
if (isOsd) document.documentElement.dataset.window = "osd";

const Root = isOsd ? Osd : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <ThemeProvider>
        <Root />
      </ThemeProvider>
    </SettingsProvider>
  </React.StrictMode>,
);
