use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

mod display;
mod hdr;
mod logging;

/// Run a `Command` to completion with a hard deadline. Returns the captured
/// stdout on success. On timeout the child is killed and reaped; stdout is
/// lost. This is the cross-platform equivalent of `Command::output()` with
/// a timeout — `output()` itself doesn't take one, and a wedged child on a
/// blocking-pool task would otherwise sit forever, starving the pool.
///
/// Takes a closure that builds the Command so callers don't have to break
/// the `creation_flags(...).args(...)` chain. The closure must return the
/// Command by value (some builder methods return `&mut Command`).
fn run_with_timeout<F>(
    build: F,
    deadline: std::time::Duration,
) -> std::io::Result<std::process::Output>
where
    F: FnOnce() -> Command,
{
    let mut cmd = build();
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
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
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

/// Tracks live Moonlight stream child processes so we never spawn a duplicate
/// window for the same host+app while one is already running. The host-side
/// quit on disconnect is delegated to Moonlight QT's own CLI
/// (`moonlight quit <host>`), which handles cert pinning internally — see
/// the doc comment on `moonlight_quit`.
pub struct ActiveStream {
    child: Child,
}

pub struct StreamState(Mutex<HashMap<String, ActiveStream>>);

impl Default for StreamState {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

mod settings;
mod shell;
mod wifi;
mod audio;

pub use shell::run_shell_stub;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

/// Toggle the window between windowed and fullscreen. Returns the new state.
#[tauri::command]
fn toggle_fullscreen(window: tauri::Window) -> Result<bool, String> {
    let fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
    if !fullscreen && window.is_maximized().map_err(|e| e.to_string())? {
        // Frameless maximized windows keep an invisible resize border that can
        // leave a blank strip at the top when going fullscreen; unmaximize first.
        window.unmaximize().map_err(|e| e.to_string())?;
    }
    window.set_fullscreen(!fullscreen).map_err(|e| e.to_string())?;
    Ok(!fullscreen)
}

/// Returns whether the window is currently fullscreen.
#[tauri::command]
fn is_fullscreen(window: tauri::Window) -> Result<bool, String> {
    window.is_fullscreen().map_err(|e| e.to_string())
}

/// Minimize the window.
#[tauri::command]
fn minimize_window(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// Toggle maximize/restore. Returns the new maximized state.
#[tauri::command]
fn toggle_maximize(window: tauri::Window) -> Result<bool, String> {
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if maximized {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(!maximized)
}

/// Returns whether the window is currently maximized.
#[tauri::command]
fn is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

/// Reports real Tailscale state as one of: not-found, not-running, starting,
/// logged-out, connected, disconnected.
#[tauri::command]
async fn tailscale_status() -> TailscaleInfo {
    // Offload the subprocess wait off the main thread so the UI never freezes.
    // Bound the wait so a wedged tailscaled can't hold a blocking-pool slot
    // forever (Settings polls this every 3s).
    tauri::async_runtime::spawn_blocking(|| {
        let status = match run_with_timeout(
            || {
                let mut c = Command::new("tailscale");
                c.arg("status").creation_flags(0x0800_0000);
                c
            },
            std::time::Duration::from_secs(5),
        ) {
            Err(_) => "not-found".to_string(),
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                let lower = format!("{stdout}\n{stderr}").to_lowercase();

                // Daemon unreachable.
                if lower.contains("failed to connect to local tailscale daemon")
                    || lower.contains("is the tailscale service running")
                    || lower.contains("tailscaled process")
                    || lower.contains("connection refused")
                {
                    "not-running".to_string()
                // Connected (peer list / healthy), not logged out.
                } else if output.status.success()
                    && !lower.contains("logged out")
                    && !lower.contains("needs login")
                {
                    "connected".to_string()
                // Reachable but not signed in.
                } else if lower.contains("logged out") || lower.contains("needs login") {
                    "logged-out".to_string()
                // Warming up.
                } else if lower.contains("starting") || lower.contains("please wait") || lower.contains("health check") {
                    "starting".to_string()
                } else {
                    "disconnected".to_string()
                }
            }
        };
        TailscaleInfo { status }
    })
    .await
    .unwrap_or(TailscaleInfo { status: "not-found".to_string() })
}

/// Bring Tailscale up or down. Only meaningful when the daemon is running.
#[tauri::command]
async fn tailscale_set(up: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let arg = if up { "up" } else { "down" };
        let out = run_with_timeout(
            || {
                let mut c = Command::new("tailscale");
                c.arg(arg).creation_flags(0x0800_0000);
                c
            },
            std::time::Duration::from_secs(15),
        )
        .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let msg = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stderr),
                String::from_utf8_lossy(&out.stdout)
            );
            return Err(msg.trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct TailscaleInfo {
    status: String,
}

/// Returns true if the folder looks like a Moonlight install (contains moonlight.exe).
#[tauri::command]
fn validate_moonlight_dir(path: String) -> bool {
    let dir = std::path::Path::new(&path);
    ["moonlight.exe", "moonlight-qt.exe"]
        .iter()
        .any(|name| dir.join(name).is_file())
}

/// Resolve the Moonlight executable from the configured install folder.
fn moonlight_exe(state: &State<'_, settings::SettingsState>) -> Option<std::path::PathBuf> {
    let settings = state.0.lock().ok()?;
    let folder = settings.integrations.moonlight_folder.clone()?;
    for name in ["moonlight.exe", "moonlight-qt.exe"] {
        let p = std::path::Path::new(&folder).join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// List a host's apps via `moonlight list <host>`. Async so the subprocess wait
/// doesn't block the main thread / UI.
#[tauri::command]
async fn moonlight_list_apps(
    host: String,
    state: State<'_, settings::SettingsState>,
) -> Result<Vec<String>, String> {
    let exe = moonlight_exe(&state).ok_or("Moonlight executable not found")?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_with_timeout(
            || {
                let mut c = Command::new(&exe);
                c.args(["list", &host]);
                c
            },
            std::time::Duration::from_secs(10),
        )
        .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let msg = String::from_utf8_lossy(&out.stderr).into_owned();
            return Err(msg.trim().to_string());
        }
        let apps = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        Ok(apps)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Launch Moonlight's pairing flow for a host and notify when it completes.
#[tauri::command]
async fn moonlight_pair(
    app: tauri::AppHandle,
    host: String,
    state: State<'_, settings::SettingsState>,
) -> Result<(), String> {
    let exe = moonlight_exe(&state).ok_or("Moonlight executable not found")?;
    let child = Command::new(&exe)
        .args(["pair", &host])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| e.to_string())?;
    // Wait on a blocking task so the Tauri command thread isn't held for
    // the (potentially long) pairing session. The previous detached-thread
    // version called `wait_with_output()` with no timeout — a hung
    // moonlight.exe pair would leak a thread forever.
    //
    // Pairing is interactive: the user reads the PIN off Moonlight's dialog
    // and types it into the host. 10 minutes is comfortably longer than any
    // real pairing session.
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = child;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
        let success = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break false;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        };
        let _ = app.emit(
            "pair-complete",
            serde_json::json!({ "host": host, "success": success }),
        );
    });
    Ok(())
}

/// Resolve the leading integer from a value like "60 Hz" -> 60.
fn parse_fps(s: &str) -> Option<u32> {
    s.chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

/// Detect the client's current display resolution and refresh rate (Windows).
fn client_display_raw() -> Option<(u32, u32, Option<u32>)> {
    use windows_sys::Win32::Graphics::Gdi::{
        EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS,
    };
    let mut dm: DEVMODEW = unsafe { std::mem::zeroed() };
    dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
    let ok = unsafe { EnumDisplaySettingsW(std::ptr::null(), ENUM_CURRENT_SETTINGS, &mut dm) };
    if ok == 0 {
        return None;
    }
    let freq = if dm.dmDisplayFrequency > 0 {
        Some(dm.dmDisplayFrequency)
    } else {
        None
    };
    Some((dm.dmPelsWidth, dm.dmPelsHeight, freq))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientDisplay {
    width: u32,
    height: u32,
    refresh_rate: Option<u32>,
}

/// Report the client machine's native display resolution and refresh rate.
#[tauri::command]
fn client_display() -> Result<ClientDisplay, String> {
    match client_display_raw() {
        Some((width, height, refresh_rate)) => Ok(ClientDisplay {
            width,
            height,
            refresh_rate,
        }),
        None => Err("Could not read display info".to_string()),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppEntry {
    id: String,
    name: String,
    source: String, // "" | "Store" | "Steam"
    path: String,
    kind: String, // "exe" | "store" | "steam"
}

/// Walk a Start Menu directory, collecting `.lnk` shortcuts (source = "").
fn walk_programs(
    dir: &std::path::Path,
    out: &mut Vec<AppEntry>,
    seen: &mut std::collections::HashSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            walk_programs(&path, out, seen);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false)
        {
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if stem.is_empty() {
                continue;
            }
            let p = path.to_string_lossy().into_owned();
            if !seen.insert(p.clone()) {
                continue; // system + user menus may overlap
            }
            out.push(AppEntry {
                id: p.clone(),
                name: stem,
                source: String::new(),
                path: p,
                kind: "exe".to_string(),
            });
        }
    }
}

/// Tokenize a Valve VDF/ACF file. Braces are kept as structure markers so
/// (key, value) pairs align correctly (a key whose value is a block is `{`).
enum VTok {
    Str(String),
    Open,
    Close,
}

fn vdf_tokens(content: &str) -> Vec<VTok> {
    let b = content.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] as char {
            '"' => {
                i += 1;
                let mut s = String::new();
                while i < b.len() {
                    let ch = b[i] as char;
                    if ch == '"' {
                        i += 1;
                        break;
                    }
                    if ch == '\\' && i + 1 < b.len() {
                        let n = b[i + 1] as char;
                        if n == '"' || n == '\\' {
                            s.push(n);
                            i += 2;
                        } else {
                            s.push(ch);
                            i += 1;
                        }
                    } else {
                        s.push(ch);
                        i += 1;
                    }
                }
                toks.push(VTok::Str(s));
            }
            '{' => {
                toks.push(VTok::Open);
                i += 1;
            }
            '}' => {
                toks.push(VTok::Close);
                i += 1;
            }
            _ => i += 1,
        }
    }
    toks
}

fn parse_vdf_pairs(content: &str) -> Vec<(String, String)> {
    let toks = vdf_tokens(content);
    let mut pairs = Vec::new();
    for i in 0..toks.len().saturating_sub(1) {
        if let (VTok::Str(k), VTok::Str(v)) = (&toks[i], &toks[i + 1]) {
            pairs.push((k.clone(), v.clone()));
        }
    }
    pairs
}

/// Store (UWP) apps, via the built-in PowerShell `Get-StartApps`. We keep only
/// entries whose AppID is an AUMID (contains `!`), which identifies Store apps
/// (desktop items have plain paths/empty AppIDs).
fn discover_store_apps() -> Vec<AppEntry> {
    let mut out = Vec::new();
    let Ok(ps) = run_with_timeout(
        || {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-Command", "Get-StartApps | ConvertTo-Json -Compress"])
                .creation_flags(0x0800_0000); // CREATE_NO_WINDOW — don't flash a console
            c
        },
        std::time::Duration::from_secs(15),
    )
    else {
        return out;
    };
    if !ps.status.success() {
        return out;
    }
    let text = String::from_utf8_lossy(&ps.stdout);
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return out,
    };
    let arr = match json {
        serde_json::Value::Array(a) => a,
        v => vec![v],
    };
    for item in arr {
        let name = item.get("Name").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let appid = item.get("AppID").and_then(|s| s.as_str()).unwrap_or("").to_string();
        if name.is_empty() || !appid.contains('!') {
            continue;
        }
        out.push(AppEntry {
            id: format!("store:{appid}"),
            name,
            source: "Store".to_string(),
            path: appid,
            kind: "store".to_string(),
        });
    }
    out
}

