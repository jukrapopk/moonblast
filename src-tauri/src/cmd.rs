//! Process spawning helpers used across Moonblast's Tauri commands.
//!
//! Two patterns are common:
//!
//! 1. **Capture-and-wait** — run a CLI to completion, read its stdout /
//!    stderr / exit status (most `netsh` calls, `powershell Get-StartApps`,
//!    `tailscale status`, `shutdown.exe /s /t 0`, etc.). The helpers
//!    here wrap `Command::output()` so every site sets
//!    `creation_flags(CREATE_NO_WINDOW)` without retyping the magic
//!    number.
//!
//! 2. **Detached / fire-and-forget** — spawn `moonlight.exe pair` /
//!    `explorer.exe` / `taskkill.exe` without blocking on stdout. The
//!    stream side gets piped to `Stdio::null()` so the child can't
//!    wedge on a full pipe.
//!
//! Both helpers use `CREATE_NO_WINDOW` (0x0800_0000) — every Windows
//! child process Moonblast launches lives or dies by this flag
//! (otherwise `netsh`, `powershell`, and friends flash a console
//! window in front of the launcher).

#![cfg(windows)]

use std::ffi::OsStr;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Output, Stdio};
use std::time::Duration;

/// Win32 `CREATE_NO_WINDOW` flag — keeps spawned CLIs from flashing
/// a console window in front of the launcher.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Run a CLI to completion with `CREATE_NO_WINDOW` and return its
/// `Output`. `Command::output()` already pipes stdio internally,
/// so this is just `output()` plus the creation flag.
pub fn run_output<P: AsRef<OsStr>>(program: P, args: &[&str]) -> std::io::Result<Output> {
    Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

/// Same as `run_output` but bounded by `deadline` — kills the child
/// on timeout so a hung CLI can't stall the IPC. Equivalent to the
/// inline `run_with_timeout` helper but takes `program` + `args`
/// directly instead of a `FnOnce() -> Command` closure.
pub fn run_output_bounded<P: AsRef<OsStr>>(
    program: P,
    args: &[&str],
    deadline: Duration,
) -> std::io::Result<Output> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let until = std::time::Instant::now() + deadline;
    loop {
        match child.try_wait()? {
            Some(_) => return child.wait_with_output(),
            None => {
                if std::time::Instant::now() >= until {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "subprocess timed out",
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// Spawn a CLI in the background, detaching all stdio to `Stdio::null()`
/// so the child can't wedge on a full pipe. Used for `moonlight.exe pair`,
/// `moonlight.exe quit`, `taskkill.exe`, etc.
pub fn spawn_detached<P: AsRef<OsStr>>(program: P, args: &[&str]) -> std::io::Result<Child> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
}
