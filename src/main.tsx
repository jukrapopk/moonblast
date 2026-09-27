import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import { VolumeOsd } from "./components/ui/VolumeOsd";
import { StreamMenu } from "./components/ui/StreamMenu";
import { StreamButton } from "./components/ui/StreamButton";
import { SettingsProvider } from "./settings/SettingsContext";
import { ThemeProvider } from "./settings/ThemeProvider";
import "./styles.css";

// Auxiliary windows share this bundle but render a different root:
//   - `osd` — the always-on-top volume overlay (see osd.rs)
//   - `stream-menu` — the in-stream floating menu over a Moonlight stream
//   - `stream-button` — its draggable trigger handle (see overlay.rs)
// The labels are how Rust created them.
const label = getCurrentWebviewWindow().label;
const isOsd = label === "osd";
const isStreamMenu = label === "stream-menu";
const isStreamButton = label === "stream-button";
if (isOsd) document.documentElement.dataset.window = "osd";
else if (isStreamMenu) document.documentElement.dataset.window = "stream-menu";
else if (isStreamButton) document.documentElement.dataset.window = "stream-button";

const Root = isOsd
  ? VolumeOsd
  : isStreamMenu
    ? StreamMenu
    : isStreamButton
      ? StreamButton
      : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <ThemeProvider>
        <Root />
      </ThemeProvider>
    </SettingsProvider>
  </React.StrictMode>,
);
