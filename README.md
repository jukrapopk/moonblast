# Moonblast

A lightweight, low-footprint **Fullscreen Mode / Big Picture-style launcher** for Windows. Moonblast is a clean, modern shell for launching your apps and streaming via [Moonlight](https://moonlight-stream.org/). Native, fullscreen-friendly, and gentle on RAM.

## What's in it

- **Apps** — a curated grid of Windows apps, with icons, search, and per-app context menus. Discovers from the Start Menu, Microsoft Store, and Steam; you can also browse any `.exe` or `.lnk`.
- **Moonlight streaming** — unified host list (mDNS + paired + saved), per-stream settings, in-app pairing flow, online/offline status. Drives Moonlight QT via its CLI.
- **Immersive Mode** — one tap from the Power menu (or set **Auto Immersive Mode** in Settings) makes Moonblast your Windows shell at sign-in: no desktop, no taskbar, no startup apps. Clean exit, crash-safe stub, no UAC.
- **System status chips** in the TopBar — Battery, Wi-Fi, Audio, Display. Each opens a full in-app modal (Wi-Fi picker + password form, audio mixer, HDR + resolution controls, battery status). Nothing bounces you out to Windows Settings.
- **Keyboard + gamepad** — every action reachable via keyboard; spatial navigation works with arrow keys or a controller. Tab / Shift+Tab traverse, Escape closes modals, F11 toggles fullscreen.

## Stack

React 19 + TypeScript on the frontend, Rust (Tauri 2) on the backend, WebView2 for the window. Tailwind for styling. Phosphor icons.

## Getting started

```bash
npm install
npm run tauri dev      # dev with hot reload
npm run tauri build    # production bundle
```

Prerequisites: Node 22+, Rust stable, Visual Studio 2022 C++ build tools, WebView2 (already on Windows 10/11).

### ARM64 build

```bash
# one-time
winget install LLVM.LLVM   # clang for ring's ARM64 assembly

# build
powershell -ExecutionPolicy Bypass -File scripts\build-arm64.ps1
powershell -ExecutionPolicy Bypass -File scripts\build-arm64.ps1 -Destination 'Z:\'
```

The helper locates Visual Studio via `vswhere.exe` and resolves `clang.exe` from your `PATH`, so it works across VS editions and LLVM install locations.

## Keyboard

| Action | Keys |
|---|---|
| Fullscreen | `F11` |
| Move focus | Arrows |
| Activate | `Enter` / `Space` |
| Close modal | `Escape` |
| Next / prev view | `Tab` / `Shift+Tab` |

## Project layout

```
src/                React frontend (components, hooks, shared ui/)
src-tauri/          Rust backend (commands in lib.rs, settings.rs, shell.rs, audio.rs, wifi.rs, …)
scripts/            ARM64 cross-build helper
```

`AGENTS.md` has the deeper project memory — design decisions, module-level notes, conventions. `CONTRIBUTING.md` covers the contributor workflow.

## Licence

MIT. See [`LICENSE`](LICENSE).