/// Steam games, from the local Steam metadata (registry + `appmanifest_*.acf`).
/// Launched via `steam://rungameid/<appid>`; no game exe path required.
fn discover_steam_games() -> Vec<AppEntry> {
    let mut out = Vec::new();
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(steam) = hkcu.open_subkey(r"Software\Valve\Steam") else {
        return out;
    };
    let steam_path: String = match steam.get_value::<String, _>("SteamPath") {
        Ok(p) => p.replace('/', "\\"),
        Err(_) => return out,
    };

    let mut steamapps = vec![format!("{steam_path}\\steamapps")];
    let lf = format!("{steam_path}\\steamapps\\libraryfolders.vdf");
    if let Ok(content) = std::fs::read_to_string(&lf) {
        for (k, v) in parse_vdf_pairs(&content) {
            if k == "path" {
                steamapps.push(format!("{}\\steamapps", v.replace('/', "\\")));
            }
        }
    }

    let mut seen = std::collections::HashSet::new();
    for dir in steamapps {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().into_owned();
            if !fname.starts_with("appmanifest_") || !fname.ends_with(".acf") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&entry.path()) else {
                continue;
            };
            let mut appid = None;
            let mut name = None;
            for (k, v) in parse_vdf_pairs(&content) {
                if k == "appid" && appid.is_none() {
                    appid = Some(v);
                } else if k == "name" && name.is_none() {
                    name = Some(v);
                }
            }
            let (Some(appid), Some(name)) = (appid, name) else {
                continue;
            };
            if name.is_empty() {
                continue;
            }
            let key = format!("steam:{appid}");
            if !seen.insert(key.clone()) {
                continue;
            }
            out.push(AppEntry {
                id: key,
                name,
                source: "Steam".to_string(),
                path: appid,
                kind: "steam".to_string(),
            });
        }
    }
    out
}

/// Discover installed apps: Start Menu shortcuts + Store apps + Steam games.
#[tauri::command]
async fn discover_apps() -> Vec<AppEntry> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out: Vec<AppEntry> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut roots = Vec::new();
        if let Some(s) = std::env::var("PROGRAMDATA").ok() {
            roots.push(format!("{s}\\Microsoft\\Windows\\Start Menu\\Programs"));
        }
        if let Some(u) = std::env::var("APPDATA").ok() {
            roots.push(format!("{u}\\Microsoft\\Windows\\Start Menu\\Programs"));
        }
        for root in &roots {
            walk_programs(std::path::Path::new(root), &mut out, &mut seen);
        }
        out.extend(discover_store_apps());
        out.extend(discover_steam_games());
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out
    })
    .await
    .unwrap_or_default()
}

/// Open a target with the default shell action.
fn shell_open(target: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let mut op: Vec<u16> = "open".encode_utf16().collect();
    op.push(0);
    let mut pw: Vec<u16> = target.encode_utf16().collect();
    pw.push(0);
    let res = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            pw.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        ) as isize
    };
    if res > 32 {
        Ok(())
    } else {
        Err(format!("Failed to launch (error {res})"))
    }
}

/// COM vtable for `IApplicationActivationManager` (`2e941141-7f97-4756-ba1d-9decde894a3d`).
///
/// `windows-sys` ships the CLSID but not the interface (it binds no COM methods),
/// and the interface is small, so declare the slots we need by hand. Only layout
/// matters for the two trailing methods — they're never called.
#[repr(C)]
struct ApplicationActivationManagerVtbl {
    query_interface: unsafe extern "system" fn(
        *mut std::ffi::c_void,
        *const windows_sys::core::GUID,
        *mut *mut std::ffi::c_void,
    ) -> windows_sys::core::HRESULT,
    add_ref: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32,
    release: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32,
    activate_application: unsafe extern "system" fn(
        *mut std::ffi::c_void,
        *const u16,
        *const u16,
        u32,
        *mut u32,
    ) -> windows_sys::core::HRESULT,
    _activate_for_file: usize,
    _activate_for_protocol: usize,
}

/// Launch a Microsoft Store app by AUMID.
///
/// Deliberately *not* `explorer.exe shell:AppsFolder\<AUMID>`: when Moonblast has
/// replaced the desktop there is no shell running, and starting Explorer would
/// bring the taskbar and desktop up behind the launcher. `ActivateApplication` is
/// the API the shell itself uses and needs no Explorer.
fn activate_store_app(aumid: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use windows_sys::Win32::UI::Shell::ApplicationActivationManager;
    const IID_IAAM: windows_sys::core::GUID =
        windows_sys::core::GUID::from_u128(0x2e94_1141_7f97_4756_ba1d_9dec_de89_4a3d);

    let mut id: Vec<u16> = aumid.encode_utf16().collect();
    id.push(0);
    unsafe {
        // May report "already initialized" / "different mode" on a thread Tauri has
        // set up; either is fine — we just need COM live on this thread.
        let _ = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        let mut mgr: *mut std::ffi::c_void = std::ptr::null_mut();
        let hr = CoCreateInstance(
            &ApplicationActivationManager,
            std::ptr::null_mut(),
            CLSCTX_ALL,
            &IID_IAAM,
            &mut mgr,
        );
        if hr < 0 || mgr.is_null() {
            return Err(format!("ApplicationActivationManager unavailable (0x{hr:08X})"));
        }
        let vtbl = *(mgr as *mut *const ApplicationActivationManagerVtbl);
        let mut pid: u32 = 0;
        let hr = ((*vtbl).activate_application)(
            mgr,
            id.as_ptr(),
            std::ptr::null(),
            0, // AO_NONE
            &mut pid,
        );
        ((*vtbl).release)(mgr);
        if hr < 0 {
            return Err(format!("Failed to activate Store app (0x{hr:08X})"));
        }
    }
    Ok(())
}

/// Launch an app or shortcut. `kind` selects the launch method.
#[tauri::command]
fn launch_app(path: String, kind: String) -> Result<(), String> {
    match kind.as_str() {
        "store" => activate_store_app(&path).or_else(|e| {
            // Last resort: the AppsFolder namespace still works when a desktop is
            // already up, and a launched app beats a failed one.
            if shell::desktop_replaced() {
                return Err(e);
            }
            Command::new("explorer.exe")
                .arg(format!("shell:AppsFolder\\{path}"))
                .creation_flags(0x0800_0000)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }),
        "steam" => shell_open(&format!("steam://rungameid/{path}")),
        _ => shell_open(&path),
    }
}

