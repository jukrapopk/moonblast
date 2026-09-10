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
- **Battery status** — TopBar chip with current %, plug state, and time-remaining / time-to-full in the tooltip; click opens a modal with the full percent bar, time-remaining, and power source. Updates every 5s (10s in the modal) without Rust push events.
- **Moonlight tab** — machines + streaming:
  - **Unified host list** — mDNS discovery, the paired registry, and the user's `settings.machines` are merged into one `HostEntry[]` keyed by case-insensitive name (not address), so the same host at a LAN IP and a Tailscale IP shows as **one card**, not two.
  - **Saved address override** — the address in `settings.machines` always wins as the active address used for probe + stream. This is the fix for "LAN IP changed, paired record is stale, Tailscale override saved": add the remote address, and the saved one is used from then on. A `Saved` badge on the card signals when the active address isn't the paired record's.
  - mDNS **discovery** of Sunshine/GameStream hosts (paired/unpaired) — `discover_hosts` browses `_nvstream._tcp.local.` then probes each host.
  - **Paired hosts** read directly from Moonlight QT's QSettings store (registry for normal installs, `Moonlight.conf` for portable installs).
  - **Saved machines** — user-added hosts (typically Tailscale `*.ts.net` hostnames or remote IPs); probed per-scan (TCP 47984/47989 + `moonlight list`) and shown as Online / Offline.
  - **Per-host actions**: Pair / Stream Desktop / Apps gated on `paired AND reachable`. Right-click menu separates **Forget pairing** (drops the cert) from **Remove saved address** (drops the override).
  - **Resume / Disconnect** during a stream. Duplicate stream spawns for the same host+app are blocked.
  - Drives the **Moonlight QT client** via its CLI (`list`, `pair`, `stream`); disconnects use `GET /cancel?uniqueid=…` directly, matching Moonlight Qt's `NvHTTP::quitApp`.
- **Gamepad support** — controller buttons/sticks are bridged to keyboard events in `useGamepad`, so the existing keyboard handlers drive everything: A = Enter, B = Esc, LB/RB = Tab/Shift+Tab (view switching), D-pad / left stick = arrows.
- **Persistent settings** — all settings survive restarts.
- **Integrations** — auto-detect Tailscale (CLI, polled while Settings is mounted), select + validate Moonlight install folder, SteamGridDB API key.

## Architecture

- **Rust backend** (`src-tauri/src/lib.rs`) exposes Tauri commands for:
  - window: `toggle_fullscreen`, `is_fullscreen`, `minimize_window`, `toggle_maximize`, `is_maximized`, `close_app`
  - system power: `system_power(sleep|reboot|shutdown)`, `enter_immersive`, `exit_immersive`
  - startup: `set_start_with_windows` (HKCU Run key), `set_replace_desktop` (per-user `Winlogon\Shell` takeover), `booted_as_shell`
  - Tailscale: `tailscale_status`, `tailscale_set`
  - Moonlight CLI: `validate_moonlight_dir`, `moonlight_list_apps` (10s subprocess timeout), `moonlight_pair` (async + 10-min deadline, emits `pair-complete`), `moonlight_stream` (de-dupes by host+app via `StreamState`; kills prior orphan + drains on `close_app`/`Destroyed`), `moonlight_quit` (host + app: `GET /cancel?uniqueid=…&uuid=…` over HTTPS to stop the host's app immediately + bounded reap of the local moonlight.exe; matches Moonlight Qt's `quitApp`)
  - host discovery / pairing: `discover_hosts` (mDNS + per-host `list` probe), `moonlight_paired_hosts` (reads QSettings), `moonlight_probe` (TCP + list check, used for online/offline)
  - apps: `discover_apps` (Start Menu + Store + Steam), `launch_app`
  - icons: `app_icon`, `cache_steamgrid_icon`, `import_app_icon`, `clear_cached_icon`
  - WiFi: `wifi_current` (netsh-based, no 1168 bug; exposes `radioOn`), `wifi_scan` (WlanScan + 2.5s + netsh, `async`+`spawn_blocking`), `wifi_connect(ssid)`, `wifi_connect_with_password(ssid, password, auth)`, `wifi_disconnect`, `wifi_forget(ssid)` (idempotent) — radio on/off lives in the OS
  - audio: `audio_devices`, `audio_set_default_device(id)` (all roles, like the Sound panel), `audio_master`, `audio_set_master_volume`, `audio_set_master_mute`, `audio_sessions` (grouped by exe), `audio_set_session_volume/mute`, `audio_reset_sessions` (all to max + unmuted) — Core Audio COM via hand-declared vtables in `audio.rs`, all `async`+`spawn_blocking`. WiFi and Audio modals keep everything in-app; no `ms-settings:` handoffs.
  - clipboard icons: `clipboard_icon_hint`, `clipboard_icon_import`
  - SteamGridDB: `check_steamgrid_key`, `steamgrid_search`, `steamgrid_icons`
- **Settings** (`src-tauri/src/settings.rs`) — a typed, versioned `Settings` struct persisted as JSON, written atomically (tmp + rename); emits a `settings-changed` event.
- **All persistent data is centralized** in one folder under *Local* AppData: `%LOCALAPPDATA%\com.moonblast.app\` containing `settings.json` and a sibling `.icons\` icon cache. Settings are migrated from the old Roaming (`app_config_dir`) location on first run.
- **Frontend** — a React `SettingsProvider` context (single source of truth, hydrates asynchronously on boot — gate on the `ready` flag for mount-time effects) syncs all views; shared `ui/` primitives keep the UI consistent. A single `<ContextMenuHost/>` renders the global right-click menu.

## Project structure

```
src/                          # React frontend
  components/
    ui/                       # shared primitives (Toggle, Row, Section, Select, Segmented, Modal, Toast, Input, ContextMenu, FilterList, Button, Card, Prompt, WifiModal, AudioModal, BatteryModal, Slider, StatusPill, IconTile)
    TopBar.tsx                # icon nav + power button
    TitleBar.tsx              # custom window title bar
    PageShell.tsx             # shared page layout
    AppsView.tsx              # Apps tab (curated grid, Store/Steam discovery, icons, rename, context menus)
    MoonlightView.tsx         # Moonlight tab (Machines + Settings sub-tab, discovery, paired, saved, probe)
    MoonlightSettings.tsx     # Moonlight streaming settings (resolution / fps / codec / display / audio / input / etc.)
    SettingsView.tsx          # app-level settings (general, integrations, about)
    PowerMenu.tsx             # power menu modal
  settings/SettingsContext.tsx  # persistent settings provider
  hooks/
    useGamepad.ts             # gamepad → keyboard bridge
    usePowerMenuTrigger.ts    # Rust → JS trigger pubsub (Alt+F4 in Immersive)
    useWifi.ts                # event-driven WiFi chip + scan state
    useAudio.ts               # event-driven audio master + sessions
    useBattery.ts             # 5s poll + focus/visibility battery chip
    useTime.ts                # clock + date formatter
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
| Exit Immersive | Power menu | — |
| Next / prev view | Tab / Shift+Tab | RB / LB |
| Move | Arrows | D-pad / left stick |
| Activate | Enter / Space | A |
| Close a modal | Escape | B |

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
