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
- Frameless window (`decorations:false`) with **`TitleBar.tsx`** (drag region + minimize/maximize/close). TitleBar hides when fullscreen.
- `toggle_fullscreen` in Rust also unmaximizes first (avoids a blank strip — the known frameless max→fullscreen artifact). **F11** toggles; `App.tsx` holds `fullscreen` state and threads it to the Power menu button (label/icon flip: Fullscreen ⇄ Windowed).
- **Immersive Mode** (Power menu item or **F10**; exit with **Esc**/**F10**): fullscreen + clean surface. Rust `enter_immersive` forces fullscreen, minimizes other top-level windows (`EnumWindows`), and **kills `explorer.exe`** to suppress the desktop/taskbar; `exit_immersive` restarts it (guarded by the `EXPLORER_KILLED` `AtomicBool`). The shell is also restored on `close_app` and on window `Destroyed` (`on_window_event`). **TopBar stays visible** — suppression targets the *outside* (desktop/background), not the app's own chrome.
- **Auto Immersive Mode** (`fullscreen.auto_immersive`, gated in the UI on `start_with_windows`): meant to enter Immersive on launch. `set_start_with_windows` writes/removes the `HKCU …\Run` key. NOTE: the frontend auto-enter effect currently runs on mount before settings hydrate (`SettingsContext` is async), so startup auto-enter is not reliably triggered yet — gate on settings-ready first.
- **Console windows**: child processes (`powershell Get-StartApps`, `taskkill`, `tailscale`, `shutdown`) are spawned with `CREATE_NO_WINDOW` (`creation_flags(0x08000000)`) so no console flashes.

## Layout & navigation
- `TitleBar` → `TopBar` (icon-only nav: 🗂 Apps, 🖥 Moonlight on left; ⚙ Settings, ⏻ Power on right) → `main` scroll area.
- Views: **apps | moonlight | settings**. Wrappers in `App.tsx` use `p-8` on all sides (no `h-full`, so bottom padding works when scrolled).
- **`PageShell.tsx`** is the shared layout (title/subtitle/actions/tabs/children, `max-w-6xl`). Every page uses it.
- Tabs via shared **`ui/Segmented.tsx`** (variants: `tabs` pillar, `value` picker).

## Moonlight integration (IMPORTANT — current architecture)
Streaming/pairing is done by **driving the Moonlight QT client via its CLI**, NOT by reimplementing the protocol in-process. Keep it that way.
- The user selects the **Moonlight install folder** in Settings → Integrations; it's validated to contain `moonlight.exe`/`moonlight-qt.exe` (`validate_moonlight_dir`).
- Rust commands in `lib.rs` run the exe:
  - `moonlight_list_apps(host)` → `moonlight list <host>` (action is `list`, not `listapps`).
  - `moonlight_pair(host)` → `moonlight pair <host>` (shows Moonlight QT's own pairing UI).
  - `moonlight_stream(host, app)` → `moonlight stream <host> <app>`. "Desktop" streams the host's Desktop app.
  - `moonlight_quit(host)` → `moonlight quit <host>`.
- **Host discovery:** `discover_hosts()` (Rust) browses `_nvstream._tcp.local.` via `mdns-sd` and probes each host with `moonlight list <host>` to classify paired/unpaired.
- **Event-driven pairing refresh** (`moonlight_pair`): Rust waits for the `pair` process to exit, then emits a `pair-complete` event; the frontend rescans once (no polling). The unpaired discover flow is: paired → **Desktop + Apps**; unpaired → **Pair**.
- Note: same-PC local connect works via `127.0.0.1`.

## Settings (persistent)
- **Rust `settings.rs`** — typed serde `Settings` with `version`, `general` (start_with_windows, last_view), `integrations` (moonlight_folder/enabled, apps_enabled, steamgrid_key), `moonlight` (streaming prefs), `fullscreen` {suppress_explorer, auto_fullscreen, auto_immersive}, `machines[{name,address}]`, `app_shortcuts[{name,path,source,kind,display_name,custom_icon,use_desktop_icon,steamgrid_icon}]`. Loaded once from `settings.json`, written atomically, emits `settings-changed`. **All persistent data is centralized** in one Local AppData folder (`%LOCALAPPDATA%\<identifier>\`): `settings.json` + sibling `.icons\` icon cache; migrated from the old Roaming config dir on first run.
- **Frontend `settings/SettingsContext.tsx`** — `SettingsProvider` wraps the app; `useSettings()` → `{ settings, update(mutator) }`. **Settings hydrate asynchronously** after the first await `get_settings`, so mount-time behavior must account for `DEFAULT_SETTINGS` until then. Optimistic updates; single source of truth.
- Adding a setting = add to Rust `Settings` + mirror in the TS `Settings`/`DEFAULT_SETTINGS`, then read/write via `useSettings()`.
- To add a setting field in Rust Settings, update `settings.rs` Default and `SettingsContext.tsx` (interface + DEFAULT_SETTINGS); bump `version` if a migration is needed.

## Tailscale (Settings → Integrations)
- **Detached from the persistent store.** Purely CLI-driven; reflects real system state.
- `tailscale_status` classifies output into: `not-found`, `not-running`, `starting`, `logged-out`, `connected`, `disconnected`.
- `tailscale_set(up)` runs `tailscale up`/`down`. Toggle is **disabled** unless truly connectable; friendly messages (no raw CLI text).

## System power (Power menu)
- Rust commands: `toggle_fullscreen`, `minimize_window`, `toggle_maximize`, `is_maximized`, `is_fullscreen`, `close_app`, `system_power("sleep"|"reboot"|"shutdown")`, `enter_immersive`, `exit_immersive`, `set_start_with_windows`.
- Power menu (`PowerMenu.tsx`) is a centered **Modal** (`ui/Modal.tsx`) with items: Immersive Mode, Fullscreen, Close Moonblast, Sleep, Reboot, Shutdown (danger), Cancel.

## Apps tab
- Curated, persisted list (`app_shortcuts` in settings). Discovered from the **Start Menu**, **Microsoft Store** (`Get-StartApps`, AUMID `!` filter), and **Steam** (registry + `appmanifest_*.acf`/`libraryfolders.vdf` via a small VDF tokenizer; `kind`: `exe` | `store` | `steam`; `source`: `""` | `Store` | `Steam`). Browse any `.exe`/`.lnk`. Launching branches by kind: store → `explorer shell:AppsFolder\<AUMID>`, steam → `steam://rungameid/<appid>`, else ShellExecute. Apps can be **renamed** via `display_name` (empty/null = original name).
- Icons resolved/cached to disk: `app_icon` (desktop extract or SteamGridDB-by-name) writes a PNG to `…\.icons\` keyed by app path, so reloads are offline. Priority: **custom file → pinned SteamGridDB → desktop-extracted → gradient auto**.
- `cache_steamgrid_icon` downloads a pinned SGDB icon to `.icons`; `import_app_icon` copies a custom image into `.icons` (so moving the original won't break it); `clear_cached_icon` purges on "Use Desktop Icon".
- Installed picker uses the reusable **`ui/FilterList.tsx`** (search + source chips + A↔Z sort).

## Design / UI conventions
- **Tokens** in `src/styles.css` `@theme`: `--color-{bg,surface,surface-2,border,muted,text,accent,accent-2,danger}` plus derived alpha tokens `accent-soft`, `surface-ghost`, `overlay`, `overlay-soft`, `muted-soft`. Use tokens for all colors (no hardcoded `black/x` opacity).
- Root font-size `17px` for Big-Picture sizing.
- **Shared `ui/` primitives:** `Toggle`, `Row`, `Section`, `Select`, `Segmented`, `Modal`, `Toast`, `Input`, `ContextMenu`, `FilterList`. Reuse these — no duplicate local components.
- `Modal` default padding `p-5`; supports `title`/`subtitle` (in-panel header + X) and `width`.
- `Toast` is width-capped with a copy button.
- Icons: Phosphor, `weight="bold"` everywhere.

## Build / run
- `npm run tauri dev` (hot reload; Rust auto-recompiles on `src-tauri` change).
- `npm run tauri build`.
- ARM64 cross-build: load MSVC cross env first (`vcvarsall.bat x64_arm64`), then `npm run tauri build -- --target aarch64-pc-windows-msvc`. `ureq` uses Windows native TLS (`native-tls`, no `ring`) so no clang is needed for the ARM64 target.
- Rust compiles via MSVC; needs VS 2022 C++ tools + WebView2.
- The codebase is purely **CLI-based** for Moonlight; keep it that way (no in-process protocol implementation).