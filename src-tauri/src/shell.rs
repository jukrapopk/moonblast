//! Replacing the Windows desktop shell with Moonblast.
//!
//! `userinit.exe` reads `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell`
//! at sign-in and launches that as the shell, falling back to the HKLM value
//! (`explorer.exe`) when it isn't set. Because the per-user value lives in the
//! user's own hive it is writable **without elevation** — no UAC prompt, ever.
//!
//! The win over the `HKCU\...\Run` + `taskkill explorer` approach is that Explorer
//! never starts at all, instead of starting and then being killed:
//!   - no desktop/taskbar flash before the launcher appears, and
//!   - `Run`/`RunOnce` keys and the Startup folder are processed *by Explorer*, so
//!     none of the user's background apps launch either.
//!
//! Winlogon points at a **stub** (`Moonblast.exe --shell`, see `run_shell_stub`)
//! rather than at the launcher directly, so that a Moonblast crash still leaves the
//! user with a working desktop.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE};

use crate::settings;
use winreg::RegKey;

const WINLOGON: &str = r"Software\Microsoft\Windows NT\CurrentVersion\Winlogon";
const BACKUP_KEY: &str = r"Software\Moonblast";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Marker in the `Shell` value identifying it as ours.
const STUB_FLAG: &str = "--shell";

/// Passed to the launcher when the stub starts it, i.e. only on a real sign-in.
/// Entering Immersive Mode keys off this, so flipping the setting mid-session
/// never yanks the user into it — the change applies at the next sign-in.
pub const AUTOSTART_FLAG: &str = "--autostart";

/// Consecutive failed shell starts before we give the desktop back on our own.
const MAX_SHELL_CRASHES: u32 = 3;

/// How long the launcher must stay up before a boot counts as successful.
pub const CRASH_RESET_SECS: u64 = 30;

fn winlogon(write: bool) -> Result<RegKey, String> {
    let flags = if write { KEY_READ | KEY_SET_VALUE } else { KEY_READ };
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(WINLOGON, flags)
        .map_err(|e| e.to_string())
}

fn backup() -> Result<RegKey, String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(BACKUP_KEY)
        .map(|(k, _)| k)
        .map_err(|e| e.to_string())
}

fn current_shell() -> Option<String> {
    winlogon(false).ok()?.get_value::<String, _>("Shell").ok()
}

/// The command line Winlogon should run: our own exe in stub mode. Quoted, since
/// the install path (and the dev `target\debug` path) can contain spaces.
fn stub_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(format!("\"{}\" {STUB_FLAG}", exe.display()))
}

/// Whether Moonblast is currently registered as this user's shell.
pub fn desktop_replaced() -> bool {
    current_shell().map(|s| s.contains(STUB_FLAG)).unwrap_or(false)
}

/// Register or unregister Moonblast as the user's shell.
///
/// Idempotent: enabling always rewrites the value with the *current* exe path, so
/// re-running after the app moves or updates repairs a stale entry.
///
/// Deliberately does **not** clear the crash counter when enabling: `setup` calls
/// this on every armed boot to refresh the path, and resetting there would wipe
/// the count the stub had just incremented — the 3-strike bail-out could then
/// never trigger. Only an explicit re-arm from the UI, a healthy 30s run, or
/// disabling clears it.
pub fn set_replace_desktop(enabled: bool) -> Result<(), String> {
    let key = winlogon(true)?;
    if enabled {
        // Back up whatever was there first — but never back up our own stub, or
        // toggling twice would leave the user with no way back to Explorer.
        let existing = current_shell();
        let ours = existing.as_deref().map(|s| s.contains(STUB_FLAG)).unwrap_or(false);
        if !ours {
            let b = backup()?;
            // `HKCU\...\Shell` is often absent entirely; remember that so we can
            // restore "absent" rather than forcing an explicit "explorer.exe".
            let _ = b.set_value("OriginalShellSet", &u32::from(existing.is_some()));
            let _ = b.set_value("OriginalShell", &existing.unwrap_or_default());
        }
        key.set_value("Shell", &stub_command()?).map_err(|e| e.to_string())?;
    } else {
        let b = backup()?;
        let had = b.get_value::<u32, _>("OriginalShellSet").unwrap_or(1);
        let original = b
            .get_value::<String, _>("OriginalShell")
            .ok()
            .filter(|s| !s.trim().is_empty() && !s.contains(STUB_FLAG));
        if had == 0 {
            // There was no per-user value before us; removing ours falls back to
            // the machine-wide HKLM value, which is what Windows shipped with.
            let _ = key.delete_value("Shell");
        } else {
            key.set_value("Shell", &original.unwrap_or_else(|| "explorer.exe".to_string()))
                .map_err(|e| e.to_string())?;
        }
        reset_crash_count();
    }
    Ok(())
}

