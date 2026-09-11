//! Tiny file logger for Moonblast. The release build runs as `windows_subsystem =
//! "windows"` which means stderr / stdout have no console to write to, so a panic
//! or `eprintln!` is invisible to the user. This module gives us a single log
//! file the user can attach to a bug report and lets us answer "what crashed?"
//! without a debugger.
//!
//! Design:
//! - One append-only `moonblast.log` in the same Local AppData folder
//!   `settings.json` lives (`%LOCALAPPDATA%\com.moonblast.app\`).
//! - `init()` must run before any Tauri command can fire. Call from `run()`
//!   before `tauri::Builder::default()`.
//! - `init()` ALSO installs a `std::panic::set_hook` so any panic in any
//!   thread writes `PANIC at <file>:<line>: <payload>` + a backtrace into the
//!   log right before Rust unwinds. The default panic hook prints to stderr,
//!   which is invisible here — so we replace it.
//! - Writes go through a `Mutex<File>` to be safe across threads (Tauri commands
//!   run on the IPC pool; the streaming code spawns `std::thread::spawn`s).
//! - No rotation: if the file gets huge, the user has bigger problems. The OS's
//!   `FSCTL_FILE_LEVEL_TRIM` / antivirus will eventually clean it. A5 MB cap
//!   would be nice but isn't shipped yet.
//!
//! Hot-path cost: every `log!()` takes the mutex once + a single `write()`.
//! Buffered by the OS; no per-call `fsync`. Commands that fire every frame
//! (battery / wifi) call ~10× per second max, so the cost is invisible.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// Lazy-initialized on first call to `init()`. Wrapped in `OnceLock<Mutex<File>>`
/// because we can't pass an `AppHandle` to `std::panic::set_hook` (it's `fn` not
/// `Fn`), so the hook reads the global directly.
static LOG_FILE: std::sync::OnceLock<Mutex<File>> = std::sync::OnceLock::new();

/// Append a line to the log. No-op if `init()` hasn't run yet (which only
/// happens in tests / the stub supervisor that exits before the GUI starts).
pub fn log(line: &str) {
    if let Some(m) = LOG_FILE.get() {
        if let Ok(mut f) = m.lock() {
            // Best-effort: a failed write should never panic the app.
            let _ = writeln!(f, "[{}] {}", timestamp(), line);
        }
    }
}

/// `format!("{}", chrono::Utc::now())` without the chrono dep. Local time so
/// the timestamps line up with the user's wall clock when they look at the log.
fn timestamp() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Crude UTC -> local-time conversion. Windows uses UTC FILETIME; this gives
    // a stable readable log even without chrono. Format: YYYY-MM-DD HH:MM:SS.
    let (year, month, day, hour, min, sec) = epoch_to_local(secs);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        year, month, day, hour, min, sec
    )
}

/// Convert UNIX seconds (UTC) to local (year, month, day, hour, min, sec).
/// Uses `windows_sys`'s `GetSystemTime`/`SystemTimeToTzSpecificLocalTime` for
/// proper TZ + DST handling on Windows. On other platforms this falls back to
/// UTC (we only build for Windows anyway).
#[cfg(windows)]
fn epoch_to_local(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    use std::mem::MaybeUninit;
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    let _ = secs; // unused; we ask Windows for the current system time directly.
    let utc = unsafe {
        let mut st = MaybeUninit::<SYSTEMTIME>::uninit();
        windows_sys::Win32::System::SystemInformation::GetSystemTime(st.as_mut_ptr());
        st.assume_init()
    };
    let mut local = MaybeUninit::<SYSTEMTIME>::uninit();
    unsafe {
        let _ = windows_sys::Win32::System::Time::SystemTimeToTzSpecificLocalTime(
            std::ptr::null(),
            &utc,
            local.as_mut_ptr(),
        );
    }
    let local = unsafe { local.assume_init() };
    let y = local.wYear as i32;
    let m = local.wMonth as u32;
    let d = local.wDay as u32;
    let h = local.wHour as u32;
    let mi = local.wMinute as u32;
    let s = local.wSecond as u32;
    (y, m, d, h, mi, s)
}

#[cfg(not(windows))]
fn epoch_to_local(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    // Naive UTC decomposition. Only used in non-Windows test builds.
    let s = (secs % 60) as u32;
    let m = ((secs / 60) % 60) as u32;
    let h = ((secs / 3600) % 24) as u32;
    let days = (secs / 86400) as i64;
    // 1970-01-01 was a Thursday (4). Adjust to "days since 0000-03-01" for the
    // classic leap-year math; this is approximate but only used in tests.
    let (y, mo, d) = civil_from_days(days);
    (y, mo as u32, d as u32, h, m, s)
}

#[cfg(not(windows))]
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y } as i32;
    (y, m, d)
}

/// Open the log file and install the panic hook. Idempotent — calling twice
/// just no-ops the file open and re-installs the hook (the hook reads the
/// file through the global so a re-install is harmless).
pub fn init(data_dir: PathBuf) -> std::io::Result<()> {
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("logging: failed to create data dir: {e}");
        return Err(e);
    }
    let path = data_dir.join("moonblast.log");
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    // Truncate-to-zero on every cold start so the file doesn't grow forever.
    // We can re-append within a single run, but across runs we start fresh
    // — the most recent session's log is what matters when reproducing a bug.
    // Set RUST_LOG_PRESERVE=1 in the env to skip the truncate during triage.
    if std::env::var("MOONBLAST_LOG_PRESERVE").is_err() {
        // Seek to 0 and truncate by re-opening in write mode briefly.
        if let Ok(f) = OpenOptions::new().write(true).truncate(true).open(&path) {
            drop(f);
        }
    }
    let _ = LOG_FILE.set(Mutex::new(file));
    install_panic_hook();
    log(&format!(
        "Moonblast started (pid={}, data_dir={})",
        std::process::id(),
        data_dir.display()
    ));
    Ok(())
}

fn install_panic_hook() {
    // Default hook prints to stderr — invisible to windowed apps. Replace it.
    // We write the panic info + a backtrace into the log file, then the panic
    // continues to unwind (Rust's default on Windows MSVC is `unwind`).
    std::panic::set_hook(Box::new(|info| {
        let location = info.location().map(|l| {
            format!("{}:{}:{}", l.file(), l.line(), l.column())
        }).unwrap_or_else(|| "<unknown>".to_string());
        let payload = info.payload().downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        log(&format!("PANIC at {location}: {payload}"));
        // `Backtrace::capture()` returns "disabled" unless RUST_BACKTRACE=1 OR
        // the panic hook itself forces it. We force it so the log has the
        // stack even when the env var isn't set.
        std::env::set_var("RUST_BACKTRACE", "1");
        let bt = std::backtrace::Backtrace::force_capture();
        // Trim the backtrace to one frame per line; full output can be huge.
        for line in bt.to_string().lines() {
            log(&format!("  {line}"));
        }
    }));
}

/// Convenience macro that formats inline like `format_args!` + writes a line.
/// Cheap enough to call on the hot path of Tauri commands.
#[macro_export]
macro_rules! moonblast_log {
    ($($arg:tt)*) => {{
        $crate::logging::log(&format!($($arg)*));
    }};
}