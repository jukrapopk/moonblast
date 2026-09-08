use tauri::AppHandle;
use std::process::Command;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

/// Toggle the window between windowed and fullscreen. Returns the new state.
#[tauri::command]
fn toggle_fullscreen(window: tauri::Window) -> Result<bool, String> {
    let fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
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

/// Detects whether the Tailscale CLI is available and whether it's up.
#[tauri::command]
fn tailscale_status() -> TailscaleInfo {
    match Command::new("tailscale").arg("status").output() {
        Ok(output) => {
            let result = String::from_utf8_lossy(&output.stdout);
            let up = output.status.success()
                && !result.contains("Logged out")
                && !result.contains("Needs login");
            TailscaleInfo { found: true, up }
        }
        Err(_) => TailscaleInfo { found: false, up: false },
    }
}

/// Turns Tailscale up (`up`) or down (`down`).
#[tauri::command]
fn tailscale_set(up: bool) -> Result<(), String> {
    let arg = if up { "up" } else { "down" };
    Command::new("tailscale")
        .arg(arg)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
struct TailscaleInfo {
    found: bool,
    up: bool,
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
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