/// Launch every `app_shortcuts` entry flagged with `auto_launch`. Used at sign-in
/// (when the launcher was started by the shell stub). Each launch is staggered
/// ~250 ms so multiple autolaunch apps don't all fight for focus. Failures on any
/// individual app are logged and skipped — one bad shortcut shouldn't block the
/// rest. Runs on `spawn_blocking` because `launch_app` can hit the registry / COM
/// paths; gating *when* this fires stays in the frontend (`is_autostart`).
#[tauri::command]
async fn launch_autolaunch_apps(
    state: State<'_, settings::SettingsState>,
) -> Result<usize, String> {
    // Snapshot the list under the lock so the loop doesn't hold it for the
    // whole launch sequence (which can span multiple seconds with stagger).
    let targets: Vec<(String, String)> = {
        let guard = state.0.lock().unwrap();
        guard
            .app_shortcuts
            .iter()
            .filter(|s| s.auto_launch)
            .map(|s| (s.path.clone(), s.kind.clone()))
            .collect()
    };
    moonblast_log!("launch_autolaunch_apps: {} flagged", targets.len());
    tauri::async_runtime::spawn_blocking(move || {
        let n = targets.len();
        for (i, (path, kind)) in targets.into_iter().enumerate() {
            if i > 0 {
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            moonblast_log!("launch_autolaunch_apps: launching [{}/{}] {} kind={}", i + 1, n, path, kind);
            if let Err(e) = launch_app(path.clone(), kind) {
                moonblast_log!("launch_autolaunch_apps: failed [{}] path={} err={}", i + 1, path, e);
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(0)
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Resolve a `.lnk` shortcut to its target path (to extract the icon without
/// Windows' shortcut-arrow overlay). Returns None for non-.lnk paths.
fn resolve_lnk_target(path: &str) -> Option<String> {
    let p = std::path::Path::new(path);
    if !p.extension().map(|e| e.eq_ignore_ascii_case("lnk")).unwrap_or(false) {
        return None;
    }
    let shell_link = lnk::ShellLink::open(path, lnk::encoding::WINDOWS_1252).ok()?;
    let target = shell_link.link_target()?;
    if target.trim().is_empty() { None } else { Some(target) }
}

/// Extract an app's icon (from its exe or .lnk) as raw PNG bytes.
fn extract_icon_png(path: &str) -> Option<Vec<u8>> {
    // For shortcuts, resolve the target so we don't include the arrow overlay.
    let icon_path = resolve_lnk_target(path).unwrap_or_else(|| path.to_string());
    (|| -> Option<Vec<u8>> {
        use windows_sys::Win32::Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        };
        use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW};
        use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL};

        const SIZE: i32 = 32;
        const SHGFI_ICON: u32 = 0x0000_0100;

        let mut wide: Vec<u16> = icon_path.encode_utf16().collect();
        wide.push(0);
        let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
        let got = unsafe {
            SHGetFileInfoW(
                wide.as_ptr(),
                0,
                &mut info as *mut SHFILEINFOW,
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON,
            )
        };
        if got == 0 || info.hIcon.is_null() {
            return None;
        }

        // Draw the icon into a 32bpp DIB so we can read its pixels.
        let dc = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
        if dc.is_null() {
            unsafe { DestroyIcon(info.hIcon) };
            return None;
        }
        let mut header: BITMAPINFOHEADER = unsafe { std::mem::zeroed() };
        header.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        header.biWidth = SIZE;
        header.biHeight = -SIZE; // top-down
        header.biPlanes = 1;
        header.biBitCount = 32;
        header.biCompression = BI_RGB;
        let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
        bmi.bmiHeader = header;
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let hbm = unsafe {
            CreateDIBSection(
                dc,
                &bmi,
                DIB_RGB_COLORS,
                &mut bits,
                std::ptr::null_mut(),
                0,
            )
        };
        if hbm.is_null() || bits.is_null() {
            unsafe {
                DeleteDC(dc);
                DestroyIcon(info.hIcon);
            }
            return None;
        }
        let old = unsafe { SelectObject(dc, hbm) };
        unsafe { DrawIconEx(dc, 0, 0, info.hIcon, SIZE, SIZE, 0, std::ptr::null_mut(), DI_NORMAL) };

        // Copy pixels while the DIBSection is still alive (bits are freed on DeleteObject).
        let n = (SIZE * SIZE * 4) as usize;
        let raw = unsafe { std::slice::from_raw_parts(bits as *const u8, n) };
        let mut rgba = Vec::with_capacity(n);
        for px in raw.chunks_exact(4) {
            rgba.push(px[2]); // R
            rgba.push(px[1]); // G
            rgba.push(px[0]); // B
            rgba.push(px[3]); // A
        }

        unsafe {
            SelectObject(dc, old);
            DeleteObject(hbm);
            DeleteDC(dc);
            DestroyIcon(info.hIcon);
        }

        let img = image::RgbaImage::from_raw(SIZE as u32, SIZE as u32, rgba)?;
        let mut out = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .ok()?;
        Some(out)
    })()
}

fn png_data_uri(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
    )
}

/// Download an image (SteamGridDB icon) into memory (capped at ~3MB).
fn download_image(url: &str) -> Result<Vec<u8>, String> {
    let mut reader = ureq::get(url)
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| e.to_string())?
        .into_reader();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    while buf.len() < 3_000_000 {
        let n = std::io::Read::read(&mut reader, &mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(buf)
}

/// `.icons` cache directory under the app data dir (Local AppData), co-located
/// with `settings.json` so all Moonblast persistent data lives in one folder.
fn icon_cache_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join(".icons");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// Stable cache file for a given key (app path or icon URL). Same key always
/// maps to the same file, so offline reloads hit disk instead of re-extracting.
fn icon_cache_file(app: &tauri::AppHandle, key: &str) -> Option<PathBuf> {
    let mut h = DefaultHasher::new();
    key.hash(&mut h);
    Some(icon_cache_dir(app)?.join(format!("{:016x}.png", h.finish())))
}

/// Look up a SteamGridDB icon URL for an app by name (API v2).
fn steamgrid_icon_url(name: &str, key: &str) -> Option<String> {
    let search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        urlencode(name)
    );
    let body: serde_json::Value = ureq::get(&search_url)
        .set("Authorization", &format!("Bearer {key}"))
        .timeout(std::time::Duration::from_secs(8))
        .call()
        .ok()?
        .into_string()
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())?;
    let id = body["data"][0]["id"].as_i64()?;
    let icons_url = format!("https://www.steamgriddb.com/api/v2/icons/game/{id}");
    let body2: serde_json::Value = ureq::get(&icons_url)
        .set("Authorization", &format!("Bearer {key}"))
        .timeout(std::time::Duration::from_secs(8))
        .call()
        .ok()?
        .into_string()
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())?;
    body2["data"][0]["url"].as_str().map(|s| s.to_string())
}

/// Validate a SteamGridDB API key with a lightweight request.
#[tauri::command]
async fn check_steamgrid_key(key: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = format!(
            "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
            urlencode("test")
        );
        let out = match ureq::get(&url)
            .set("Authorization", &format!("Bearer {key}"))
            .timeout(std::time::Duration::from_secs(10))
            .call()
        {
            Ok(resp) => {
                if resp.status() == 200 {
                    "valid".to_string()
                } else {
                    "invalid".to_string()
                }
            }
            Err(ureq::Error::Status(401, _)) => "invalid".to_string(),
            Err(_) => "error".to_string(),
        };
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SgTitle {
    id: i64,
    name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SgIcon {
    id: i64,
    url: String,
}

fn extract_titles(v: &serde_json::Value) -> Vec<SgTitle> {
    let mut out = Vec::new();
    let push = |o: &serde_json::Value, out: &mut Vec<SgTitle>| {
        if let (Some(id), Some(name)) = (o.get("id").and_then(|x| x.as_i64()), o.get("name").and_then(|x| x.as_str())) {
            out.push(SgTitle { id, name: name.to_string() });
        }
    };
    if let Some(arr) = v["data"].as_array() {
        for el in arr {
            push(el, &mut out);
        }
    } else {
        push(&v["data"], &mut out);
    }
    out
}

/// Search SteamGridDB for a game by name, or by id via `id::<steam_appid>`.
#[tauri::command]
async fn steamgrid_search(
    query: String,
    state: State<'_, settings::SettingsState>,
) -> Result<Vec<SgTitle>, String> {
    let key = state
        .0
        .lock()
        .unwrap()
        .integrations
        .steamgrid_key
        .clone()
        .unwrap_or_default();
    if key.trim().is_empty() {
        return Err("Set a SteamGridDB API key in Settings → Integrations first.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let url = format!(
            "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
            urlencode(q)
        );
        let body: serde_json::Value = ureq::get(&url)
            .set("Authorization", &format!("Bearer {key}"))
            .timeout(std::time::Duration::from_secs(10))
            .call()
            .map_err(|e| e.to_string())?
            .into_string()
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string()))?;
        Ok(extract_titles(&body))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch icon images available for a SteamGridDB game.
#[tauri::command]
async fn steamgrid_icons(
    game_id: i64,
    state: State<'_, settings::SettingsState>,
) -> Result<Vec<SgIcon>, String> {
    let key = state
        .0
        .lock()
        .unwrap()
        .integrations
        .steamgrid_key
        .clone()
        .unwrap_or_default();
    if key.trim().is_empty() {
        return Err("Set a SteamGridDB API key in Settings → Integrations first.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let url = format!("https://www.steamgriddb.com/api/v2/icons/game/{game_id}");
        let body: serde_json::Value = ureq::get(&url)
            .set("Authorization", &format!("Bearer {key}"))
            .timeout(std::time::Duration::from_secs(10))
            .call()
            .map_err(|e| e.to_string())?
            .into_string()
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string()))?;
        let arr = body["data"].as_array().cloned().unwrap_or_default();
        Ok(arr
            .iter()
            .filter_map(|v| {
                Some(SgIcon {
                    id: v["id"].as_i64()?,
                    url: v["url"].as_str()?.to_string(),
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolve an app icon, persisted to the `.icons` cache.
///
/// Order: SteamGridDB by name (if a key is configured) → extracted desktop
/// icon. The result is written to disk (keyed by app path) so later loads —
/// and all offline sessions — serve straight from cache instead of re-extracting
/// or re-hitting the network.
#[tauri::command]
async fn app_icon(
    app: tauri::AppHandle,
    path: String,
    name: String,
    force_desktop: bool,
    state: State<'_, settings::SettingsState>,
) -> Result<Option<String>, String> {
    let key = state
        .0
        .lock()
        .unwrap()
        .integrations
        .steamgrid_key
        .clone()
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let cache = icon_cache_file(&app, &path);
        // Serve from cache if present (fast + offline).
        if let Some(cf) = &cache {
            if cf.exists() {
                if let Ok(bytes) = std::fs::read(cf) {
                    return Ok(Some(png_data_uri(&bytes)));
                }
            }
        }
        // Resolve fresh, network-first then extraction.
        let mut img: Option<Vec<u8>> = None;
        if !force_desktop && !key.is_empty() && !name.trim().is_empty() {
            if let Some(url) = steamgrid_icon_url(&name, &key) {
                img = download_image(&url).ok();
            }
        }
        if img.is_none() {
            img = extract_icon_png(&path);
        }
        if let Some(bytes) = &img {
            if let Some(cf) = &cache {
                let _ = std::fs::write(cf, bytes);
            }
            return Ok(Some(png_data_uri(bytes)));
        }
        Ok(None)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Persist a SteamGridDB icon URL to the `.icons` cache and return the local
/// path (so it works offline). Idempotent for already-local paths.
#[tauri::command]
async fn cache_steamgrid_icon(
    app: tauri::AppHandle,
    url: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !url.starts_with("http") {
            return Ok(Some(url));
        }
        let Some(cf) = icon_cache_file(&app, &url) else {
            return Ok(None);
        };
        let bytes = download_image(&url)?;
        std::fs::write(&cf, &bytes).map_err(|e| e.to_string())?;
        Ok(Some(cf.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy a custom image into the `.icons` cache and return the local path, so
/// the original file moving/renaming no longer breaks the icon.
#[tauri::command]
async fn import_app_icon(app: tauri::AppHandle, src: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Already cached → return as-is (idempotent).
        if let Some(dir) = icon_cache_dir(&app) {
            let canon = std::fs::canonicalize(&src).unwrap_or_else(|_| PathBuf::from(&src));
            if canon.starts_with(&dir) {
                return Ok(Some(src));
            }
        }
        let ext = std::path::Path::new(&src)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png");
        let mut h = DefaultHasher::new();
        src.hash(&mut h);
        let Some(dir) = icon_cache_dir(&app) else {
            return Ok(None);
        };
        let cf = dir.join(format!("custom_{:016x}.{}", h.finish(), ext));
        std::fs::copy(&src, &cf).map_err(|e| e.to_string())?;
        Ok(Some(cf.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove a specific app's cached icon so "Use Desktop Icon" can re-extract.
#[tauri::command]
async fn clear_cached_icon(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if let Some(cf) = icon_cache_file(&app, &path) {
        let _ = std::fs::remove_file(&cf);
    }
    Ok(())
}

/// Classify clipboard content for the "Copy From Clipboard" icon action.
/// Returns `"image"` | `"url"` | `"base64"` | `"text"` | `"none"` so the UI can
/// gray the action out when there is nothing usable (empty / binary-only /
/// files), as requested.
#[tauri::command]
async fn clipboard_icon_hint() -> Result<String, String> {
    Ok(tauri::async_runtime::spawn_blocking(clipboard_icon_hint_sync)
        .await
        .map_err(|e| e.to_string())?)
}

fn clipboard_icon_hint_sync() -> String {
    let Ok(mut cb) = arboard::Clipboard::new() else {
        return "none".into();
    };
    // An actual image in the clipboard is the most specific/valuable case.
    if cb.get_image().is_ok() {
        return "image".into();
    }
    let Ok(text) = cb.get_text() else {
        return "none".into();
    };
    let text = text.trim();
    if text.is_empty() {
        return "none".into();
    }
    if text.starts_with("data:image/")
        || (text.len() >= 32 && looks_like_base64_image(text))
    {
        return "base64".into();
    }
    if text.starts_with("http://") || text.starts_with("https://") {
        return "url".into();
    }
    "text".into() // plain text: still enabled per UX; apply will reject it.
}

/// Pull an image out of the clipboard (image data, https URL, `data:` URI, or
/// raw base64), transcode it to PNG, and stash it in the `.icons` cache.
/// Returns the local cache path — the same shape as `import_app_icon` — so it
/// becomes a normal `custom_icon`.
#[tauri::command]
async fn clipboard_icon_import(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cb = arboard::Clipboard::new()
            .map_err(|e| format!("cannot open clipboard: {e}"))?;

        // 1) Real image data (copied from a browser/screenshot tool) → PNG.
        if let Ok(img) = cb.get_image() {
            let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())
                .ok_or("clipboard image has invalid dimensions")?;
            let mut png = Vec::new();
            image::DynamicImage::ImageRgba8(rgba)
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .map_err(|e| format!("cannot encode clipboard image: {e}"))?;
            return save_clipboard_icon(&app, &png);
        }

        // 2) Text: https URL, `data:image/...;base64,....`, or raw base64.
        let text = cb
            .get_text()
            .map_err(|_| "clipboard contains neither an image nor usable text".to_string())?
            .trim()
            .to_string();
        if text.is_empty() {
            return Err("clipboard is empty".into());
        }
        let raw = if let Some(rest) = text.strip_prefix("data:image/") {
            let b64 = rest.split_once(',').map(|(_, b)| b).unwrap_or(rest);
            decode_base64(&b64)?
        } else if text.starts_with("http://") || text.starts_with("https://") {
            download_image(&text)?
        } else {
            decode_base64(&text)?
        };
        let png = to_png_bytes(&raw)?;
        save_clipboard_icon(&app, &png)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Re-encode arbitrary image bytes (png/jpeg/webp/gif/bmp/ico/…) as PNG.
fn to_png_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img =
        image::load_from_memory(bytes).map_err(|_| "clipboard contents are not a valid image".to_string())?;
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("cannot encode PNG: {e}"))?;
    Ok(out)
}

fn save_clipboard_icon(app: &tauri::AppHandle, bytes: &[u8]) -> Result<Option<String>, String> {
    let Some(dir) = icon_cache_dir(app) else {
        return Ok(None);
    };
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    let cf = dir.join(format!("clipboard_{:016x}.png", h.finish()));
    std::fs::write(&cf, bytes).map_err(|e| format!("cannot write icon: {e}"))?;
    Ok(Some(cf.to_string_lossy().to_string()))
}

fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let clean: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.is_empty() {
        return Err("clipboard text is not valid base64".into());
    }
    // Tolerate missing padding — copied base64 often drops trailing '='.
    let mut padded = clean.clone();
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    base64::engine::general_purpose::STANDARD
        .decode(&padded)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(&padded))
        .map_err(|_| "clipboard text is not valid base64".to_string())
}

fn looks_like_base64_image(s: &str) -> bool {
    if s.chars().any(|c| {
        !(c.is_ascii_alphanumeric() || "+/=-_".contains(c) || c.is_whitespace())
    }) {
        return false; // not pure base64 alphabet
    }
    match decode_base64(s) {
        Ok(bytes) if bytes.len() >= 16 => is_image_bytes(&bytes),
        _ => false,
    }
}

fn is_image_bytes(b: &[u8]) -> bool {
    b.starts_with(b"\x89PNG")
        || b.starts_with(b"\xFF\xD8") // JPEG
        || b.starts_with(b"GIF8")
        || (b.len() > 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP")
        || b.starts_with(b"BM") // BMP
        || (b.len() > 6 && b[0] == 0 && b[1] == 0 && b[2] == 1 && b[3] == 0) // ICO
}

/// Build the `moonlight stream` CLI flags from the stored streaming prefs.
fn moonlight_flags(prefs: &settings::MoonlightStreaming) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();

    // Resolution: normalize legacy "1920×1080" unicode x; "auto" = detected.
    let resolution = if prefs.resolution.trim().is_empty()
        || prefs.resolution.eq_ignore_ascii_case("auto")
    {
        client_display_raw()
            .map(|(w, h, _)| format!("{w}x{h}"))
            .unwrap_or_default()
    } else {
        prefs.resolution.replace('×', "x")
    };
    if !resolution.is_empty() {
        v.push("--resolution".to_string());
        v.push(resolution);
    }

    // FPS derived from refresh_rate; "auto" = detected refresh.
    let fps = if prefs.refresh_rate.trim().is_empty()
        || prefs.refresh_rate.eq_ignore_ascii_case("auto")
    {
        client_display_raw().and_then(|(_, _, f)| f)
    } else {
        parse_fps(&prefs.refresh_rate)
    };
    if let Some(fps) = fps {
        v.push("--fps".to_string());
        v.push(fps.to_string());
    }

    // Bitrate in Mbps -> Kbps (Moonlight expects Kbps).
    if prefs.bitrate > 0.0 {
        v.push("--bitrate".to_string());
        v.push((prefs.bitrate * 1000.0).to_string());
    }

    // Choice options.
    let mut push_choice = |arg: &str, value: &str| {
        v.push(arg.to_string());
        v.push(value.to_string());
    };
    match prefs.codec.to_lowercase().as_str() {
        "h.264" => push_choice("--video-codec", "H.264"),
        "hevc" => push_choice("--video-codec", "HEVC"),
        "av1" => push_choice("--video-codec", "AV1"),
        _ => {}
    }
    match prefs.video_decoder.to_lowercase().as_str() {
        "software" => push_choice("--video-decoder", "software"),
        "hardware" => push_choice("--video-decoder", "hardware"),
        _ => {}
    }
    let mode = prefs.display_mode.to_lowercase();
    if !mode.is_empty() {
        match mode.as_str() {
            "windowed" => push_choice("--display-mode", "windowed"),
            "borderless" => push_choice("--display-mode", "borderless"),
            _ => push_choice("--display-mode", "fullscreen"),
        }
    }
    let audio = prefs.audio_config.to_lowercase();
    if !audio.is_empty() {
        match audio.as_str() {
            "5.1-surround" => push_choice("--audio-config", "5.1-surround"),
            "7.1-surround" => push_choice("--audio-config", "7.1-surround"),
            _ => push_choice("--audio-config", "stereo"),
        }
    }
    match prefs.capture_system_keys.to_lowercase().as_str() {
        "fullscreen" => push_choice("--capture-system-keys", "fullscreen"),
        "always" => push_choice("--capture-system-keys", "always"),
        _ => {}
    }

    // Boolean toggles: always pass --name / --no-name (the last one wins).
    let push_toggle = |v: &mut Vec<String>, name: &str, enabled: bool| {
        if enabled {
            v.push(format!("--{name}"));
        } else {
            v.push(format!("--no-{name}"));
        }
    };
    push_toggle(&mut v, "vsync", prefs.vsync);
    push_toggle(&mut v, "hdr", prefs.hdr);
    push_toggle(&mut v, "yuv444", prefs.yuv444);
    push_toggle(&mut v, "frame-pacing", prefs.frame_pacing);
    push_toggle(&mut v, "keep-awake", prefs.keep_awake);
    push_toggle(&mut v, "quit-after", prefs.quit_after);
    push_toggle(&mut v, "game-optimization", prefs.game_optimization);
    push_toggle(&mut v, "audio-on-host", prefs.audio_on_host);
    push_toggle(&mut v, "mute-on-focus-loss", prefs.mute_on_focus_loss);
    push_toggle(&mut v, "multi-controller", prefs.multi_controller);
    push_toggle(&mut v, "background-gamepad", prefs.background_gamepad);
    push_toggle(&mut v, "swap-gamepad-buttons", prefs.swap_gamepad_buttons);
    push_toggle(&mut v, "absolute-mouse", prefs.absolute_mouse);
    push_toggle(&mut v, "mouse-buttons-swap", prefs.mouse_buttons_swap);
    push_toggle(&mut v, "reverse-scroll-direction", prefs.reverse_scroll_direction);
    // fps_overlay maps to Moonlight's performance overlay.
    push_toggle(&mut v, "performance-overlay", prefs.fps_overlay);

    // Optional packet size.
    if let Some(p) = prefs.packet_size {
        v.push("--packet-size".to_string());
        v.push(p.to_string());
    }

    v
}

/// True if `pid` owns any visible top-level window. The Moonlight process can
/// outlive its UI in two ways: a few moments after the user closes the
/// window (process is finishing cleanup but `try_wait` still says alive), or
/// longer if the connection was lost and the client hangs in a non-UI state.
/// Either way, "no visible window" is a stronger signal that the stream is
/// gone than `try_wait` alone, and lets us re-spawn a fresh stream instead of
/// refusing the user.
fn pid_has_visible_window(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{BOOL, HWND};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible};
    let found = false;
    unsafe extern "system" fn cb(hwnd: HWND, lparam: isize) -> BOOL {
        let blob = &mut *(lparam as *mut (u32, bool));
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut owner_pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut owner_pid);
        if owner_pid == blob.0 {
            blob.1 = true;
            return 0; // abort the enum — we have our answer
        }
        1
    }
    let mut blob = (pid, found);
    unsafe {
        EnumWindows(Some(cb), (&mut blob as *mut (u32, bool)) as isize);
    }
    blob.1
}

/// Launch a stream for a host + app via `moonlight stream <host> <app>`.
/// Returns `true` if a new stream was launched, or `false` if one for this
/// host+app is already running (no duplicate window).
#[tauri::command]
fn moonlight_stream(
    host: String,
    app: String,
    state: State<'_, settings::SettingsState>,
    streams: State<'_, StreamState>,
) -> Result<bool, String> {
    moonblast_log!("moonlight_stream: start (host={host}, app={app})");
    let exe = moonlight_exe(&state).ok_or_else(|| {
        moonblast_log!("moonlight_stream: error: Moonlight executable not found");
        "Moonlight executable not found".to_string()
    })?;
    let prefs = state.0.lock().unwrap().moonlight.clone();
    let key = format!("{host}\u{1f}{app}");
    let mut map = streams.0.lock().unwrap();
    // Three states for an existing entry:
    //   - process exited cleanly → reap and respawn
    //   - process alive AND owns a visible top-level window → truly streaming,
    //     refuse the duplicate
    //   - process alive but no visible window (connection lost, window closed,
    //     stuck cleanup thread) → user-visible stream is gone, allow respawn.
    // The third case used to false-positive: `try_wait` said alive, we
    // blocked the user from starting a fresh stream.
    let already_running = match map.get_mut(&key) {
        Some(active) => match active.child.try_wait() {
            Ok(None) => {
                let pid = active.child.id();
                // Prior child is alive but may not own a visible window
                // (connection lost, user closed it, stuck cleanup thread).
                // If it does have a window, treat as already-running and
                // bail. Otherwise, kill the orphan and fall through to
                // spawn a fresh one — otherwise `map.insert` later would
                // silently overwrite and drop the prior `Child` without
                // killing it, leaving a moonlight.exe running invisibly.
                if pid_has_visible_window(pid) {
                    moonblast_log!(
                        "moonlight_stream: refusing duplicate (pid={pid} has visible window)"
                    );
                    true
                } else {
                    moonblast_log!(
                        "moonlight_stream: prior child pid={pid} alive but windowless, killing"
                    );
                    let _ = active.child.kill();
                    let _ = active.child.wait();
                    map.remove(&key);
                    false
                }
            }
            Ok(Some(status)) => {
                moonblast_log!(
                    "moonlight_stream: prior entry was already exited ({status:?}), respawning"
                );
                map.remove(&key);
                false
            }
            Err(e) => {
                moonblast_log!("moonlight_stream: try_wait error: {e}, treating as not-running");
                false
            }
        },
        None => false,
    };
    if already_running {
        return Ok(false);
    }

    let mut args = vec!["stream".to_string(), host.clone(), app.clone()];
    args.extend(moonlight_flags(&prefs));

    let child = Command::new(&exe)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            moonblast_log!("moonlight_stream: spawn error: {e}");
            e.to_string()
        })?;
    let pid = child.id();
    map.insert(key, ActiveStream { child });
    moonblast_log!("moonlight_stream: spawned child pid={pid}");
    Ok(true)
}

/// Tell the host to stop its currently-running app, then kill the local
/// streaming window Moonblast launched. The host-side quit is delegated to
/// Moonlight QT's own CLI (`moonlight quit <host>`, which internally calls
/// `NvHTTP::quitApp()`); the CLI handles Sunshine's pinned cert for us. We
/// run it on a dedicated thread with `CREATE_NO_WINDOW` (no Qt dialog
/// flash) and an 8 s bounded wait, in parallel with a local
/// `Child::kill` + `bounded_wait(5s)` on moonlight.exe — so the IPC
/// returns immediately regardless of CLI or child teardown latency.
#[tauri::command]
fn moonlight_quit(
    host: String,
    app: String,
    streams: State<'_, StreamState>,
    state: State<'_, settings::SettingsState>,
) -> Result<(), String> {
    let key = format!("{host}\u{1f}{app}");
    moonblast_log!("moonlight_quit: start (host={host}, app={app}, key={key})");
    // Pop the entry from the map FIRST so a second `moonlight_quit` /
    // `moonlight_stream` call against the same key can proceed immediately
    // instead of blocking on the mutex while moonlight.exe exits (Qt +
    // WebRTC teardown takes 1-5 s on its own).
    let active = streams.0.lock().unwrap().remove(&key);
    moonblast_log!(
        "moonlight_quit: stream entry {}",
        if active.is_some() { "found" } else { "absent" }
    );

    // Fire the host-side quit on a dedicated thread so it doesn't block the
    // IPC. The thread runs `moonlight quit <host>` with CREATE_NO_WINDOW
    // (so no Qt dialog flashes) and bounds its own wait to 8 s.
    if let Some(exe) = moonlight_exe(&state) {
        let host_for_thread = host.clone();
        std::thread::spawn(move || {
            moonblast_log!("moonlight quit: spawning CLI");
            let mut child = match Command::new(&exe)
                .args(["quit", &host_for_thread])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x0800_0000)
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    moonblast_log!("moonlight quit: spawn error: {e}");
                    return;
                }
            };
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        moonblast_log!("moonlight quit: CLI exited ({status:?})");
                        return;
                    }
                    Ok(None) => {
                        if std::time::Instant::now() >= deadline {
                            moonblast_log!("moonlight quit: CLI timed out, killing");
                            let _ = child.kill();
                            let final_until = std::time::Instant::now()
                                + std::time::Duration::from_secs(2);
                            while std::time::Instant::now() < final_until {
                                if let Ok(Some(_)) = child.try_wait() {
                                    return;
                                }
                                std::thread::sleep(std::time::Duration::from_millis(50));
                            }
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(e) => {
                        moonblast_log!("moonlight quit: wait error: {e}");
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                }
            }
        });
    } else {
        moonblast_log!("moonlight_quit: Moonlight executable not found, skipping host quit");
    }

    // Kill the local streaming window immediately. The host-side quit
    // runs in parallel on its own thread.
    if let Some(mut active) = active {
        let pid = active.child.id();
        moonblast_log!("moonlight_quit: killing child pid={pid}");
        let _ = active.child.kill();
        bounded_wait(&mut active.child, std::time::Duration::from_secs(5));
        match active.child.try_wait() {
            Ok(Some(status)) => moonblast_log!(
                "moonlight_quit: child reaped (status={:?})",
                status
            ),
            Ok(None) => moonblast_log!("moonlight_quit: child still unreaped after bounded_wait"),
            Err(e) => moonblast_log!("moonlight_quit: try_wait error: {e}"),
        }
    }
    moonblast_log!("moonlight_quit: done");
    Ok(())
}

/// Poll `try_wait` until the child exits or the deadline elapses. On
/// timeout, sends a second `kill()` (in case anything survived the first
/// one) and waits briefly for the OS to reap. Mirrors the polling pattern
/// in `run_with_timeout` but without the captured-output plumbing (we
/// don't need stdout/stderr here).
///
/// After this returns the `Child` may still hold an unreaped zombie if
/// the OS is uncooperative, but Rust's `Drop` for `Child` will issue a
/// non-blocking final `wait()` so it won't leak past command return.
fn bounded_wait(child: &mut std::process::Child, deadline: std::time::Duration) {
    let until = std::time::Instant::now() + deadline;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                if std::time::Instant::now() >= until {
                    let _ = child.kill();
                    // Final wait, also bounded — if this hangs, the Drop
                    // impl on Child is our last line of defense.
                    let final_until = std::time::Instant::now()
                        + std::time::Duration::from_secs(2);
                    while std::time::Instant::now() < final_until {
                        if let Ok(Some(_)) = child.try_wait() {
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => return,
        }
    }
}

/// Discover Sunshine/GameStream hosts on the LAN via mDNS, and classify each as
/// paired or not by probing with `moonlight listapps`.
///
/// Async + spawn_blocking so the 3s mDNS browse and the per-host probe timeouts
/// don't block the main thread (which previously froze the whole UI during Scan).
#[tauri::command]
async fn discover_hosts(state: State<'_, settings::SettingsState>) -> Result<Vec<DiscoveredHost>, String> {
    let exe = moonlight_exe(&state);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        use mdns_sd::{ServiceDaemon, ServiceEvent};
        use std::collections::HashMap;
        use std::time::{Duration, Instant};

        let mut hosts: HashMap<String, (String, String)> = HashMap::new();

        if let Ok(mdns) = ServiceDaemon::new() {
            if let Ok(receiver) = mdns.browse("_nvstream._tcp.local.") {
                let deadline = Instant::now() + Duration::from_secs(3);
                while Instant::now() < deadline {
                    match receiver.recv_timeout(Duration::from_millis(200)) {
                        Ok(ServiceEvent::ServiceResolved(info)) => {
                            let hostname = info.get_hostname();
                            let address = info
                                .get_addresses()
                                .iter()
                                .next()
                                .map(|a| a.to_string())
                                .unwrap_or_default();
                            if !address.is_empty() {
                                let name = hostname.split('.').next().unwrap_or(&hostname).to_string();
                                hosts.insert(hostname.to_string(), (name, address));
                            }
                        }
                        _ => {}
                    }
                }
            }
            drop(mdns);
        }

        let mut out = Vec::new();
        for (hostname, (name, address)) in hosts {
            let paired = match &exe {
                Some(exe) => probe_listapps(exe, &address),
                None => false,
            };
            out.push(DiscoveredHost {
                hostname,
                name,
                address,
                paired,
            });
        }
        out
    })
    .await
    .map_err(|e| e.to_string())?)
}

#[derive(serde::Serialize)]
struct DiscoveredHost {
    hostname: String,
    name: String,
    address: String,
    paired: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PairedHost {
    name: String,
    uuid: String,
    address: String,
    /// HTTP port the host's GameStream server listens on. Stored per-host in
    /// Moonlight's QSettings store as `localport` / `manualport` (default
    /// `47989` if absent — that's what `NvComputer`'s constructor uses for
    /// missing port values, and the default GameStream/Sunshine port).
    #[serde(default = "default_paired_port")]
    port: u16,
}

fn default_paired_port() -> u16 {
    47989
}

/// Read hosts already paired with the Moonlight client.
///
/// moonlight-qt persists known hosts in its QSettings store — the Windows
/// registry (`HKCU\Software\Moonlight Game Streaming Project\Moonlight\hosts\*`)
/// for normal installs, or a `Moonlight.conf` INI next to the exe in portable
/// mode. There is no CLI command that lists pairings, so we read the store
/// directly. A host is paired if it holds a pinned server certificate (`srvcert`).
#[tauri::command]
async fn moonlight_paired_hosts(
    state: State<'_, settings::SettingsState>,
) -> Result<Vec<PairedHost>, String> {
    let exe = moonlight_exe(&state);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        // Portable installs keep the QSettings store as an INI next to the exe.
        let portable_ini = exe.as_deref().and_then(|p| {
            p.parent().and_then(|dir| {
                if dir.join("portable.dat").exists() {
                    std::fs::read_to_string(dir.join("Moonlight.conf")).ok()
                } else {
                    None
                }
            })
        });

        let mut out = Vec::new();
        if let Some(ini) = portable_ini {
            out.extend(parse_moonlight_ini_hosts(&ini));
        } else {
            out.extend(read_registry_paired_hosts());
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out
    })
    .await
    .map_err(|e| e.to_string())?)
}

/// Forget a Moonlight pairing by removing its entry from Moonlight's own
/// QSettings store. Looks up the entry by address (either the registry
/// `HKCU\Software\Moonlight Game Streaming Project\Moonlight\hosts\<id>`
/// subkey on a normal install, or the matching `[hosts\<uuid>]` section in
/// `Moonlight.conf` on a portable install) and deletes it. After this the
/// host's `srvcert` is gone, so the next `moonlight list <host>` will
/// report it as unpaired and the UI's `pairedGroup` re-evaluates.
///
/// No-op when no matching entry exists — forgetting something not in the
/// store is fine, the caller's intent is already satisfied.
///
/// We don't use `moonlight`'s CLI for this: there is no `unpair` /
/// `forget` subcommand. Direct registry/INI mutation is the only path,
/// and it matches what Moonlight's own GUI does via Qt's QSettings.
#[tauri::command]
async fn moonlight_forget(
    host: String,
    state: State<'_, settings::SettingsState>,
) -> Result<(), String> {
    let exe = moonlight_exe(&state);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = exe.as_deref() {
            if let Some(dir) = p.parent() {
                if dir.join("portable.dat").exists() {
                    forget_ini_host(dir, &host);
                    return;
                }
            }
        }
        forget_registry_host(&host);
    })
    .await
    .map_err(|e| e.to_string())?)
}

