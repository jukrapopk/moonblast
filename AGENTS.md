# Moonblast — Agent Context

Project memory for working on **Moonblast**, a lightweight Windows Fullscreen Mode / Big Picture-style launcher centered around **Moonlight** streaming. Read this before making changes.

## What it is
- Low RAM/CPU desktop shell (Steam-Big-Picture-like) to launch Windows apps and stream via Moonlight QT.
- **Windows only.** Custom frameless title bar, fullscreen-friendly.
- Goal: minimal, clean, modern dark UI, token-driven styling, no duplication.

## Stack
- **Frontend:** React 19 + TypeScript, Vite, Tailwind CSS v4, Framer Motion, Phosphor `@phosphor-icons/react` (use `weight="bold"` for all icons).
- **Backend:** Rust, Tauri 2 (WebView2).

## Window / fullscreen / Immersive
- Frameless window (`decorations:false` in `tauri.conf.json`) with **`TitleBar.tsx`** (drag region + minimize/maximize/close). TitleBar hides when fullscreen (`App.tsx`).
- `toggle_fullscreen` in Rust also unmaximizes first (avoids a blank strip — the known frameless max→fullscreen artifact). **F11** toggles; `App.tsx` holds `fullscreen` state and threads it to the Power menu button (label/icon flip: Fullscreen ⇄ Windowed).
- **Immersive Mode** (Power menu item — no keyboard shortcut): fullscreen + clean surface. Rust `enter_immersive` forces fullscreen, minimizes other top-level windows (`EnumWindows`), and **kills `explorer.exe`** to suppress the desktop/taskbar; `exit_immersive` restarts it (guarded by the `EXPLORER_KILLED` `AtomicBool`). The shell is also restored on `close_app` and on window `Destroyed` (`on_window_event`). **TopBar stays visible** — suppression targets the *outside* (desktop/background), not the app's own chrome. Alt+F4 / taskbar-Close while in Immersive is intercepted and routes to the Power menu (single pubsub in `usePowerMenuTrigger`); Escape closes whatever modal is open but does **not** exit Immersive.
- **Auto Immersive Mode** (`fullscreen.auto_immersive`, gated in the UI on `start_with_windows`, `src-tauri/src/shell.rs`) — **one** switch that both registers Moonblast as the Windows shell and enters Immersive Mode at sign-in. Sets the **per-user** `HKCU\…\Winlogon\Shell` value so `userinit.exe` launches Moonblast instead of `explorer.exe`. Because it's the user's own hive it needs **no elevation — no UAC prompt, ever** (the HKLM equivalent would). Explorer then never starts *at all* rather than starting and being killed, so there's no desktop/taskbar flash, and `Run`/`RunOnce` + the Startup folder never run (Explorer is what processes them) — background apps are suppressed for free. Disabling "Start with Windows" also clears `auto_immersive` **and** unregisters the shell, so the takeover can't outlive the switch that armed it. (The Run key is functionally redundant while the takeover is active — Explorer never runs to process it — so the gate is a deliberate consent step, not a technical dependency.)
  - **Toggling never enters Immersive Mode**; it only arms the next sign-in. Winlogon points at a **stub** (`Moonblast.exe --shell`, intercepted in `main.rs` before any Tauri setup) which launches the launcher with `--autostart` — and *that flag* is what triggers Immersive Mode (`booted_as_shell` command). The decision is made once in `App.tsx` the moment settings hydrate, keyed only on `ready`.
  - The stub runs the launcher, waits, and afterwards guarantees a desktop (`ensure_desktop` → Explorer unless `GetShellWindow` says one is up), then parks as the session's shell process. A Moonblast crash therefore still leaves a working desktop.
  - Escape hatches: holding **Shift** at sign-in, or 3 consecutive fast crashes (`ShellCrashCount` in `HKCU\Software\Moonblast`, cleared 30s into a healthy run), restore the normal shell automatically. The previous `Shell` value is backed up to `OriginalShell`/`OriginalShellSet` so restore puts back "absent" vs. an explicit value correctly.
  - `setup` reconciles intent against reality: if the setting is on but the registry **isn't** armed, a rescue already fired — it clears `auto_immersive` (`settings::disable_auto_immersive`) rather than silently re-arming. If it *is* armed, it only refreshes the exe path so moving/updating the app can't strand a stale entry.
  - `exit_immersive` starts Explorer when the desktop is replaced (nothing for `suppress_shell(false)` to restore, since Explorer never ran).
