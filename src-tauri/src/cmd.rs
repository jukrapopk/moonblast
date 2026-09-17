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

/// Encode a Rust `&str` as a null-terminated UTF-16 `Vec<u16>` for
/// Win32 APIs that take `LPCWSTR`. Equivalent to the inline
/// `.encode_utf16().chain(std::iter::once(0)).collect()` pattern
/// (or `encode_utf16().collect() + push(0)`) that previously lived
/// in audio.rs / display.rs / lib.rs / theme.rs.
pub fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Sleep for at most `max_ms` milliseconds, but return early (with
/// `false`) if `deadline` passes. Returns `true` once the full
/// `max_ms` have elapsed. Polled every 50ms — the granularity is
/// fine because the caller is checking the deadline anyway. Used by
/// the wifi + bluetooth scan paths to replace a raw `thread::sleep`
/// that could outlive the surrounding bounded wait.
pub fn bounded_sleep_until(deadline: std::time::Instant, max_ms: u64) -> bool {
    let step = std::time::Duration::from_millis(50);
    let total = std::time::Duration::from_millis(max_ms);
    let start = std::time::Instant::now();
    while start.elapsed() < total {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(step.min(total - start.elapsed()));
    }
    true
}

/// True if `deadline` has passed. Check before / after each blocking
/// step so the wifi / bluetooth scan paths can bail when their
/// budget runs out instead of waiting on a wedged netsh / WinRT API.
pub fn deadline_reached(deadline: std::time::Instant) -> bool {
    std::time::Instant::now() >= deadline
}