/// Find the `[hosts\<uuid>]` section whose `localaddress`/`manualaddress`
/// matches `host` and remove every line from that section header through
/// the next section header (or end of file). Preserves the rest of the
/// INI verbatim — we only delete our own matched section.
fn forget_ini_host(dir: &std::path::Path, host: &str) {
    let path = dir.join("Moonlight.conf");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let host_lower = host.to_lowercase();
    let lines: Vec<&str> = text.lines().collect();
    // Walk sections once, finding a host section whose address matches.
    let mut drop_start: Option<usize> = None;
    let mut drop_end: Option<usize> = None;
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let section = &trimmed[1..trimmed.len() - 1];
            if section.starts_with(r"hosts\") && !section.starts_with(r"hostsbackup\") {
                // Find the section's end.
                let mut j = i + 1;
                while j < lines.len() {
                    let t = lines[j].trim();
                    if t.starts_with('[') && t.ends_with(']') {
                        break;
                    }
                    j += 1;
                }
                if section_matches_address_host(&lines[i + 1..j], &host_lower) {
                    drop_start = Some(i);
                    drop_end = Some(j);
                    break;
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
    let (Some(start), Some(end)) = (drop_start, drop_end) else {
        return;
    };
    // Stitch: everything before `start` + everything from `end` onward.
    let mut out = String::with_capacity(text.len());
    for line in &lines[..start] {
        out.push_str(line);
        out.push('\n');
    }
    for line in &lines[end..] {
        out.push_str(line);
        out.push('\n');
    }
    let _ = std::fs::write(&path, out);
}

/// True if any line in this section is `localaddress=<host>` or
/// `manualaddress=<host>` (case-insensitive).
fn section_matches_address_host(section_lines: &[&str], host_lower: &str) -> bool {
    for line in section_lines {
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim();
            if key == "localaddress" || key == "manualaddress" {
                if v.trim().to_lowercase() == host_lower {
                    return true;
                }
            }
        }
    }
    false
}

/// Walk `HKCU\Software\Moonlight Game Streaming Project\Moonlight\hosts`
/// and delete any numeric subkey whose `localaddress`/`manualaddress`
/// matches `host`. Idempotent: a missing subkey is not an error.
fn forget_registry_host(host: &str) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;
    let host_lower = host.to_lowercase();
    let root = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
        r"Software\Moonlight Game Streaming Project\Moonlight\hosts",
        KEY_READ | KEY_WRITE,
    ) {
        Ok(r) => r,
        Err(_) => return,
    };
    // Collect names first — we can't delete while iterating.
    let names: Vec<String> = root
        .enum_keys()
        .flatten()
        .filter(|n| n.chars().all(|c| c.is_ascii_digit()))
        .collect();
    for name in names {
        let addr = match root.open_subkey(&name) {
            Ok(e) => match reg_host_get(&e, "localaddress")
                .or_else(|| reg_host_get(&e, "manualaddress"))
            {
                Some(a) => a,
                None => continue,
            },
            Err(_) => continue,
        };
        if addr.to_lowercase() == host_lower {
            // Re-open with write access for the delete.
            if let Ok(parent) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
                r"Software\Moonlight Game Streaming Project\Moonlight\hosts",
                KEY_READ | KEY_WRITE,
            ) {
                let _ = parent.delete_subkey_all(&name);
            }
        }
    }
}

