# Resolved: Xbox-FSE-like Immersive management

**Status:** Implemented as a single **"Auto Immersive Mode"** toggle
(`fullscreen.auto_immersive`, `src-tauri/src/shell.rs`). Compiles clean; stub, COM
activation and the Winlogon write were verified at runtime. **A sign-in/reboot test is
still pending** — see below.

> An earlier revision of this doc claimed "v1 implemented". That was wrong: nothing had
> been written. The design below also replaces that revision's scheduled-task
> elevation architecture, which was based on two incorrect assumptions.

## Goal
Boot into the launcher without the desktop, keep background apps out of the way —
**without a UAC prompt on every run**.

## What actually shipped

Exposed as a single **"Auto Immersive Mode"** toggle (`fullscreen.auto_immersive`) that
both registers the shell and arms Immersive Mode. Use the **per-user** shell value, not
the machine-wide one:

```
HKCU\Software\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell
```

`userinit.exe` reads this at sign-in and launches it as the shell, falling back to the
HKLM value (`explorer.exe`) when absent. It lives in the user's own hive, so it needs
**no elevation at all** — not even a one-time prompt.

| Moment | UAC? |
|---|---|
| Enabling the takeover | none |
| Sign-in | none |
| Normal app launch | none |

This is strictly better than `HKCU\...\Run` + `taskkill explorer`: **Run keys are
processed by Explorer**, so Explorer must fully start before the launcher can even run.
With the shell swap Explorer never starts at all — no desktop/taskbar flash, and no
`Run`/`RunOnce`/Startup-folder apps either, so background-app suppression is free.

## Why the original elevation design was dropped

Two load-bearing assumptions in it were false:

1. **`schtasks /Run` cannot pass arguments.** Its full syntax is
   `/S /U /P /I /TN /HRESULT` — there is no `/arg`. The proposed
   `schtasks /run /tn ... /arg "<op>"` could never have worked. (`/IT` is a `/Create`
   flag, not a `/Run` flag.) Passing parameters needs the COM `IRegisteredTask::Run`
   with `$(Arg0)` placeholders.
2. **A bin at `src-tauri/src/bin/mgmt.rs` cannot carry its own manifest.**
   `tauri_build::build()` emits `cargo:rustc-link-lib`/`-search` package-wide, so every
   bin target inherits Moonblast's `asInvoker` manifest; a second manifest resource
   conflicts.

Both became moot: the shell swap needs no elevation, so there is no helper, no task,
and no manifest to embed. The single-task-plus-job-file variant was also a local
privilege-escalation hazard (any non-admin write to the job file would have executed
elevated), which the no-args design avoids entirely.

## Architecture

- **One toggle, applied at next sign-in.** Turning it on registers the shell but
  deliberately does *not* enter Immersive Mode then and there. The stub launches the
  app with `--autostart`, and only that flag triggers Immersive Mode, so the setting
  can never yank a running session into fullscreen.
- **Stub, not the launcher directly.** Winlogon runs `Moonblast.exe --shell`, handled in
  `main.rs` before any Tauri setup (and before the single-instance plugin). The stub
  runs the launcher, waits, then guarantees a desktop (`ensure_desktop` → Explorer
  unless `GetShellWindow` reports one) and parks as the session's shell process. A
  launcher crash still leaves a working desktop.
- **Escape hatch:** 3 consecutive fast crashes (`ShellCrashCount` under
  `HKCU\Software\Moonblast`, cleared 30s into a healthy run) auto-restore the
  normal shell. To recover non-emergently, toggle Auto Immersive Mode off in
  Settings — the setting only arms the *next* sign-in, so it never yanks the
  user out of Immersive Mode on the spot.
- **Backup:** the previous `Shell` value is saved to `OriginalShell` /
  `OriginalShellSet`, so restore correctly reproduces "absent" vs. an explicit value.
- **Self-heal:** `setup` reconciles stored intent against the registry. If the setting is
  on but the shell **isn't** registered, a rescue already fired — it clears the setting
  rather than silently re-arming. If it is registered, it just refreshes the exe path so
  moving or updating the app can't strand a stale entry.
- **Store apps** now activate via `IApplicationActivationManager::ActivateApplication`
  instead of `explorer shell:AppsFolder\<AUMID>` — the old path would have started
  Explorer and raised the desktop behind the launcher.

## Verified

- `--shell` re-launches without the flag → exactly 2 processes, stable. No fork bomb.
- `IApplicationActivationManager` CLSID/IID/signature: `hr=0x00000000`, app activated.
- Writing the real Winlogon value: **Defender did not revert it** within 12s; original
  value restored afterwards.

## Still unverified (needs a real sign-in)

- That Windows honours the value across an actual logon and the launcher comes up as
  the shell. This is the one remaining unknown.
- Whether the session logs off when a custom shell process exits. Reachable docs cover
  Shell Launcher (Enterprise-only, which explicitly monitors the shell), not the plain
  `Winlogon\Shell` value. The stub parks instead of exiting, so the shell slot is never
  empty and the question shouldn't arise — but it hasn't been proven.
- Whether a **full** Defender scan (rather than real-time protection) flags the key.
  It is a well-known malware persistence location; third-party EDR may differ.

## Deferred (still needs real elevation, if ever wanted)

- `wu-suspend` / `wu-resume` (`Stop-Service wuauserv`) — the only op that genuinely
  needs the elevated token. If added, the one-time `/rl HIGHEST` scheduled task is the
  right escape hatch: one prompt ever, silent thereafter.
- Killing elevated / other-user processes.
- `notifications-mute` — largely moot, since there are no toasts or tray without
  Explorer running.
- HKLM-wide shell swap (all users) and true Winlogon startup-app deferral.

## Caveats

- Changes the sign-in experience for that user until toggled off.
- Admin is not SYSTEM/TrustedInstaller; some services stay protected regardless.
- The shell binary must remain `asInvoker` — a `requireAdministrator` shell can't launch
  as the shell under UAC at all.