fn crash_count() -> u32 {
    backup().ok().and_then(|k| k.get_value::<u32, _>("ShellCrashCount").ok()).unwrap_or(0)
}

fn bump_crash_count() {
    if let Ok(k) = backup() {
        let _ = k.set_value("ShellCrashCount", &(crash_count() + 1));
    }
}

/// Mark the current shell session as healthy. Called once the launcher has stayed
/// up long enough to prove it isn't crash-looping.
pub fn reset_crash_count() {
    if let Ok(k) = backup() {
        let _ = k.set_value("ShellCrashCount", &0u32);
    }
}

fn shift_held() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_SHIFT};
    // High bit set = currently down.
    (unsafe { GetAsyncKeyState(VK_SHIFT as i32) } as u16 & 0x8000) != 0
}

/// Whether a shell (Explorer's desktop) is currently running.
fn shell_running() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetShellWindow;
    !unsafe { GetShellWindow() }.is_null()
}

/// Start Explorer unless a desktop is already up. Used to hand the user back a
/// normal Windows session when Moonblast steps aside.
pub fn ensure_desktop() {
    if !shell_running() {
        let _ = Command::new("explorer.exe").spawn();
    }
}

/// Where Tailscale's installer registers itself. Resolving this is the standard
/// way to find the GUI client (`tailscaled` is a separate Windows service whose
/// own path we don't need).
const TAILSCALE_REG_KEY: &str = r"SOFTWARE\Tailscale";

/// Resolve the installed Tailscale GUI executable, if present.
///
/// Reads `HKLM\SOFTWARE\Tailscale\InstallPath` (set by the standard installer),
/// then looks for `Tailscale.exe` inside it. Returns `None` for uninstalled /
/// non-standard installs — the stub then silently skips the launch, and the
/// user can address that by reinstalling Tailscale normally. `pub` so the UI
/// can use the same definition of "installed" the stub uses.
pub fn tailscale_install_path() -> Option<PathBuf> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm.open_subkey(TAILSCALE_REG_KEY).ok()?;
    let path: String = key.get_value("InstallPath").ok()?;
    let dir = PathBuf::from(path);
    let exe = dir.join("Tailscale.exe");
    exe.is_file().then_some(exe)
}

/// Launch the Tailscale GUI at sign-in. Best-effort: missing install or a
/// non-zero exit are both ignored — we just want Tailscale coming up next to
/// Moonblast, the same way Explorer's Run key would have done. Skipped when
/// the user hasn't opted into Auto Tailscale Start in Settings.
fn launch_tailscale() {
    if !auto_tailscale_start_enabled() {
        return;
    }
    let Some(exe) = tailscale_install_path() else {
        return;
    };
    let _ = Command::new(exe)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

/// Read the user's `auto_tailscale_start` preference from `settings.json`.
/// Returns `false` if the file is missing or unparseable — a fresh install or
/// a corrupt file should never spawn Tailscale, only an explicit opt-in.
fn auto_tailscale_start_enabled() -> bool {
    let Some(path) = settings::config_file_path() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    // Just fish the one bool out of the file with a minimal hand-written
    // search — pulling in the whole Settings serde here would be overkill and
    // would force us to keep the stub's serde version in lockstep.
    text.lines()
        .find(|l| l.trim_start().starts_with("\"auto_tailscale_start\""))
        .and_then(|line| line.split(':').nth(1))
        .map(|v| v.trim().trim_end_matches(',').eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Stay alive as the session's shell process, restarting Explorer if it goes away.
///
/// Winlogon launches exactly one shell process per session; keeping this (tiny)
/// process around means that slot is never empty, whatever happens to Explorer.
fn park() -> ! {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        ensure_desktop();
    }
}

/// Entry point for `Moonblast.exe --shell`, i.e. what Winlogon actually runs.
///
/// Runs the launcher, and whatever happens to it — clean exit, crash, or the user
/// closing it — hands a working desktop back afterwards. Holding Shift at sign-in,
/// or three failed starts in a row, disables the takeover entirely.
pub fn run_shell_stub() -> ! {
    if shift_held() || crash_count() >= MAX_SHELL_CRASHES {
        let _ = set_replace_desktop(false);
        ensure_desktop();
        park();
    }
    // Counted as a failure up front; the launcher clears it once it has survived
    // `CRASH_RESET_SECS`, so only a fast crash loop ever trips the limit.
    bump_crash_count();
    // Bring Tailscale up alongside Moonblast. Winlogon replaced the shell, so
    // Explorer's Run keys never fire — including the one Tailscale's installer
    // adds. Spawning it ourselves restores that behavior for this one app.
    // No-op if Tailscale isn't installed.
    launch_tailscale();
    if let Ok(exe) = std::env::current_exe() {
        let _ = Command::new(exe)
            .arg(AUTOSTART_FLAG)
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    ensure_desktop();
    park();
}