fn reg_host_get(h: &winreg::RegKey, key: &str) -> Option<String> {
    h.get_value::<String, _>(key).ok().filter(|s| !s.is_empty())
}

fn reg_host_from(entry: &winreg::RegKey) -> Option<PairedHost> {
    let name = reg_host_get(entry, "hostname")?;
    // The pinned server cert is what marks a host as paired.
    reg_host_get(entry, "srvcert")?;
    let address = reg_host_get(entry, "localaddress")
        .or_else(|| reg_host_get(entry, "manualaddress"))?;
    // Port is stored alongside the address (`localport` for mDNS-discovered
    // hosts, `manualport` for user-entered ones). Moonlight's deserializer
    // defaults to `DEFAULT_HTTP_PORT` (= 47989) if absent.
    let local = reg_host_get(entry, "localaddress").is_some();
    let port_key = if local { "localport" } else { "manualport" };
    let port = entry
        .get_value::<u32, _>(port_key)
        .ok()
        .filter(|&p| p > 0 && p < u16::MAX as u32)
        .map(|p| p as u16)
        .unwrap_or_else(default_paired_port);
    Some(PairedHost {
        name,
        uuid: reg_host_get(entry, "uuid").unwrap_or_default(),
        address,
        port,
    })
}

fn read_registry_paired_hosts() -> Vec<PairedHost> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let mut out = Vec::new();
    let root = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Moonlight Game Streaming Project\Moonlight")
    {
        Ok(r) => r,
        Err(_) => return out,
    };
    let hosts = match root.open_subkey("hosts") {
        Ok(h) => h,
        Err(_) => return out,
    };
    for name in hosts.enum_keys().flatten() {
        if name.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(entry) = hosts.open_subkey(&name) {
                if let Some(host) = reg_host_from(&entry) {
                    out.push(host);
                }
            }
        }
    }
    out
}

