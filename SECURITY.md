# Security

## Reporting vulnerabilities

Please report security issues privately via GitHub's "Report a vulnerability" feature on the repository. Do not file public issues for suspected vulnerabilities.

## Threat model

Moonblast is a **single-user desktop shell** that runs with the user's full Windows credentials. It is not a sandboxed application; it is the launcher the user sits at, with the same trust level as Explorer or any other first-party shell.

The threat model this project is designed against:

- **The user trusts Moonblast** to manage their session: launching apps, talking to their Sunshine/Moonlight hosts on the local network, switching audio output devices, toggling Wi-Fi, reading battery and HDR status, etc.
- **The user trusts the frontend code** — every Tauri command is invoked from the in-process WebView, no remote scripts, no third-party iframes. The CSP is `null` (not set) because there is no remote origin to protect against; all assets ship with the binary.
- **The user does not expect Moonblast to exfiltrate data** — it talks to the user's Tailscale network for Moonlight discovery, to the SteamGridDB API if a key is configured, and to Windows APIs for everything else. No telemetry, no analytics, no third-party SDKs.

This is the same trust model as Explorer, PowerToys, or any other user-installed system tool. It is **not** appropriate for multi-user systems, kiosks, or any environment where the user account is shared.

## `assetProtocol.scope = ["**"]` — why the wildcard?

`tauri.conf.json` configures the WebView's asset protocol with a wildcard scope (`**`), which lets the WebView read any local file path via `convertFileSrc`. This looks alarming in isolation — a security reviewer would correctly ask "why does a UI need to read `C:\Windows\System32\config\SAM`?" — so here's the actual justification:

The app legitimately needs to load **user-supplied local files** from three sources that the bundler cannot enumerate at build time:

1. **Icons cached under `%LOCALAPPDATA%\com.moonblast.app\.icons`** — the disk-backed icon cache for app tiles (used by every reload, so the bundle doesn't have to re-resolve them).
2. **Per-shortcut custom-icon files** chosen via the OS file picker (can be anywhere on disk).
3. **SteamGridDB-pinned icons** also cached under `.icons`.

Narrowing the scope to e.g. `["$APPDATA/com.moonblast.app/**"]` would break #2 (the user can pick any file) and break the "copy custom icon into the .icons cache" workflow. None of the loaded paths are ever written to by the WebView — `assetProtocol` is read-only.

### Mitigations

- The WebView is single-origin (no remote loads, no `<iframe>`s). CSP is `null` because the default-deny isn't necessary when there's no remote to deny.
- No file path leaves the process except via IPC commands the user explicitly invokes (file picker → save custom icon path → settings.json).
- The Tauri `dialog` plugin's file picker is the only path through which user-supplied paths enter the app; paths from the picker are passed as strings and never executed.

## Writing to the Windows registry

Auto Immersive Mode (`fullscreen.auto_immersive`) writes a single value to the **per-user** (`HKCU\`) registry hive:

```
HKCU\Software\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell
```

This makes Moonblast the user's shell at sign-in (replacing Explorer for that user only — no machine-wide changes, no elevation). A backup of the previous value lives at `HKCU\Software\Moonblast\OriginalShell`. The 3-strike crash counter (`HKCU\Software\Moonblast\ShellCrashCount`) auto-disables the takeover after persistent crashes so a bad build can't lock the user out of their desktop.

This is opt-in via Settings → Fullscreen → Auto Immersive Mode. Toggling it off restores the previous shell value (or deletes the value if it was absent before).

## Process management

`scripts/build-arm64.ps1` invokes `cmd.exe` to set up the MSVC cross environment. This runs at build time only — never at runtime inside Moonblast itself.
