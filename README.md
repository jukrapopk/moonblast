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

- **Custom frameless title bar** — drag region + minimize / maximize / close, hiding in fullscreen.
- **Fullscreen + Immersive Mode** — F11 toggles window fullscreen; **Immersive Mode** (Power menu) adds a clean fullscreen surface that suppresses the Windows desktop/taskbar and minimizes background windows (restored on exit).
- **Auto Immersive Mode** — one Settings toggle (requires Start with Windows) that makes Moonblast your Windows shell: signing in goes straight into the launcher, fullscreen, instead of the desktop. Registered per-user (`Winlogon\Shell`), so there's **no UAC prompt, ever**. Explorer never starts, which means no desktop/taskbar flash and no startup apps at all (Explorer is what runs them). Toggling it only arms the *next* sign-in — it never drops you into Immersive Mode on the spot. Exiting Immersive Mode or closing Moonblast hands the desktop back; a stub supervisor guarantees a working desktop even if Moonblast crashes, and holding **Shift** at sign-in restores the normal desktop.
- **Power menu** — Immersive Mode, Fullscreen ⇄ Windowed, Close, Sleep, Reboot, Shutdown (real Windows actions via `SetSuspendState` / `shutdown.exe`).
- **Apps tab** — searchable, curated grid of Windows apps:
  - discovered from the **Start Menu**, **Microsoft Store** (AUMID via `Get-StartApps`), and **Steam** (registry + `appmanifest_*.acf` / `libraryfolders.vdf`, with source labels); browse any `.exe`/`.lnk`.
  - **icon resolution**: custom file → pinned SteamGridDB icon → SteamGridDB by app name → extracted Windows desktop icon → gradient auto. All non-custom icons are cached on disk in `.icons` for instant, offline reloads.
  - **Copy From Clipboard** action: pull an image from the clipboard (raw image, `data:` URI, https URL, or raw base64), encode to PNG, cache into `.icons`. Action is grayed out when the clipboard has nothing usable.
  - rename apps to a custom display name; reusable search / source-filter / A↔Z / Z↔A sort list.
- **Right-click context menus** everywhere (replacing the native WebView2 menu): per-app, per-host, title bar, text inputs (Undo/Cut/Copy/Paste/Select-All), and a generic page-level Back/Refresh fallback.
- **Moonlight tab** — machines + streaming:
  - mDNS **discovery** of Sunshine/GameStream hosts (paired/unpaired) — `discover_hosts` browses `_nvstream._tcp.local.` then probes each host.
  - **Paired hosts** read directly from Moonlight QT's QSettings store (registry for normal installs, `Moonlight.conf` for portable installs).
  - **Saved machines** — user-added hosts; probed per-scan (TCP 47984/47989 + `moonlight list`) and shown as Online / Offline. Tailscale `*.ts.net` hostnames work.
  - **Pair / Desktop / Apps** actions per host; **Resume / Disconnect** during a stream. Duplicate stream spawns for the same host+app are blocked.
  - Drives the **Moonlight QT client** via its CLI (`list`, `pair`, `stream`, `quit`).
- **Gamepad support** — controller buttons/sticks are bridged to keyboard events in `useGamepad`, so the existing keyboard handlers drive everything: A = Enter, B = Esc, LB/RB = Tab/Shift+Tab (view switching), D-pad / left stick = arrows.
- **Persistent settings** — all settings survive restarts.
- **Integrations** — auto-detect Tailscale (CLI, polled while Settings is mounted), select + validate Moonlight install folder, SteamGridDB API key.

## Architecture

