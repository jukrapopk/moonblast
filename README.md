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
- **Fullscreen + Immersive Mode** — F11 toggles window fullscreen; **Immersive Mode** (Power menu or F10) adds a clean fullscreen surface that suppresses the Windows desktop/taskbar and minimizes background windows (restored on exit)
- **Auto Immersive Mode** — Settings toggle (requires Start with Windows): boot straight into Immersive Mode on launch
- **Power menu** — Immersive Mode, Fullscreen, Close, Sleep, Reboot, Shutdown (real Windows actions)
- **Apps tab** — searchable, curated grid of Windows apps:
  - discovered from the **Start Menu**, **Microsoft Store**, and **Steam** (with source labels); browse any `.exe`/`.lnk`
  - extracted Windows icons, **SteamGridDB** game icons, and custom images — all cached to disk (`.icons`) for instant, offline reloads
  - rename apps to a custom display name; reusable search / source-filter / A↔Z sort list
- **Context menus** everywhere (right-click replaces the native WebView2 menu) with keyboard + gamepad navigation
- **Moonlight tab** — machines + streaming:
  - mDNS **discovery** of Sunshine/GameStream hosts (paired/unpaired)
  - **Pair / Desktop / Apps** actions per host
  - Drives the **Moonlight QT client** via its CLI (`list`, `pair`, `stream`, `quit`)
- **Persistent settings** — all settings survive restarts
- **Integrations** — auto-detect Tailscale (CLI), select + validate Moonlight install folder

## Architecture

- **Rust backend** (`src-tauri/src/lib.rs`) exposes Tauri commands for window controls, system power, Tailscale, Moonlight CLI (list/pair/stream/quit), host discovery, app launching, immersive mode (`enter_immersive`/`exit_immersive`), startup registration (`set_start_with_windows`), and icon extraction/caching (`app_icon`, `cache_steamgrid_icon`, `import_app_icon`, `clear_cached_icon`).
- **Settings** (`src-tauri/src/settings.rs`) — a typed, versioned `Settings` struct persisted as JSON, written atomically; emits a `settings-changed` event.
- **All persistent data is centralized** in one folder under *Local* AppData: `%LOCALAPPDATA%\com.moonblast.app\` containing `settings.json` and a sibling `.icons\` icon cache. Settings are migrated from the old Roaming (config-dir) location on first run.
- **Frontend** — a React `SettingsProvider` context (single source of truth, hydrates asynchronously on boot) syncs all views; shared `ui/` primitives keep the UI consistent.

## Project structure

```
src/                      # React frontend
  components/
    ui/                   # shared primitives (Toggle, Row, Section, Select, Segmented, Modal, Toast, Input, ContextMenu, FilterList)
    TopBar.tsx            # icon nav + power button
    TitleBar.tsx          # custom window title bar
    PageShell.tsx         # shared page layout
    AppsView.tsx          # Apps tab (curated grid, Store/Steam discovery, icons, rename, context menus)
    MoonlightView.tsx     # Moonlight tab (Machines + Settings)
    MoonlightSettings.tsx # Moonlight streaming settings
    SettingsView.tsx      # app-level settings
    PowerMenu.tsx         # power menu modal
  settings/SettingsContext.tsx  # persistent settings provider
  hooks/useGamepad.ts     # gamepad → keyboard bridge
src-tauri/                # Rust backend
  src/lib.rs              # Tauri commands
  src/settings.rs         # persisted settings
```

## Building for ARM64

Cross-compiling to ARM64 uses the MSVC ARM64 toolchain (installed via VS 2022 C++ build tools):
`ureq` uses Windows native TLS (`native-tls`/schannel) instead of rustls so no C cross-toolchain (clang) is required.

```bash
# from an x64 developer shell, load the ARM64 cross environment first
"D:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat" x64_arm64
npm run tauri build -- --target aarch64-pc-windows-msvc
```

## Development

Prerequisites: Node 22+, Rust + MSVC toolchain, Visual Studio 2022 C++ build tools, WebView2.

```bash
npm install
npm run tauri dev    # run in dev (hot reload)
npm run tauri build  # production bundle
```