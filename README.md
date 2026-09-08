# Moonblast

A lightweight, low-footprint **Fullscreen Mode / Big Picture-style launcher** for Windows. Moonblast is a clean, modern shell for launching Windows apps and streaming via **Moonlight**. It's built to be minimal on RAM/CPU, with a native custom title bar and a fullscreen-friendly UI.

## Stack

| Layer   | Tech |
|---------|------|
| UI      | React 19 + TypeScript + Vite |
| Styling | Tailwind CSS v4 + Framer Motion + Phosphor icons |
| Backend | Rust (Tauri 2) |
| Window  | WebView2 (already on Windows 10/11) |

## Features

- **Custom frameless title bar** — drag region + minimize / maximize / close, hiding in fullscreen
- **Power menu** — Fullscreen, Close, Sleep, Reboot, Shutdown (real Windows actions)
- **F11** toggles fullscreen
- **Apps tab** — searchable, curated grid of Windows apps
- **Moonlight tab** — machines + streaming:
  - mDNS **discovery** of Sunshine/GameStream hosts (paired/unpaired)
  - **Pair / Desktop / Apps** actions per host
  - Drives the **Moonlight QT client** via its CLI (`list`, `pair`, `stream`, `quit`)
- **Persistent settings** — all settings survive restarts
- **Integrations** — auto-detect Tailscale (CLI), select + validate Moonlight install folder

## Architecture

- **Rust backend** (`src-tauri/src/lib.rs`) exposes Tauri commands for window controls, system power, Tailscale, Moonlight CLI, host discovery, and settings.
- **Settings** (`src-tauri/src/settings.rs`) — a typed, versioned `Settings` struct persisted as JSON in the OS app-config dir, written atomically; emits a `settings-changed` event.
- **Frontend** — a React `SettingsProvider` context (single source of truth) hydrates on boot and syncs all views; shared `ui/` primitives keep the UI consistent.

## Project structure

```
src/                      # React frontend
  components/
    ui/                   # shared primitives (Toggle, Row, Section, Select, Segmented, Modal, Toast)
    TopBar.tsx            # icon nav + power button
    TitleBar.tsx          # custom window title bar
    PageShell.tsx         # shared page layout
    AppsView.tsx          # Apps tab
    MoonlightView.tsx     # Moonlight tab (Machines + Settings)
    MoonlightSettings.tsx # Moonlight streaming settings
    SettingsView.tsx      # app-level settings
    PowerMenu.tsx         # power menu modal
  settings/SettingsContext.tsx  # persistent settings provider
  data.ts                 # placeholder app catalog
src-tauri/                # Rust backend
  src/lib.rs              # Tauri commands
  src/settings.rs         # persisted settings
```

## Development

Prerequisites: Node 22+, Rust + MSVC toolchain, Visual Studio 2022 C++ build tools, WebView2.

```bash
npm install
npm run tauri dev    # run in dev (hot reload)
npm run tauri build  # production bundle
```