- **Rust backend** (`src-tauri/src/lib.rs`) exposes Tauri commands for:
  - window: `toggle_fullscreen`, `is_fullscreen`, `minimize_window`, `toggle_maximize`, `is_maximized`, `close_app`
  - system power: `system_power(sleep|reboot|shutdown)`, `enter_immersive`, `exit_immersive`
  - startup: `set_start_with_windows` (HKCU Run key), `set_replace_desktop` (per-user `Winlogon\Shell` takeover), `booted_as_shell`
  - Tailscale: `tailscale_status`, `tailscale_set`
  - Moonlight CLI: `validate_moonlight_dir`, `moonlight_list_apps`, `moonlight_pair` (emits `pair-complete`), `moonlight_stream` (de-dupes by host+app via `StreamState`), `moonlight_quit`
  - host discovery / pairing: `discover_hosts` (mDNS + per-host `list` probe), `moonlight_paired_hosts` (reads QSettings), `moonlight_probe` (TCP + list check, used for online/offline)
  - apps: `discover_apps` (Start Menu + Store + Steam), `launch_app`
  - icons: `app_icon`, `cache_steamgrid_icon`, `import_app_icon`, `clear_cached_icon`
  - WiFi: `wifi_current` (netsh-based, no 1168 bug), `wifi_scan` (WlanScan + 2.5s + netsh, `async`+`spawn_blocking`), `wifi_connect(ssid)`, `wifi_connect_with_password(ssid, password, auth)`, `wifi_disconnect`, `wifi_radio_get`, `wifi_radio_set(enabled)`
  - clipboard icons: `clipboard_icon_hint`, `clipboard_icon_import`
  - SteamGridDB: `check_steamgrid_key`, `steamgrid_search`, `steamgrid_icons`
- **Settings** (`src-tauri/src/settings.rs`) — a typed, versioned `Settings` struct persisted as JSON, written atomically (tmp + rename); emits a `settings-changed` event.
- **All persistent data is centralized** in one folder under *Local* AppData: `%LOCALAPPDATA%\com.moonblast.app\` containing `settings.json` and a sibling `.icons\` icon cache. Settings are migrated from the old Roaming (`app_config_dir`) location on first run.
- **Frontend** — a React `SettingsProvider` context (single source of truth, hydrates asynchronously on boot — gate on the `ready` flag for mount-time effects) syncs all views; shared `ui/` primitives keep the UI consistent. A single `<ContextMenuHost/>` renders the global right-click menu.

## Project structure

```
src/                          # React frontend
  components/
    ui/                       # shared primitives (Toggle, Row, Section, Select, Segmented, Modal, Toast, Input, ContextMenu, FilterList, Button, Card, Prompt, WifiModal, StatusPill, IconTile)
    TopBar.tsx                # icon nav + power button
    TitleBar.tsx              # custom window title bar
    PageShell.tsx             # shared page layout
    AppsView.tsx              # Apps tab (curated grid, Store/Steam discovery, icons, rename, context menus)
    MoonlightView.tsx         # Moonlight tab (Machines + Settings sub-tab, discovery, paired, saved, probe)
    MoonlightSettings.tsx     # Moonlight streaming settings (resolution / fps / codec / display / audio / input / etc.)
    SettingsView.tsx          # app-level settings (general, integrations, about)
    PowerMenu.tsx             # power menu modal
  settings/SettingsContext.tsx  # persistent settings provider
  hooks/useGamepad.ts         # gamepad → keyboard bridge
  styles.css                  # design tokens (@theme)
src-tauri/                    # Rust backend
  src/lib.rs                  # Tauri commands
  src/settings.rs             # persisted settings
  src/shell.rs                # Windows shell (desktop) replacement + boot stub
```

## Keyboard & gamepad reference

| Action | Keyboard | Gamepad |
|---|---|---|
| Fullscreen | F11 | — |
| Immersive Mode | Power menu | — |
| Exit Immersive | Esc | B |
| Next / prev view | Tab / Shift+Tab | RB / LB |
| Move | Arrows | D-pad / left stick |
| Activate | Enter / Space | A |
| Back / cancel | Escape | B |

## Building for ARM64

Cross-compiling to ARM64 uses the MSVC ARM64 toolchain (installed via VS 2022 C++ build tools).
`ureq` uses rustls/`ring`; `ring` needs **clang** for the ARM64 target, so install LLVM once (`winget install LLVM.LLVM`) before the first ARM64 build.

```bash
# one-time: install clang for ring's ARM64 assembly
winget install LLVM.LLVM
# load the ARM64 cross environment from an x64 developer shell
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
