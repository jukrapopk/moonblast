import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import { VolumeOsd } from "./components/ui/VolumeOsd";
import { StatusOverlay } from "./components/ui/StatusOverlay";
import { SettingsProvider } from "./settings/SettingsContext";
import { ThemeProvider } from "./settings/ThemeProvider";
import "./styles.css";

// The `osd` window is the always-on-top volume overlay shown while Immersive
// Mode has suppressed Explorer's own volume flyout, and the `overlay` window
// is the persistent status notch. Both share this bundle but render a
// different root; the label is how Rust created them (`osd.rs` / `overlay.rs`).
const label = getCurrentWebviewWindow().label;
const isOsd = label === "osd";
const isOverlay = label === "overlay";
if (isOsd) document.documentElement.dataset.window = "osd";
if (isOverlay) document.documentElement.dataset.window = "overlay";

const Root = isOsd ? VolumeOsd : isOverlay ? StatusOverlay : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <ThemeProvider>
        <Root />
      </ThemeProvider>
    </SettingsProvider>
  </React.StrictMode>,
);
