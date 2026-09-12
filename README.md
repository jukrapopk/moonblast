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
  - **Per-app Autolaunch with Auto Immersive** — flag any app to launch at the next sign-in that boots Moonblast from the shell stub. Flagged apps fire staggered 250 ms apart alongside the launcher; the launcher stays the foreground UI. Toggle lives in the app's context menu, hidden entirely when Auto Immersive Mode is off (the toggle is a no-op then).
- **Right-click context menus** everywhere (replacing the native WebView2 menu): per-app, per-host, title bar, text inputs (Undo/Cut/Copy/Paste/Select-All), and a generic page-level Back/Refresh fallback.
- **TopBar system chips** (each click opens its modal; click the chip again or hit `Esc` to close):
  - **Battery** — current %, plug state, time-remaining / time-to-full in the tooltip; modal shows the full percent bar, time-remaining, and power source. Updates every 5s (2s in the modal) without Rust push events.
  - **WiFi** — connected network + signal; modal is an in-app picker with one-tap connect/scan/disconnect, password form for secured networks, per-row in-flight state, generation badge (4/5/6/7), Forget for saved profiles. Radio on/off lives in the OS.
  - **Audio** — current output device + volume; modal is the full mixer (output-device picker, master slider + mute, per-app sliders grouped by exe, Reset all). Push model via Core Audio COM, no polling.
  - **Display** — opens the Display modal: Monitor, HDR toggle, Resolution, Refresh rate. See Display section below.
- **Display modal** — top-level system control surface, separate from the Settings page:
  - **Monitor picker** — every connected monitor via `EnumDisplayDevices`, deduplicated by `DeviceID` (multi-head GPUs that report the same panel under several aliases collapse to one). Friendly names come from WMI `WmiMonitorID.UserFriendlyName` via PowerShell (EDID-derived model names like "BenQ EX2780Q"); falls back to the GDI `DeviceString`, then to the GPU adapter name.
  - **HDR** — `DisplayConfigGetDeviceInfo` / `SetDeviceInfo` against the first active display path (Windows Advanced Color). Toggle row shows a description that adapts to panel capability / OS lock state; disabled (visually off) when the OS has locked the toggle or the panel doesn't support HDR.
  - **Resolution + Refresh** — `EnumDisplaySettingsExW` per selected monitor, with a confirmation modal (`Keep` / `Revert`, 10-second auto-revert) for new modes — same UX as Windows' built-in keep-changes dialog but in-app. Pending changes revert on Settings unmount so a forgotten confirmation can't strand a display.
  - **Loading chips** — every row that does an IPC roundtrip (Monitor / HDR / Resolution / Refresh) renders a small spinner chip while the call is in flight instead of an empty `Select` / `Toggle`.
- **Moonlight tab** — machines + streaming:
  - **Unified host list** — mDNS discovery, the paired registry, and the user's `settings.machines` are merged into one `HostEntry[]` keyed by case-insensitive name (not address), so the same host at a LAN IP and a Tailscale IP shows as **one card**, not two.
  - **Saved address override** — the address in `settings.machines` always wins as the active address used for probe + stream. This is the fix for "LAN IP changed, paired record is stale, Tailscale override saved": add the remote address, and the saved one is used from then on. A `Saved` badge on the card signals when the active address isn't the paired record's.
  - mDNS **discovery** of Sunshine/GameStream hosts (paired/unpaired) — `discover_hosts` browses `_nvstream._tcp.local.` then probes each host.
  - **Paired hosts** read directly from Moonlight QT's QSettings store (registry for normal installs, `Moonlight.conf` for portable installs).
  - **Saved machines** — user-added hosts (typically Tailscale `*.ts.net` hostnames or remote IPs); probed per-scan (TCP 47984/47989 + `moonlight list`) and shown as Online / Offline.
  - **Per-host actions**: Pair / Stream Desktop / Apps gated on `paired AND reachable`. Right-click menu separates **Forget pairing** (drops the cert) from **Remove saved address** (drops the override).
  - **Resume / Disconnect** during a stream. Duplicate stream spawns for the same host+app are blocked.
  - **HDR — Follow Global** checkbox (default `true`) sits above the HDR toggle in Video settings. When on, the HDR toggle is read-only but mirrors the OS-level display HDR state (resolved at stream start from `hdr_status()`); when off, it's a normal per-stream toggle. So toggling HDR in the Display modal automatically affects every new stream without having to remember a second switch. The disabled toggle stays in sync via a `hdr-changed` event pushed by Rust after every successful `set_hdr` IPC, plus re-reads on `window.focus` and `visibilitychange → visible` to catch OS-side flips (Windows Settings, OEM hotkey, system policy).
  - Drives the **Moonlight QT client** via its CLI (`list`, `pair`, `stream`, `quit`); disconnects run `moonlight quit <host>` on a dedicated thread with `CREATE_NO_WINDOW` and an 8s bounded wait, in parallel with a bounded reap of the local moonlight.exe window.
