use tauri::AppHandle;
use tauri::Manager;
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
            validate_moonlight_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}