- **Console windows**: child processes (`powershell Get-StartApps`, `taskkill`, `tailscale`, `shutdown`) are spawned with `CREATE_NO_WINDOW` (`creation_flags(0x08000000)`) so no console flashes.

## Layout & navigation
- `TitleBar` → `TopBar` (icon-only nav: 🗂 Apps, 🖥 Moonlight on left; ⚙ Settings, ⏻ Power on right; **system status on the far right**: 🕒 clock chip + battery + WiFi icon buttons, all via the shared `TopBarButton`) → `main` scroll area.
- Views: **apps | moonlight | settings**. The Moonlight view has its own **Machines / Settings** segmented sub-tab. Wrappers in `App.tsx` use `p-8` on all sides (no `h-full`, so bottom padding works when scrolled).
- **`PageShell.tsx`** is the shared layout (title/subtitle/actions/tabs/children, `max-w-6xl`). Every page uses it.
- Tabs via shared **`ui/Segmented.tsx`** (variants: `tabs` pillar, `value` picker).
- View switching: **Tab / Shift+Tab** cycles the three top-level views (`App.tsx`); the last non-settings view is persisted (`general.last_view`) and restored on next launch. Settings never overwrites `last_view`, so the app always boots into Apps or Moonlight.

## Keyboard & gamepad
- **Keyboard:** `F11` fullscreen, `Tab`/`Shift+Tab` cycle views, arrows move inside per-page grid/list handlers, `Enter`/`Space` activate. Immersive Mode is entered from the Power menu only (no keyboard shortcut). `Esc` closes whichever modal is open but does **not** exit Immersive Mode.
- **Apps grid** uses an internal `focusIdx` + a single-column-of-6 stepping (right/left wrap within the row; up/down step by 6). The focused tile is the visual selected one.
- **Gamepad** is supported via `src/hooks/useGamepad.ts` — it bridges the controller to the **same keyboard events** the UI already listens for. No gamepad-specific code anywhere else:
  - Buttons 0/1 → Enter/Escape (A/B)
  - Buttons 4/5 → Tab / Shift+Tab (LB/RB) — view switching
  - D-pad 12–15 → Arrow keys
  - Left stick axes 0/1 → Arrow keys (with ±0.5 deadzone)
  - All edges de-bounced per-id (axis + button held set).
- **App-level context menu** (`App.tsx`): right-click anywhere not handled by a more specific menu shows a generic **Back / Refresh** menu. Specific views (`AppsView`, `MoonlightView`, `TitleBar`) own their own per-element right-click menus. `Input` fields install their own Undo/Cut/Copy/Paste/Select-All menu on right-click.

