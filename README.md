# Moonblast

A lightweight, low-footprint **Fullscreen Mode / Big Picture-style launcher for Windows**. A clean shell for launching your apps and streaming games via [Moonlight](https://moonlight-stream.org/) — no remote-control app, no extra daemon, native chrome that hides cleanly in fullscreen. Windows 10/11 only.

## What's in it

- **Apps** — curated grid of Windows apps with search, sort, and per-app context menus. Discovers from the Start Menu, Microsoft Store, and Steam; you can also browse any `.exe` or `.lnk`.
- **Moonlight streaming** — one unified list of hosts (mDNS + paired + your saved addresses, deduplicated by name). Per-stream settings (resolution, bitrate, codec, HDR, gamepad mapping, …), online/offline status, and a Pair action that drives Moonlight's own CLI. Works over LAN and Tailscale.
- **Immersive Mode** — fullscreen + desktop suppression, one tap from the Power menu. Set **Auto Immersive Mode** in Settings to make Moonblast your shell at sign-in: no desktop, no taskbar, no startup apps. Per-user registry write, no UAC, with a crash-safe stub that hands the desktop back if anything goes wrong.
- **System chips in the TopBar** — Display, Wi-Fi, Bluetooth, Battery, Audio. Each opens a full in-app modal: HDR + resolution controls, Wi-Fi picker with saved profiles and password form, Bluetooth radios, battery status with time-remaining, audio mixer with per-app sliders. Nothing bounces you out to Windows Settings.
- **Keyboard + gamepad** — every action reachable via keyboard; arrows do spatial navigation, D-pad / left stick mirrors arrows. Tab traverses focusables in document order; Escape closes the topmost modal.
- **Theming** — Dark / Light / Auto, with a custom accent color picker. Auto follows the Windows app-mode setting live.

## Stack

React 19 + TypeScript on the frontend, Rust (Tauri 2) on the backend, WebView2 for the window. Tailwind for styling. Phosphor icons. The streaming / Wi-Fi / audio / battery / display / HDR modules are all Rust commands fronted by in-app UI — no hand-offs to the Windows Settings app.

## Getting started

```bash
npm install
npm run tauri dev      # dev with hot reload
npm run tauri build    # production bundle
```

Prerequisites: Node 22+ (or Node 20.19+), Rust stable with the MSVC toolchain, Visual Studio 2022 C++ build tools, WebView2.

### ARM64 build

```bash
# one-time — ring needs clang for the ARM64 assembly
winget install LLVM.LLVM

# build
powershell -ExecutionPolicy Bypass -File scripts\build-arm64.ps1
powershell -ExecutionPolicy Bypass -File scripts\build-arm64.ps1 -Destination 'Z:\'
```

The helper locates Visual Studio via `vswhere.exe` and resolves `clang.exe` from your `PATH`, so it works across VS editions and LLVM install locations.

## Keyboard

| Action | Keys |
|---|---|
| Fullscreen | `F11` |
| Move focus | Arrows (or D-pad / left stick) |
| Activate | `Enter` / `Space` |
| Close modal | `Escape` |
| Next / prev view | `Tab` / `Shift+Tab` |

## Project layout

```
src/                React frontend (components, hooks, shared ui/)
src-tauri/          Rust backend (commands, settings, Windows shell, audio, Wi-Fi, display, HDR)
scripts/            ARM64 cross-build helper
```

[`AGENTS.md`](AGENTS.md) has the deeper project memory — design decisions, module notes, conventions. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the contributor workflow. [`SECURITY.md`](SECURITY.md) describes the threat model and the asset-protocol scope.

## Licence

MIT. See [`LICENSE`](LICENSE).
