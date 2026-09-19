# Contributing

Thanks for your interest in Moonblast. A few notes to get you started.

## Development setup

Prerequisites (Windows):

- **Node.js** — Node 22+, or Node 20.19+. Vite 8 requires `^20.19.0 || >=22.12.0`.
- **Rust** stable, with the `aarch64-pc-windows-msvc` target if you want to build for ARM64.
- **Visual Studio 2022** with the "C++ build tools" workload, OR **Visual Studio Build Tools** with the same workload.
- **LLVM / clang** (required for ARM64 cross-compiles — `aws-lc-sys` / `ring` need it): `winget install LLVM.LLVM`.
- **For ARM64 builds only** — the Visual Studio installer must also include the **"C++ ARM64 build tools"** individual component (or equivalent Build Tools component). Without it, `vcvarsall.bat x64_arm64` will fail loudly. The build script deliberately does not require this upfront so that x64-only contributors don't pay the install cost.

## Workflow

1. Fork the repo.
2. Create a branch: `git switch -c feat/your-thing`.
3. Make your changes.
4. Verify:
   - `npm run build` — frontend typecheck + bundle
   - `npm run tauri dev` — runs the dev server with hot reload
   - `cargo check --manifest-path src-tauri/Cargo.toml` — backend typecheck
5. Commit. See `AGENTS.md` for project conventions (commit message style, code structure, design notes).
6. Open a PR.

## Conventions

The full project memory lives in [`AGENTS.md`](AGENTS.md). Read it before opening a PR — it documents:

- The window/Immersive Mode story (frameless, fullscreen, shell replacement).
- How Moonlight integration works (CLI-driven, not in-process protocol).
- The WiFi, audio, display, HDR, battery modules — all backed by Rust commands.
- The `useDebouncedRead` / push-event pattern for the status chips (battery / Wi-Fi / audio / display / Bluetooth).
- Keyboard / gamepad spatial nav.

If your change touches any of these areas, the AGENTS.md guidance takes precedence over generic "best practice" — match the established style.

## Reporting issues

Open an issue on GitHub. For security issues, see [`SECURITY.md`](SECURITY.md).