/// Look up the UUID of a paired host by its IP / hostname. Currently
/// unused — left in place in case a future feature needs to correlate
/// streams with their paired record. Suppress the dead-code warning.
#[allow(dead_code)]
fn paired_host_uuid(address: &str) -> Option<String> {
    let host_lower = address.to_lowercase();
    read_registry_paired_hosts()
        .into_iter()
        .find(|h| h.address.to_lowercase() == host_lower)
        .map(|h| h.uuid)
}

/// Portable `Moonlight.conf` (QSettings INI): `[hosts\0]`… sections.
fn push_ini_paired(
    out: &mut Vec<PairedHost>,
    in_host: bool,
    name: &str,
    uuid: &str,
    cert: &str,
    local: &str,
    manual: &str,
    local_port: &str,
    manual_port: &str,
) {
    if !in_host || cert.is_empty() || name.is_empty() {
        return;
    }
    let (address, port_str) = if !local.is_empty() {
        (local.to_string(), local_port)
    } else if !manual.is_empty() {
        (manual.to_string(), manual_port)
    } else {
        return;
    };
    let port = port_str
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
        .unwrap_or_else(default_paired_port);
    out.push(PairedHost {
        name: name.to_string(),
        uuid: uuid.to_string(),
        address,
        port,
    });
}

fn parse_moonlight_ini_hosts(ini: &str) -> Vec<PairedHost> {
    let mut out = Vec::new();
    let mut in_host = false;
    let mut name = String::new();
    let mut uuid = String::new();
    let mut cert = String::new();
    let mut local = String::new();
    let mut manual = String::new();
    let mut local_port = String::new();
    let mut manual_port = String::new();

    for line in ini.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            push_ini_paired(
                &mut out,
                in_host,
                &name,
                &uuid,
                &cert,
                &local,
                &manual,
                &local_port,
                &manual_port,
            );
            let section = &line[1..line.len() - 1];
            in_host = section.starts_with(r"hosts\") && !section.starts_with(r"hostsbackup\");
            name.clear();
            uuid.clear();
            cert.clear();
            local.clear();
            manual.clear();
            local_port.clear();
            manual_port.clear();
        } else if in_host {
            if let Some((k, v)) = line.split_once('=') {
                let v = v.trim().to_string();
                match k.trim() {
                    "hostname" => name = v,
                    "uuid" => uuid = v,
                    "srvcert" => cert = v,
                    "localaddress" => local = v,
                    "manualaddress" => manual = v,
                    "localport" => local_port = v,
                    "manualport" => manual_port = v,
                    _ => {}
                }
            }
        }
    }
    push_ini_paired(
        &mut out,
        in_host,
        &name,
        &uuid,
        &cert,
        &local,
        &manual,
        &local_port,
        &manual_port,
    );
    out
}

#[derive(serde::Serialize)]
struct MoonlightProbe {
    reachable: bool,
    paired: bool,
}

/// Quick reachability + pairing probe for a specific host (LAN IP or a
/// Tailscale MagicDNS hostname). Used to show saved machines as online/offline.
#[tauri::command]
async fn moonlight_probe(
    host: String,
    state: State<'_, settings::SettingsState>,
) -> Result<MoonlightProbe, String> {
    let exe = moonlight_exe(&state);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let reachable = [47984u16, 47989]
            .iter()
            .any(|&port| {
                use std::net::ToSocketAddrs;
                (host.as_str(), port)
                    .to_socket_addrs()
                    .ok()
                    .and_then(|mut addrs| addrs.next())
                    .and_then(|addr| {
                        std::net::TcpStream::connect_timeout(
                            &addr,
                            std::time::Duration::from_millis(1500),
                        )
                        .ok()
                    })
                    .is_some()
            });
        let paired = exe.as_deref().is_some_and(|e| probe_listapps(e, &host));
        MoonlightProbe { reachable, paired }
    })
    .await
    .map_err(|e| e.to_string())?)
}

fn probe_listapps(exe: &std::path::Path, host: &str) -> bool {
    // Spawn the Moonlight child ourselves (instead of going through a
    // detached thread + Command::output) so we can time-box the wait and
    // explicitly kill the child + reap it if it hangs past the deadline.
    // The previous implementation used `Command::output()` inside a
    // `std::thread::spawn`, then `recv_timeout` on the main thread. If
    // moonlight.exe hung, `output()` never returned, the inner thread
    // leaked, and the child process kept running until the OS reaped it.
    let mut child = match Command::new(exe)
        .args(["list", host])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    // `Child::wait_timeout` is Unix-only; on Windows we poll `try_wait`
    // until either the child exits or our deadline passes.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    // Hang: kill and reap so we don't leave a zombie.
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[derive(serde::Serialize)]
struct PairedProbeResult {
    address: String,
    online: bool,
}

/// Probe paired hosts the same way Moonlight does: hit `GET /serverinfo` over
/// HTTP on each host's per-host port and look for `<root status_code="200">`
/// in the XML response. This is exactly the check `PcMonitorThread` runs to
/// decide online vs. offline, so the result matches what the Moonlight client
/// itself shows. Returns one entry per input host in the same order.
///
/// We deliberately use plain HTTP, not HTTPS — Moonlight's `getServerInfo`
/// also tries HTTPS first only when a cert is pinned, and falls back to HTTP
/// fast-fail. For a liveness probe we want speed and zero setup; the XML
/// status code is the same either way.
#[tauri::command]
async fn moonlight_probe_paired(
    hosts: Vec<PairedHost>,
) -> Result<Vec<PairedProbeResult>, String> {
    Ok(tauri::async_runtime::spawn_blocking(move || {
        // Each probe has its own ~2 s timeout, so probe in parallel — 5
        // paired hosts finish in ~2 s instead of ~10 s. `into_par_iter`
        // would need the `rayon` crate; threads are fine for a one-shot
        // burst and avoid pulling in a dep.
        let mut handles = Vec::with_capacity(hosts.len());
        for h in hosts {
            let addr = h.address.clone();
            let port = h.port;
            handles.push(std::thread::spawn(move || {
                let online = serverinfo_probe(&addr, port);
                PairedProbeResult { address: addr, online }
            }));
        }
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?)
}

/// `GET /serverinfo?uniqueid=…&uuid=…` over plain HTTP, ~2 s timeout. Returns
/// true iff we get an HTTP response with `<root status_code="200">`. Matches
/// Moonlight's `FAST_FAIL_TIMEOUT_MS` so we agree with what its polling
/// thread considers "alive".
fn serverinfo_probe(address: &str, port: u16) -> bool {
    use std::io::{Read, Write};
    use std::net::ToSocketAddrs;
    use std::time::Duration;

    let addr = match (address, port).to_socket_addrs() {
        Ok(mut it) => match it.next() {
            Some(a) => a,
            None => return false,
        },
        Err(_) => return false,
    };

    let mut stream = match std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(1500)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));

    // The body Moonlight's NvHTTP sends. uniqueid is a placeholder; uuid is a
    // request id. Neither matters for liveness — the server replies 200 to
    // any /serverinfo request when it's healthy.
    let req = format!(
        "GET /serverinfo?uniqueid=0123456789ABCDEF&uuid=00000000-0000-0000-0000-000000000000 HTTP/1.0\r\nHost: {address}\r\nUser-Agent: Moonblast\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }

    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 1024];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    let text = match std::str::from_utf8(&buf) {
        Ok(s) => s,
        Err(_) => return false,
    };
    // Look for the `status_code="200"` attribute on the <root> element.
    // We don't need to parse XML — substring match is enough; any 200 reply
    // means the host is alive. The XML never legitimately contains this
    // string in any other field.
    text.contains("status_code=\"200\"")
}

/// Kill every active streaming child we've spawned, so they don't outlive
/// Moonblast as invisible processes (StreamState's Child::drop only closes
/// the process handle on Windows — it does not kill). Bounded by the
/// user's active stream count, which is small.
fn kill_all_streams(streams: &StreamState) {
    let mut map = match streams.0.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    for (_key, mut active) in map.drain() {
        let _ = active.child.kill();
        let _ = active.child.wait();
    }
}

/// Exit Moonblast entirely.
#[tauri::command]
fn close_app(app: AppHandle, streams: State<'_, StreamState>) {
    // Kill any in-flight streaming windows so they don't outlive the
    // launcher as zombies.
    kill_all_streams(&streams);
    // Always bring the Windows shell back before leaving.
    suppress_shell(false);
    app.exit(0);
}

/// Whether Immersive Mode suppressed the Windows shell (Explorer) so we can
/// restart it on exit.
static EXPLORER_KILLED: AtomicBool = AtomicBool::new(false);

/// Kill or restart the Windows shell (Explorer) to hide/show the taskbar +
/// desktop. `suppress_shell(true)` hides; `suppress_shell(false)` restores.
fn suppress_shell(hidden: bool) {
    if hidden {
        let _ = Command::new("taskkill.exe").args(["/f", "/im", "explorer.exe"]).creation_flags(0x0800_0000).spawn();
        EXPLORER_KILLED.store(true, Ordering::SeqCst);
    } else if EXPLORER_KILLED.swap(false, Ordering::SeqCst) {
        let _ = Command::new("explorer.exe").spawn();
    }
}

/// Minimize every visible top-level window except our own, so nothing shows
/// behind the immersive launcher (approximates Xbox mode's one-app-at-a-time).
fn minimize_other_windows() {
    use windows_sys::Win32::Foundation::{BOOL, HWND};
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, ShowWindow, SW_MINIMIZE,
    };
    unsafe extern "system" fn cb(hwnd: HWND, _lparam: isize) -> BOOL {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == GetCurrentProcessId() {
            return 1; // leave our own windows alone
        }
        ShowWindow(hwnd, SW_MINIMIZE);
        1
    }
    unsafe {
        EnumWindows(Some(cb), 0);
    }
}

