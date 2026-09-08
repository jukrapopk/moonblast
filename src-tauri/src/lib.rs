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
        .invoke_handler(tauri::generate_handler![
            toggle_fullscreen,
            is_fullscreen,
            close_app,
            system_power
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}