## Moonlight integration (IMPORTANT — current architecture)
Streaming/pairing is done by **driving the Moonlight QT client via its CLI**, NOT by reimplementing the protocol in-process. Keep it that way.
- The user selects the **Moonlight install folder** in Settings → Integrations; it's validated to contain `moonlight.exe`/`moonlight-qt.exe` (`validate_moonlight_dir`).
- Rust commands in `lib.rs` run the exe:
  - `moonlight_list_apps(host)` → `moonlight list <host>` (action is `list`, not `listapps`).
  - `moonlight_pair(host)` → `moonlight pair <host>` (shows Moonlight QT's own pairing UI).
  - `moonlight_stream(host, app)` → `moonlight stream <host> <app>`. "Desktop" streams the host's Desktop app. The launcher tracks running stream child processes in a `StreamState` keyed by `host\u{1f}app` so a second click doesn't spawn a duplicate window for the same host+app.
  - `moonlight_quit(host, app)` → `moonlight quit <host>` to terminate the running app on the host (graceful), then `Child::kill` on the local streaming window Moonblast launched for `(host, app)` so it doesn't linger.
- **Host discovery:** `discover_hosts()` (Rust) browses `_nvstream._tcp.local.` via `mdns-sd` for ~3s, then probes each host with `moonlight list <host>` to classify paired/unpaired. The whole scan runs on `spawn_blocking` so it never freezes the UI.
- **Paired hosts:** `moonlight_paired_hosts()` reads Moonlight QT's own QSettings store (Windows registry `HKCU\Software\Moonlight Game Streaming Project\Moonlight\hosts\*` for normal installs, or `Moonlight.conf` next to `moonlight.exe` for portable installs) — a host is paired if it holds a pinned `srvcert`. No CLI exists for this; Rust reads the store directly.
- **Saved-machine reachability:** `moonlight_probe(host)` does a 1.5s TCP probe to ports 47984 / 47989 (so Tailscale `*.ts.net` hosts work too) and a `moonlight list` check for pairing — used to show saved machines as **Online / Offline** without depending on mDNS.
- **Event-driven pairing refresh** (`moonlight_pair`): Rust waits for the `pair` process to exit, then emits a `pair-complete` event; the frontend rescans once (no polling).
- Same-PC local connect works via `127.0.0.1`.
- The UI shows three lists on the Moonlight page: **Paired** (union of persisted pairings + paired discoveries), **Discovery** (network-visible, unpaired), and **Saved machines** (the user-added `settings.machines`). Saved machines are probed per-scan and shown as Online / Offline.

## WiFi integration
- **Status chip in the TopBar** + **picker modal** (one tap to connect/scan/disconnect). Two visual states per network row: **Connected** (Disconnect button) or **Saved / unknown** (whole row is the action, click anywhere). Radio on/off lives in Windows Wi-Fi settings — open the OS Wi-Fi pane yourself if you need to toggle it; the modal stays in-app for everything else.
- **Rust `wifi.rs` is netsh-based**, not wlanapi. Read-side wlanapi calls (`WlanEnumInterfaces` / `WlanQueryInterface` / `WlanGetAvailableNetworkList`) return `ERROR_NOT_FOUND` (1168) inside a long-lived Tauri process even though the same calls work from `cargo run` — the wlan service's per-client cache goes stale. So:
  - `wifi_current` shells out to `netsh wlan show interfaces` and parses `State` / `SSID` / `Signal` / `Authentication` / `Radio status`. Returns `Some(...)` whenever an adapter exists — with `radio_on` false when the radio is off (chip shows `WifiX`, still clickable) — and `null` when there's no adapter at all (chip hidden on desktops / VMs). Note `Radio status` spans two lines when HW/SW differ (`Hardware On` + continuation `Software Off`); the radio is on only when both are on.
  - `wifi_scan` calls `WlanScan` (the wlanapi write opcode, which works in the Tauri process), sleeps ~2.5s to let the driver populate the visible-network cache, then `netsh wlan show networks mode=bssid` and parses `SSID N` blocks. Each block's BSSIDs give the strongest `Signal` (max), `connected` flag (vs. `netsh_current_connection`), and best `gen` (`Radio type` line → 4/5/6/7). The first `netsh show networks` call returns only the connected network; the second call after the sleep returns the full visible list — that's how the cache populates. `wifi_scan` is registered as `async` and dispatched via `tauri::async_runtime::spawn_blocking` so other Tauri commands (chip reads, connect, disconnect) interleave normally while a scan is in flight.
  - `wifi_connect(ssid)` → `netsh wlan connect name=<ssid>`. Works for open networks and any network the user has connected to once (saved profile).
  - `wifi_connect_with_password(ssid, password, auth)` → builds a temporary WLAN profile XML, registers it via `netsh wlan add profile filename=...`, then `netsh wlan connect`. The profile sticks around after connect, so the SSID is "Saved" in the picker next time. Supports WPA2-Personal / WPA3-Personal / WPA-Personal / WEP; Enterprise and unknown auth kinds return `Err("...not supported in-app; open Windows Wi-Fi settings")` and the modal falls back to launching `ms-settings:network-wifi`.
  - `wifi_disconnect()` → `netsh wlan disconnect`. No-op if already disconnected.
  - `wifi_forget(ssid)` → `netsh wlan delete profile name=...`. Idempotent ("not found" = already forgotten).
- **`useWifi` (hook)** is event-driven, not a timer. Reads on mount, on window `focus`, on `visibilitychange` → visible, and on an explicit `refresh()` call from the parent. Two refs collapse back-to-back events: `inFlight` (the in-progress Promise — concurrent callers share the same read) and `lastReadAt` (skip if a read completed within 2s). The chip and the modal share a single `useWifi` instance via prop drilling (`currentSsid` + `radioOn`); on `wifiOpen` change the parent calls `refreshWifi()` so the chip reflects any change the user just made in the modal. When the radio is off the modal skips the auto-scan, shows a "Wi-Fi is off" hint, and disables Rescan; returning from OS Settings fires focus → parent refreshes → off→on auto-scans.
- **WiFi picker modal** (`src/components/ui/WifiModal.tsx`):
  - **Password form in-app.** Clicking a secured network with no saved profile replaces the list with a single-field password form (show/hide eye toggle, Enter to submit, Cancel/Back). No more bouncing to the Windows Wi-Fi settings app.
  - **Per-row in-flight UI.** Each row has its own `busy` state (`{ ssid, kind: "connect" | "disconnect" | "forget" } | null`). The busy row shows an inline spinner + "Connecting…" / "Disconnecting…" / "Forgetting…" subtitle; all other rows are disabled via a separate `anyBusy` prop. The connected row dims to opacity-40 during disconnect to match the connecting treatment.
  - **Disconnect button** on the connected row is `variant="ghost"` (no border) and hides during the disconnect operation. The "Disconnecting…" subtitle carries the state.
  - **Generation badge.** A small number (4/5/6/7) sits at the bottom-right of the signal icon, mapped from the netsh "Radio type" line per BSSID.
  - **Row context menu.** Right-click mirrors left-click (Connect / Disconnect, text-only) plus **Forget** (danger, Saved rows only) which deletes the stored profile via `wifi_forget` with a `Forgetting…` in-flight state.
  - **Footer.** Rescan button on the left (disabled while the radio is off). Radio on/off lives in the OS — open Windows Wi-Fi settings yourself if you need to toggle it; the modal stays in-app for everything else.
- **Safe state reset on close.** Because `Modal` wraps its children in `AnimatePresence` (children stay mounted through the exit animation), a `useEffect([open])` clears `busy` on close so a fresh open doesn't show a stale "Connecting…" / "Disconnecting…".

## Audio integration
- **Speaker chip in the TopBar** (right of WiFi) + **mixer modal** (`src/components/ui/AudioModal.tsx`): output-device picker, main volume slider + mute, per-app sliders (grouped by exe like the Windows mixer) each with mute + reset-to-max, and a "Reset all" button (every app channel to max + unmuted). The modal covers every per-device + per-app control Moonblast needs; there is no in-app handoff to Windows' Sound panel. No Refresh button, no polling — see push model below.
- **Rust `audio.rs` is Core Audio COM via hand-declared vtables** (`windows-sys` 0.59 ships the MMDevice constants but no interfaces — same situation as `IApplicationActivationManager` in `lib.rs`). Only vtable layout matters; unused trailing slots are `usize`. COM pointers use a `ComPtr` RAII wrapper (Releases on drop) so early `?` returns can't leak. All commands are `async` + `spawn_blocking`; no elevation needed (per-user audio policy).
  - Devices: `MMDeviceEnumerator` → `EnumAudioEndpoints(eRender, ACTIVE)` + `GetDefaultAudioEndpoint`; friendly names via `IPropertyStore` + `PKEY_Device_FriendlyName` (`{A45C254E-DF1C-4EFD-8020-67D146A850E0}`, pid 14 — read `VT_LPWSTR` at PROPVARIANT offset 8, then `PropVariantClear`).
  - Default switch: undocumented `IPolicyConfig::SetDefaultEndpoint` (slot 13) for all three roles, like the Sound panel's "Set as Default Device".
  - Main mixer: `IAudioEndpointVolume` on the default endpoint (scalar ↔ 0–100).
  - Apps mixer: `IAudioSessionManager2` → session enumerator; skips expired / system-sounds / pid-0 sessions; process names via `OpenProcess` + `QueryFullProcessImageNameW`; rows grouped by lowercase exe, sets apply to all of the app's sessions.
  - **GUIDs must come from the Windows SDK headers** (`um/mmdeviceapi.h`, `um/audiopolicy.h`, `um/endpointvolume.h`, `um/functiondiscoverykeys_devpkey.h`) — notably `IID_IMMDeviceEnumerator` ends `...3617E6`, not `...36636E`. A wrong IID fails as `E_NOINTERFACE`/`CLASSNOTREG` even though the CLSID resolves, which is indistinguishable from broken COM without header ground truth.
  - **Push model for master, read-on-open for apps.** Two process-lifetime COM callback singletons (static vtables, refcount no-ops) funnel into one `audio-changed` Tauri event: `IAudioEndpointVolumeCallback` (master volume/mute, incl. volume keys) and `IMMNotificationClient` (device add/remove + default switches). `ensure_watch` (called atop the read commands) registers both idempotently and re-registers on default-device switches; registrations live in a `WATCH` static holding the endpoint/enumerator `ComPtr`s + `AppHandle` (all use sites are MTA). The apps mixer is read fresh on every modal open (per-session push via `IAudioSessionEvents` was tried and dropped — callbacks registered but never delivered).
- **`useAudio` (hook)**: `useAudioMaster` for the chip (mount / focus / visible / explicit refresh + `audio-changed` events). The modal subscribes while open. Slider drags invoke fire-and-forget (no await per tick); mute/reset await + refresh. Parent refreshes the chip on modal close.
- Shared **`ui/Slider.tsx`** primitive (native range input tinted with `accentColor: var(--color-accent)` — keyboard/gamepad arrows work natively).

## Settings (persistent)
- **Rust `settings.rs`** — typed serde `Settings` with `version`, `general` (start_with_windows, last_view), `integrations` (moonlight_folder, moonlight_enabled, apps_enabled, steamgrid_key), `moonlight` (full streaming-pref set: resolution, refresh_rate, bitrate, codec, display_mode, video_decoder, audio_config, vsync/hdr/yuv444/frame_pacing/keep_awake/quit_after/game_optimization/audio_on_host/mute_on_focus_loss/multi_controller/background_gamepad/swap_gamepad_buttons/absolute_mouse/mouse_buttons_swap/reverse_scroll_direction/capture_system_keys, packet_size, fps_overlay, aspect_ratio), `fullscreen` {suppress_explorer, auto_fullscreen, auto_immersive}, `customization` {show_time, show_wifi, show_battery, show_audio}, `machines[{name,address}]`, `app_shortcuts[{name,path,source,kind,display_name,custom_icon,use_desktop_icon,steamgrid_icon}]`. Loaded once from `settings.json`, written atomically (tmp + rename), emits `settings-changed`. **All persistent data is centralized** in one Local AppData folder (`%LOCALAPPDATA%\<identifier>\`): `settings.json` + sibling `.icons\` icon cache; migrated from the old Roaming config dir on first run.
- **Frontend `settings/SettingsContext.tsx`** — `SettingsProvider` wraps the app; `useSettings()` → `{ settings, ready, update(mutator) }`. **Settings hydrate asynchronously** after the first await `get_settings`, so mount-time behavior must gate on `ready` (true once persisted settings have loaded). Updates are optimistic + persisted in the background; a `settings-changed` listener keeps the context in sync if Rust mutates the file. Adding a setting = add to Rust `Settings` + mirror in TS `Settings`/`DEFAULT_SETTINGS`, then read/write via `useSettings()`. Bump `version` only if a migration is needed.

## Tailscale (Settings → Integrations)
- **Detached from the persistent store.** Purely CLI-driven; reflects real system state.
- `tailscale_status` classifies output into: `not-found`, `not-running`, `starting`, `logged-out`, `connected`, `disconnected`.
- `tailscale_set(up)` runs `tailscale up`/`down`. The Settings row polls every 3s while the page is mounted (page unmount stops the timer). Toggle is **disabled unless truly connectable**; friendly messages (no raw CLI text).

## System power (Power menu)
- Rust commands: `toggle_fullscreen`, `is_fullscreen`, `minimize_window`, `toggle_maximize`, `is_maximized`, `close_app`, `system_power("sleep"|"reboot"|"shutdown")`, `enter_immersive`, `exit_immersive`, `set_start_with_windows`, `set_replace_desktop`, `booted_as_shell`.
- Power menu (`PowerMenu.tsx`) is a centered **Modal** (`ui/Modal.tsx`) with items: Immersive Mode (⇄ Exit Immersive Mode), Fullscreen ⇄ Windowed, Close Moonblast, Sleep, Reboot, Shutdown (danger).
- Sleep uses `SetSuspendState` directly (not `rundll32 powrprof.dll,…` which is unreliable). Reboot / Shutdown spawn `shutdown.exe /r /t 0` and `shutdown.exe /s /t 0`.

## Apps tab
- Curated, persisted list (`app_shortcuts` in settings). Discovered from the **Start Menu** (recursively walks `%PROGRAMDATA%\Microsoft\Windows\Start Menu\Programs` and the user equivalent for `.lnk`), **Microsoft Store** (`Get-StartApps` via PowerShell with `CREATE_NO_WINDOW`, only entries with AUMID — i.e. AppID contains `!`), and **Steam** (registry `HKCU\Software\Valve\Steam` + `appmanifest_*.acf` files, with `libraryfolders.vdf` parsed by a small VDF tokenizer; `kind`: `exe` | `store` | `steam`; `source`: `""` | `Store` | `Steam`). Browse any `.exe`/`.lnk` from the file dialog. Launching branches by kind: store → `IApplicationActivationManager::ActivateApplication` (COM, hand-declared vtable — `windows-sys` ships the CLSID but no interfaces; **not** `explorer shell:AppsFolder\<AUMID>`, which would start Explorer and raise the desktop when `auto_immersive` is on; falls back to the old AppsFolder path only when the desktop isn't replaced), steam → `steam://rungameid/<appid>`, else `ShellExecuteW`. Apps can be **renamed** via `display_name` (empty/null = original name).
- **Icon resolution** (priority): custom file (copied into `.icons`) → pinned SteamGridDB icon (also cached into `.icons`) → SteamGridDB by app name (network, requires key) → extracted desktop icon from the exe/.lnk → gradient auto. All results are written to the disk cache so reloads are offline.
- **`app_icon`** command: serves from the cache if present; otherwise tries SteamGridDB by name (when a key is set) and falls back to `extract_icon_png` (which resolves `.lnk` targets so Windows' shortcut-arrow overlay doesn't show). Returns a `data:image/png;base64,…` URI.
- **`cache_steamgrid_icon(url)`** downloads an SGDB icon into `.icons` and returns its local path so the URL becomes offline-safe.
- **`import_app_icon(src)`** copies a custom image into `.icons` so the icon survives the original file moving.
- **`clear_cached_icon(path)`** removes the cached PNG so "Use Desktop Icon" can re-extract.
- **`clipboard_icon_hint`** classifies the clipboard into `image` / `url` / `base64` / `text` / `none` so the context-menu action can be grayed out when nothing usable is there. **`clipboard_icon_import`** extracts the actual image (raw clipboard image, `data:` URI, https URL, or raw base64) and saves it as PNG into `.icons`.
- Context menu per app: **Rename…**, **Search SteamGridDB**, **Use Custom Icon**, **Copy From Clipboard** (disabled when nothing usable), **Clear custom icon** (when one is set), **Use Desktop Icon**, **Remove**.
- The installed picker uses the reusable **`ui/FilterList.tsx`** (search + source chips + A↔Z / Z↔A sort).
- App tiles: `p-3` wrapper, full-bleed `aspect-square` image with `rounded-2xl` mask, label below. Selection = `scale-[1.08]` + `bg-(--color-accent-soft)` shadow on the wrapper (handled inside `AppsView` via an internal `focusIdx` driven by the grid's keyboard handler).

## Design / UI conventions
- **Tokens** in `src/styles.css` `@theme`: `--color-{bg,surface,surface-2,border,muted,text,accent,accent-2,danger}` plus derived alpha tokens `accent-soft`, `surface-ghost`, `overlay`, `overlay-soft`, `muted-soft`. Use tokens for all colors (no hardcoded `black/x` opacity).
- Root font-size `17px` for Big-Picture sizing. Dark theme only.
- **Shared `ui/` primitives:** `Toggle`, `Row`, `Section`, `Select`, `Segmented`, `Modal`, `Toast`, `Input`, `ContextMenu`, `FilterList`, `Button`, `Card`, `Prompt`, `WifiModal`, `StatusPill`, `IconTile`. Reuse these — no duplicate local components.
- `Modal` default padding `p-5`; supports `title`/`subtitle` (in-panel header + X) and `width`. Closes on Escape and on overlay `onMouseDown` (with the panel itself stopping propagation so dragging out of the panel doesn't close it).
- `ContextMenu` is a single shared singleton: `useContextMenu()` writes to a module-level store, `<ContextMenuHost/>` (mounted once in `App.tsx`) renders whatever the store holds. Outside-click, scroll, blur, Escape all close it. Items support `label` / `icon` / `danger` / `disabled`.
- `Toast` is a small bottom-centered pill, no copy button. Auto-dismiss is owned by the caller (see `AppsView`, `MoonlightView`).
- Icons: Phosphor, `weight="bold"` everywhere (e.g. `<Play size={15} weight="fill" />` only where a filled glyph is intentional).
- Single-instance Tauri (second launch focuses the existing window).

## Build / run
- `npm install`
- `npm run tauri dev` (hot reload; Rust auto-recompiles on `src-tauri` change).
- `npm run tauri build` (production bundle; runs `tsc && vite build` first).
- ARM64 cross-build: load MSVC cross env first (`vcvarsall.bat x64_arm64`), then `npm run tauri build -- --target aarch64-pc-windows-msvc`. `ureq` uses rustls/`ring`; `ring` requires **clang** for ARM64 (`winget install LLVM.LLVM` once) — no OpenSSL/Perl needed.
- Rust compiles via MSVC; needs VS 2022 C++ tools + WebView2.
- Tauri plugins used: `tauri-plugin-dialog` (file picker), `tauri-plugin-opener`, `tauri-plugin-single-instance`.
- The codebase is purely **CLI-based** for Moonlight; keep it that way (no in-process protocol implementation).