/// Register/remove Moonblast in Windows startup (HKCU Run key).
#[tauri::command]
fn set_start_with_windows(enabled: bool) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_SET_VALUE)
        .map_err(|e| e.to_string())?;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        key.set_value("Moonblast", &exe.to_string_lossy().to_string())
            .map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value("Moonblast");
    }
    Ok(())
}

/// Whether this process was started by the shell stub at sign-in (as opposed to
/// launched by hand), i.e. whether Immersive Mode should engage on boot.
fn is_autostart() -> bool {
    std::env::args().skip(1).any(|a| a == shell::AUTOSTART_FLAG)
}

/// Exposed so the frontend only auto-enters Immersive Mode on a real sign-in.
#[tauri::command]
fn booted_as_shell() -> bool {
    is_autostart()
}

/// Register/remove Moonblast as the Windows shell, so sign-in boots straight into
/// the launcher instead of the desktop. Per-user, so no elevation is needed.
#[tauri::command]
fn set_replace_desktop(enabled: bool) -> Result<(), String> {
    shell::set_replace_desktop(enabled)?;
    if enabled {
        // Arming from the UI is an explicit fresh start, so forgive earlier crashes.
        shell::reset_crash_count();
    }
    Ok(())
}

/// Enter Immersive Mode: go fullscreen, suppress the desktop shell, and
/// minimize background windows so only the launcher shows.
#[tauri::command]
async fn enter_immersive(window: tauri::Window) -> Result<(), String> {
    if !window.is_fullscreen().map_err(|e| e.to_string())? {
        if window.is_maximized().map_err(|e| e.to_string())? {
            window.unmaximize().map_err(|e| e.to_string())?;
        }
        window.set_fullscreen(true).map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(|| {
        minimize_other_windows();
        suppress_shell(true);
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Exit Immersive Mode: restore the Windows shell.
#[tauri::command]
async fn exit_immersive() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        suppress_shell(false);
        // When Moonblast is the shell, Explorer was never started at sign-in, so
        // there's nothing for `suppress_shell` to restore — start it now so
        // leaving Immersive Mode still hands back a usable desktop.
        if shell::desktop_replaced() {
            shell::ensure_desktop();
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(non_snake_case)]
struct BatteryStatus {
    /// 0–100. Returns -1 when the OS reports "unknown" (laptop with a battery
    /// that hasn't reported a level yet, or a percentage the API couldn't read).
    percent: i32,
    /// True when the battery is actively accepting current. Uses the hardware
    /// `BatteryFlag & 0x08` bit rather than `ACLineStatus == 1` so a fully-
    /// charged laptop on the charger is "plugged in but not charging", not
    /// "charging".
    charging: bool,
    /// True when the system is on wall power (regardless of charge state).
    /// Drives the Power Source line in the modal.
    pluggedIn: bool,
    /// Estimated seconds until empty (on battery) or until full (charging),
    /// when the OS knows it. `0` means the OS explicitly reports no estimate
    /// rather than "0 seconds left"; the modal renders "Calculating…" then.
    /// `None` when the OS reports `BatteryLifeTime == -1` (unknown).
    timeRemainingSec: Option<u32>,
}

/// Report the current battery state, or `None` when the system has no battery
/// (desktops, VMs, etc.) so the UI can simply skip the chip. Read via the
/// Win32 `GetSystemPowerStatus` API, which is the same one Explorer uses for
/// the tray.
#[tauri::command]
fn battery() -> Option<BatteryStatus> {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetSystemPowerStatus(&mut s) };
    if ok == 0 {
        moonblast_log!("battery: GetSystemPowerStatus returned ok=0");
        return None;
    }
    // BatteryFlag bit 0x80 = "no system battery" (desktop / no battery fitted).
    if s.BatteryFlag & 0x80 != 0 {
        return None;
    }
    let status = BatteryStatus {
        // BatteryLifePercent is 0–100, or 255 when unknown. We surface -1 for
        // unknown so the UI can fall back to a charging icon without a percent.
        percent: if s.BatteryLifePercent == 255 { -1 } else { s.BatteryLifePercent as i32 },
        // BatteryFlag & 0x08 = "charging" hardware bit. Falls back to
        // ACLineStatus == 1 only when the BatteryFlag is the "unknown" sentinel
        // (255), so we still report "plugged in" correctly in that edge case.
        charging: if s.BatteryFlag != 255 { s.BatteryFlag & 0x08 != 0 } else { s.ACLineStatus == 1 },
        // ACLineStatus: 1 = online, 0 = offline, 255 = unknown.
        pluggedIn: s.ACLineStatus == 1,
        // Per MS docs, BatteryLifeTime is "the number of seconds of battery
        // life remaining, or -1 if remaining seconds are unknown or if the
        // device is connected to AC power" — i.e. Win32 never tells us
        // time-to-full. We map -1 (0xFFFFFFFF) to None, 0 to None (OS
        // reports no estimate / charging but no rate yet), otherwise the
        // remaining seconds. The frontend hides the time row when this is
        // None so we never show "Calculating…" while on AC.
        timeRemainingSec: match s.BatteryLifeTime {
            0xFFFFFFFF => None,
            0 => None,
            v => Some(v),
        },
    };
    moonblast_log!(
        "battery: flag=0x{:02x} ac={} pct={} life={:?}",
        s.BatteryFlag, s.ACLineStatus, status.percent, status.timeRemainingSec
    );
    Some(status)
}

/// Current WiFi connection for the chip in the TopBar. Returns `None` when
/// the system has no WiFi adapter, so the UI can simply skip rendering the
/// chip (same pattern as the battery command).
#[tauri::command]
fn wifi_current() -> Option<wifi::WifiConnection> {
    wifi::current()
}

/// Visible network list. Called when the user opens the picker modal.
/// Triggers a fresh scan (~1s) then returns the resulting list. Cost is
/// paid only on demand, not on every chip poll.
#[tauri::command]
async fn wifi_scan() -> Vec<wifi::WifiNetwork> {
    // The scan does a synchronous WlanScan + a 2.5s sleep to let the
    // driver populate the visible-network cache, then a netsh read.
    // Running it on a blocking task means other Tauri commands (like
    // the chip's wifi_current poll) don't queue up behind it.
    tauri::async_runtime::spawn_blocking(wifi::scan_and_list)
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Connect to a WiFi network by SSID. Returns `Ok(())` on success, or an
/// `Err` with a human-readable reason — the UI can surface this to the
/// user (e.g. "profile required" for secured-no-saved-profile networks).
#[tauri::command]
fn wifi_connect(ssid: String) -> Result<(), String> {
    wifi::connect(&ssid)
}

/// Connect to a secured WiFi network using a password. Builds a profile
/// XML, registers it, and connects. The profile sticks around after
/// connect so the SSID appears as "Saved" in the picker next time.
#[tauri::command]
fn wifi_connect_with_password(
    ssid: String,
    password: String,
    auth: String,
) -> Result<(), String> {
    wifi::connect_with_password(&ssid, &password, &auth)
}

/// Disconnect from the current WiFi network. No-op if already disconnected.
#[tauri::command]
fn wifi_disconnect() -> Result<(), String> {
    wifi::disconnect()
}

/// Delete a saved WiFi profile ("forget" the network). No-op when no
/// profile exists — forgetting is idempotent.
#[tauri::command]
fn wifi_forget(ssid: String) -> Result<(), String> {
    wifi::forget(&ssid)
}

/// Output devices for the TopBar audio picker (default render endpoint first
/// by `is_default`; the UI sorts alphabetically and marks the default).
/// Also arms the `audio-changed` push notifications (idempotent).
#[tauri::command]
async fn audio_devices(app: AppHandle) -> Result<audio::AudioDeviceList, String> {
    tauri::async_runtime::spawn_blocking(move || {
        audio::ensure_watch(app);
        audio::devices()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Set the default output device (all roles, like the Sound control panel).
#[tauri::command]
async fn audio_set_default_device(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || audio::set_default_device(&id))
        .await
        .map_err(|e| e.to_string())?
}

/// Main mixer level for the TopBar chip + modal.
/// Also arms the `audio-changed` push notifications (idempotent).
#[tauri::command]
async fn audio_master(app: AppHandle) -> Result<audio::AudioMaster, String> {
    tauri::async_runtime::spawn_blocking(move || {
        audio::ensure_watch(app);
        audio::master()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn audio_set_master_volume(volume: u8) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || audio::set_master_volume(volume))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn audio_set_master_mute(muted: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || audio::set_master_mute(muted))
        .await
        .map_err(|e| e.to_string())?
}

/// Per-app mixer rows, grouped by exe like the Windows mixer.
/// Also arms the `audio-changed` push notifications (idempotent).
#[tauri::command]
async fn audio_sessions(app: AppHandle) -> Result<Vec<audio::AudioSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        audio::ensure_watch(app);
        audio::sessions()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn audio_set_session_volume(id: String, volume: u8) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || audio::set_session_volume(&id, volume))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn audio_set_session_mute(id: String, muted: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || audio::set_session_mute(&id, muted))
        .await
        .map_err(|e| e.to_string())?
}

/// Reset every app channel to max + unmuted. Returns sessions touched.
#[tauri::command]
async fn audio_reset_sessions() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(audio::reset_sessions)
        .await
        .map_err(|e| e.to_string())?
}

/// Read the primary display's HDR state. Sync — two DisplayConfig*
/// syscalls, no IO, runs in microseconds. See `hdr.rs` for the rationale.
///
/// HDR always targets the primary display: the GDI adapter name
/// (`\\.\DISPLAYn`) can't be mapped back to a `DISPLAYCONFIG_PATH_INFO`
/// via any public API, so per-monitor HDR targeting isn't possible from
/// the Settings picker. The Monitor dropdown is for the resolution
/// picker only.
#[tauri::command]
fn hdr_status() -> hdr::HdrStatus {
    hdr::hdr_status()
}

/// Toggle HDR on the primary display. Returns an error when the OS
/// rejects the call (e.g. driver said no, or no active path exists).
#[tauri::command]
fn set_hdr(enabled: bool) -> Result<(), String> {
    hdr::set_hdr(enabled)
}

/// List every attached GDI monitor. Each entry's `device_name` is the
/// `\\.\DISPLAYn` string the rest of the API uses to identify the adapter.
/// Disabled (attached-but-not-in-desktop) monitors come through too with
/// `disabled = true` so the frontend can show them as a non-selectable row.
#[tauri::command]
fn list_monitors() -> Vec<display::Monitor> {
    display::list_monitors()
}

/// List every resolution + refresh-rate combination the named monitor
/// reports as monitor-compatible (matches Windows Settings). Pass `None`
/// for the primary monitor.
#[tauri::command]
fn display_modes(device_name: Option<String>) -> Vec<display::DisplayOption> {
    display::display_modes_for(device_name.as_deref())
}

/// Read the named monitor's currently-active resolution + refresh rate.
/// Drives the picker's initial selection.
#[tauri::command]
fn current_display(device_name: Option<String>) -> Result<display::CurrentDisplay, String> {
    display::current_display_for(device_name.as_deref())
}

/// Apply a new (width, height, refresh_hz) on the named monitor via
/// `ChangeDisplaySettingsExW` with no flags (dynamic — reverts on
/// sign-out / reboot). Records the prior mode so `revert_display_mode`
/// can roll back during the 10-second Keep/Revert window.
#[tauri::command]
fn apply_display_mode(
    device_name: Option<String>,
    width: u32,
    height: u32,
    refresh_rate: u32,
) -> Result<(), String> {
    display::apply_display_mode_for(device_name.as_deref(), width, height, refresh_rate)
}

/// Revert to the mode that was active before the last `apply_display_mode`
/// for the named monitor. No-op when no change is pending for it.
#[tauri::command]
fn revert_display_mode(device_name: Option<String>) -> Result<(), String> {
    display::revert_display_mode_for(device_name.as_deref())
}

/// Confirm the last applied mode on the named monitor — clears the
/// pending revert so the 10-second auto-revert timer no longer fires.
#[tauri::command]
fn keep_display_mode(device_name: Option<String>) -> Result<(), String> {
    display::keep_display_mode_for(device_name.as_deref())
}

/// Trigger a Windows power action: "sleep", "reboot", or "shutdown".
#[tauri::command]
async fn system_power(action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        // Use SetSuspendState directly — `rundll32 powrprof.dll,SetSuspendState`
        // is unreliable on Windows 10/11 (may hibernate or silently no-op).
        "sleep" => {
            use windows_sys::Win32::System::Power::SetSuspendState;
            let ok = unsafe { SetSuspendState(0, 0, 0) };
            if ok == 0 {
                // Surface the real reason — a denied request, missing
                // privilege, or no power-management driver all return 0 with
                // different last-errors. The user can look up the code
                // instead of guessing.
                let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
                Err(format!(
                    "SetSuspendState failed (Win32 error {code}). See https://learn.microsoft.com/windows/win32/debug/system-error-codes"
                ))
            } else {
                Ok(())
            }
        }
        "reboot" => run_shutdown(&["/r", "/t", "0", "/c", "Moonblast: restart requested"]).or_else(|e| {
            // Fall back to the Win32 API. `shutdown.exe` can fail when the
            // user lacks `SeShutdownPrivilege` (some GPOs strip it) or when
            // the binary is missing/corrupted. ExitWindowsEx on the same
            // session sid works in those cases.
            exit_windows(true).map_err(|win| {
                format!("shutdown.exe failed ({e}); ExitWindowsEx also failed ({win})")
            })
        }),
        "shutdown" => run_shutdown(&["/s", "/t", "0", "/c", "Moonblast: shutdown requested"]).or_else(|e| {
            exit_windows(false).map_err(|win| {
                format!("shutdown.exe failed ({e}); ExitWindowsEx also failed ({win})")
            })
        }),
        _ => Err(format!("unknown power action: {action}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run `shutdown.exe <args>` and wait for it. `spawn()` alone wouldn't tell
/// us if `shutdown.exe` itself failed (e.g. privileged operation blocked);
/// we need its exit code to surface a real error to the user.
fn run_shutdown(args: &[&str]) -> Result<(), String> {
    let out = Command::new("shutdown.exe")
        .args(args)
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("could not launch shutdown.exe: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        // `shutdown.exe` writes useful diagnostics to stderr when it
        // refuses (e.g. "Access is denied. (5)"). Surface it verbatim.
        let stderr = String::from_utf8_lossy(&out.stderr);
        let trimmed = stderr.trim();
        if trimmed.is_empty() {
            Err(format!("shutdown.exe exited with status {}", out.status))
        } else {
            Err(format!("shutdown.exe: {trimmed}"))
        }
    }
}

/// Win32 fallback for shutdown / reboot when `shutdown.exe` is unavailable.
/// `EWX_SHUTDOWN` / `EWX_REBOOT` need no special privilege for the calling
/// user (unlike `EWX_FORCE`); we leave the force flag off so apps can
/// cleanly save state and the user gets a clean shutdown.
fn exit_windows(reboot: bool) -> Result<(), String> {
    use windows_sys::Win32::System::Shutdown::{
        ExitWindowsEx, EWX_REBOOT, EWX_SHUTDOWN, SHTDN_REASON_FLAG_PLANNED,
    };
    let flags = if reboot { EWX_REBOOT } else { EWX_SHUTDOWN } | SHTDN_REASON_FLAG_PLANNED;
    let ok = unsafe { ExitWindowsEx(flags, 0) };
    if ok == 0 {
        let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        Err(format!("ExitWindowsEx failed (Win32 error {code})"))
    } else {
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Open the log file before Tauri starts so any panic during setup
    // (e.g. window creation, plugin init) is captured. The data dir is
    // resolved the same way `settings.json` is — `%LOCALAPPDATA%\<id>\`.
    // `app_data_dir` isn't callable without an `AppHandle`, so we fall back
    // to a known sentinel path that's at least on disk if resolution fails.
    let data_dir = std::env::var("LOCALAPPDATA")
        .map(|p| std::path::PathBuf::from(p).join("com.moonblast.app"))
        .unwrap_or_else(|_| std::path::PathBuf::from("moonblast-local"));
    if let Err(e) = logging::init(data_dir) {
        eprintln!("moonblast: failed to init log: {e}");
    }
    moonblast_log!("run() entering tauri::Builder");
    tauri::Builder::default()
        .on_window_event(|window, event| {
            // If the app is closed while in Immersive Mode, bring the shell back.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                moonblast_log!("window event: Destroyed");
                // Also kill any streaming children — without this, the OS
                // would keep them alive as invisible processes (Child::drop
                // on Windows only closes the handle, doesn't kill).
                if let Some(streams) = window.try_state::<StreamState>() {
                    kill_all_streams(&streams);
                }
                suppress_shell(false);
            } else if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                moonblast_log!("window event: CloseRequested (immersive={})", EXPLORER_KILLED.load(Ordering::SeqCst));
                // Only intercept Alt+F4 / taskbar-Close while in Immersive
                // Mode. Outside Immersive, the window can close normally —
                // the user just wants to quit the launcher. EXPLORER_KILLED
                // tracks Immersive state (set by `suppress_shell(true)`,
                // cleared by `suppress_shell(false)`).
                if !EXPLORER_KILLED.load(Ordering::SeqCst) {
                    return;
                }
                // Don't destroy the window — pop the Power menu so the
                // user makes a deliberate choice. The menu's "Close
                // Moonblast" item calls `close_app`, which uses
                // `app.exit(0)` and bypasses this hook on its way out.
                api.prevent_close();
                let _ = window.emit("request-power-menu", ());
            }
        })
        .setup(|app| {
            app.manage(settings::SettingsState::load(app.handle()));
            app.manage(StreamState::default());
            // Apply the bundled app icon to the main window (taskbar/alt-tab).
            if let Some(icon) = app.default_window_icon() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_icon(icon.clone());
                }
            }
            // Auto Immersive Mode both registers Moonblast as the Windows shell
            // and enters Immersive Mode — but only on a real sign-in, which the
            // stub signals with `--autostart`. Toggling the setting mid-session
            // therefore never yanks the user into Immersive Mode.
            let autostarted = is_autostart();
            let want = {
                let state = app.state::<settings::SettingsState>();
                let guard = state.0.lock().unwrap();
                guard.fullscreen.auto_immersive
            };
            let armed = shell::desktop_replaced();
            if want && !armed {
                // A rescue (Shift at sign-in, or the crash bail-out) already put
                // the normal shell back. Respect that instead of silently
                // re-arming, and make the UI reflect it.
                let state = app.state::<settings::SettingsState>();
                settings::disable_auto_immersive(app.handle(), &state);
            } else if want {
                // Refresh the registered path so moving or updating the app can't
                // strand a stale Winlogon entry.
                std::thread::spawn(|| {
                    let _ = shell::set_replace_desktop(true);
                    // Surviving this long means we aren't crash-looping, so clear
                    // the counter the stub uses to bail out.
                    std::thread::sleep(std::time::Duration::from_secs(shell::CRASH_RESET_SECS));
                    shell::reset_crash_count();
                });
            }
            // The window is created with `visible: false` (see tauri.conf.json)
            // so we can position and (for auto-immersive) fullscreen it before
            // the first paint — no centered 1280x800 box on a black backdrop.
            // Suppress the desktop/background as early as possible at boot
            // (before the UI even hydrates); fullscreen follows on sign-in via
            // `enter_immersive` for normal launches, and is set right here for
            // auto-immersive sign-ins.
            if let Some(window) = app.get_webview_window("main") {
                if want && armed && autostarted {
                    let _ = window.set_fullscreen(true);
                    tauri::async_runtime::spawn_blocking(|| {
                        minimize_other_windows();
                        suppress_shell(true);
                    });
                }
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch → focus the existing window instead of spawning a new one.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::update_settings,
            toggle_fullscreen,
            is_fullscreen,
            minimize_window,
            toggle_maximize,
            is_maximized,
            close_app,
            system_power,
            set_start_with_windows,
            set_replace_desktop,
            booted_as_shell,
            enter_immersive,
            exit_immersive,
            battery,
            wifi_current,
            wifi_scan,
            wifi_connect,
            wifi_connect_with_password,
            wifi_disconnect,
            wifi_forget,
            audio_devices,
            audio_set_default_device,
            audio_master,
            audio_set_master_volume,
            audio_set_master_mute,
            audio_sessions,
            audio_set_session_volume,
            audio_set_session_mute,
            audio_reset_sessions,
            tailscale_status,
            tailscale_set,
            validate_moonlight_dir,
            moonlight_list_apps,
            moonlight_pair,
            moonlight_stream,
            moonlight_quit,
            discover_hosts,
            moonlight_paired_hosts,
            moonlight_forget,
            moonlight_probe,
            moonlight_probe_paired,
            client_display,
            discover_apps,
            launch_app,
            launch_autolaunch_apps,
            app_icon,
            cache_steamgrid_icon,
            import_app_icon,
            clear_cached_icon,
            clipboard_icon_hint,
            clipboard_icon_import,
            check_steamgrid_key,
            steamgrid_search,
            steamgrid_icons,
            hdr_status,
            set_hdr,
            list_monitors,
            display_modes,
            current_display,
            apply_display_mode,
            revert_display_mode,
            keep_display_mode
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}