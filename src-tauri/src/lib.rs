use tauri::AppHandle;
use tauri::Manager;
use tauri::State;
use std::process::Command;

mod settings;

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
fn tailscale_status() -> TailscaleInfo {
    let status = match Command::new("tailscale").arg("status").output() {
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
}

/// Bring Tailscale up or down. Only meaningful when the daemon is running.
#[tauri::command]
fn tailscale_set(up: bool) -> Result<(), String> {
    let arg = if up { "up" } else { "down" };
    let out = Command::new("tailscale").arg(arg).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let msg = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stderr),
            String::from_utf8_lossy(&out.stdout)
        );
        return Err(msg.trim().to_string());
    }
    Ok(())
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

/// List a host's apps via `moonlight listapps <host>`.
#[tauri::command]
fn moonlight_list_apps(
    host: String,
    state: State<'_, settings::SettingsState>,
) -> Result<Vec<String>, String> {
    let exe = moonlight_exe(&state).ok_or("Moonlight executable not found")?;
    let out = Command::new(&exe)
        .args(["listapps", &host])
        .output()
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
}

/// Launch Moonlight's pairing flow for a host (opens Moonlight QT's PIN window).
#[tauri::command]
fn moonlight_pair(
    host: String,
    state: State<'_, settings::SettingsState>,
) -> Result<(), String> {
    let exe = moonlight_exe(&state).ok_or("Moonlight executable not found")?;
    Command::new(&exe)
        .args(["pair", &host])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Launch a stream for a host + app via `moonlight stream <host> <app>`.
#[tauri::command]
fn moonlight_stream(
    host: String,
    app: String,
    state: State<'_, settings::SettingsState>,
) -> Result<(), String> {
    let exe = moonlight_exe(&state).ok_or("Moonlight executable not found")?;
    Command::new(&exe)
        .args(["stream", &host, &app])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Ask the running stream on a host to quit.
#[tauri::command]
fn moonlight_quit(
    host: String,
    state: State<'_, settings::SettingsState>,
) -> Result<(), String> {
    let exe = moonlight_exe(&state).ok_or("Moonlight executable not found")?;
    Command::new(&exe)
        .args(["quit", &host])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Discover Sunshine/GameStream hosts on the LAN via mDNS, and classify each as
/// paired or not by probing with `moonlight listapps`.
#[tauri::command]
fn discover_hosts(state: State<'_, settings::SettingsState>) -> Vec<DiscoveredHost> {
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

    let exe = moonlight_exe(&state);
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
}

#[derive(serde::Serialize)]
struct DiscoveredHost {
    hostname: String,
    name: String,
    address: String,
    paired: bool,
}

fn probe_listapps(exe: &std::path::Path, host: &str) -> bool {
    let exe = exe.to_path_buf();
    let host = host.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let ok = Command::new(&exe)
            .args(["listapps", &host])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let _ = tx.send(ok);
    });
    rx.recv_timeout(std::time::Duration::from_secs(8)).unwrap_or(false)
}

/// Exit Moonblast entirely.
#[tauri::command]
fn close_app(app: AppHandle) {
    app.exit(0);
}

/// Trigger a Windows power action: "sleep", "reboot", or "shutdown".
#[tauri::command]
fn system_power(action: String) -> Result<(), String> {
    let (prog, args): (&str, Vec<&str>) = match action.as_str() {
        "sleep" => ("rundll32.exe", vec!["powrprof.dll,SetSuspendState 0,1,0"]),
        "reboot" => ("shutdown.exe", vec!["/r", "/t", "0"]),
        "shutdown" => ("shutdown.exe", vec!["/s", "/t", "0"]),
        _ => return Err(format!("unknown power action: {action}")),
    };
    Command::new(prog).args(&args).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(settings::SettingsState::load(app.handle()));
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            tailscale_status,
            tailscale_set,
            validate_moonlight_dir,
            moonlight_list_apps,
            moonlight_pair,
            moonlight_stream,
            moonlight_quit,
            discover_hosts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}