- **Gamepad support** — controller buttons/sticks are bridged to keyboard events in `useGamepad`, so the existing keyboard handlers drive everything: A = Enter, B = Esc, LB/RB = Tab/Shift+Tab (view switching), D-pad / left stick = arrows.
- **Persistent settings** — all settings survive restarts.
- **Integrations** — auto-detect Tailscale (CLI, polled while Settings is mounted), select + validate Moonlight install folder, SteamGridDB API key.

## Architecture

- **Rust backend** (`src-tauri/src/lib.rs`) exposes Tauri commands for:
  - window: `toggle_fullscreen`, `is_fullscreen`, `minimize_window`, `toggle_maximize`, `is_maximized`, `close_app`
  - system power: `system_power(sleep|reboot|shutdown)`, `enter_immersive`, `exit_immersive`
  - startup: `set_start_with_windows` (HKCU Run key), `set_replace_desktop` (per-user `Winlogon\Shell` takeover), `booted_as_shell`
  - Tailscale: `tailscale_status`, `tailscale_set`
  - Moonlight CLI: `validate_moonlight_dir`, `moonlight_list_apps` (10s subprocess timeout), `moonlight_pair` (async + 10-min deadline, emits `pair-complete`), `moonlight_stream` (de-dupes by host+app via `StreamState`; kills prior orphan + drains on `close_app`/`Destroyed`), `moonlight_quit` (host + app: spawns `moonlight quit <host>` on a dedicated thread with 8s bounded wait + bounded reap of the local moonlight.exe; the CLI handles Sunshine's pinned cert internally so we don't have to drive the HTTPS `/cancel` endpoint ourselves)
  - host discovery / pairing: `discover_hosts` (mDNS + per-host `list` probe), `moonlight_paired_hosts` (reads QSettings), `moonlight_probe` (TCP + list check, used for online/offline)
  - apps: `discover_apps` (Start Menu + Store + Steam), `launch_app`, `launch_autolaunch_apps` (per-app auto-launch flag — fires flagged apps at sign-in, staggered 250 ms apart, alongside the launcher; gated on `--autostart` so manual launches don't surprise the user)
  - icons: `app_icon`, `cache_steamgrid_icon`, `import_app_icon`, `clear_cached_icon`
  - WiFi: `wifi_current` (netsh-based, no 1168 bug; exposes `radioOn`), `wifi_scan` (WlanScan + 2.5s + netsh, `async`+`spawn_blocking`), `wifi_connect(ssid)`, `wifi_connect_with_password(ssid, password, auth)`, `wifi_disconnect`, `wifi_forget(ssid)` (idempotent) — radio on/off lives in the OS
  - audio: `audio_devices`, `audio_set_default_device(id)` (all roles, like the Sound panel), `audio_master`, `audio_set_master_volume`, `audio_set_master_mute`, `audio_sessions` (grouped by exe), `audio_set_session_volume/mute`, `audio_reset_sessions` (all to max + unmuted) — Core Audio COM via hand-declared vtables in `audio.rs`, all `async`+`spawn_blocking`. WiFi and Audio modals keep everything in-app; no `ms-settings:` handoffs.
  - display / HDR: `list_monitors` (`display.rs`, GDI + WMI for friendly names, deduplicated by DeviceID), `display_modes` / `current_display` / `apply_display_mode` / `keep_display_mode` / `revert_display_mode` (per-monitor via `EnumDisplaySettingsExW` + `ChangeDisplaySettingsExW`), `hdr_status` / `set_hdr` (`hdr.rs`, `DisplayConfig*` against the active path via the `windows` 0.61 typed crate)
  - clipboard icons: `clipboard_icon_hint`, `clipboard_icon_import`
  - SteamGridDB: `check_steamgrid_key`, `steamgrid_search`, `steamgrid_icons`
- **Settings** (`src-tauri/src/settings.rs`) — a typed, versioned `Settings` struct persisted as JSON, written atomically (tmp + rename); emits a `settings-changed` event.
- **All persistent data is centralized** in one folder under *Local* AppData: `%LOCALAPPDATA%\com.moonblast.app\` containing `settings.json` and a sibling `.icons\` icon cache. Settings are migrated from the old Roaming (`app_config_dir`) location on first run.
- **Frontend** — a React `SettingsProvider` context (single source of truth, hydrates asynchronously on boot — gate on the `ready` flag for mount-time effects) syncs all views; shared `ui/` primitives keep the UI consistent. A single `<ContextMenuHost/>` renders the global right-click menu.

## Project structure

```
src/                          # React frontend
  components/
    ui/                       # shared primitives (Toggle, Row, Section, Select, Segmented, Modal, Toast, Input, ContextMenu, FilterList, Button, Card, Prompt, WifiModal, AudioModal, BatteryModal, Slider, StatusPill, IconTile, LoadingChip, BatteryIcon, WifiIcon, SpeakerIcon)
    TopBar.tsx                # icon nav + power button + system status chips (Battery / WiFi / Audio / Display)
    TitleBar.tsx              # custom window title bar
    PageShell.tsx             # shared page layout
    AppsView.tsx              # Apps tab (curated grid, Store/Steam discovery, icons, rename, autolaunch toggle, context menus)
    MoonlightView.tsx         # Moonlight tab (Machines + Settings sub-tab, discovery, paired, saved, probe)
    MoonlightSettings.tsx     # Moonlight streaming settings (resolution / fps / codec / display / audio / input / etc.)
    SettingsView.tsx          # app-level settings (general, integrations, about) + DisplaySettingsModal + ResolutionPicker
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
  src/display.rs              # multi-monitor enumeration + mode apply/revert (GDI + WMI)
  src/hdr.rs                  # Windows Advanced Color (DisplayConfig*) — windows 0.61 typed crate
  src/wifi.rs                 # netsh-based WiFi
  src/audio.rs                # Core Audio COM (hand-declared vtables)
  src/logging.rs              # file logger + panic hook
scripts/
  build-arm64.ps1             # MSVC cross-env wrapper for ARM64 release builds
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

The helper script `scripts/build-arm64.ps1` loads the MSVC cross-env, runs cargo clean for stale metadata, and copies the resulting `tauri-app.exe` to a destination of your choice. MSI + NSIS installers are also produced as side effects of `tauri build -- --target …`.

```bash
# one-time: install clang for ring's ARM64 assembly
winget install LLVM.LLVM

# build via the helper (defaults to Desktop\moonblast.exe)
powershell -ExecutionPolicy Bypass -File scripts\build-arm64.ps1
powershell -ExecutionPolicy Bypass -File scripts\build-arm64.ps1 -Destination 'Z:\'

# or manually:
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
