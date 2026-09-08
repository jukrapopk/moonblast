use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// App-wide persisted settings, owned and versioned by Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub version: u32,
    pub general: General,
    pub integrations: Integrations,
    pub moonlight: MoonlightStreaming,
    pub fullscreen: Fullscreen,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct General {
    pub start_with_windows: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Integrations {
    pub tailscale_enabled: bool,
    pub moonlight_folder: Option<String>,
    pub moonlight_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoonlightStreaming {
    pub resolution: String,
    pub refresh_rate: String,
    pub bitrate: u32,
    pub codec: String,
    pub fullscreen: bool,
    pub fps_overlay: bool,
    pub gamepad: bool,
    pub mouse_smoothing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fullscreen {
    pub suppress_explorer: bool,
    pub auto_fullscreen: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            general: General {
                start_with_windows: false,
            },
            integrations: Integrations {
                tailscale_enabled: true,
                moonlight_folder: None,
                moonlight_enabled: false,
            },
            moonlight: MoonlightStreaming {
                resolution: "1920×1080".to_string(),
                refresh_rate: "60 Hz".to_string(),
                bitrate: 40,
                codec: "Auto".to_string(),
                fullscreen: true,
                fps_overlay: false,
                gamepad: true,
                mouse_smoothing: false,
            },
            fullscreen: Fullscreen {
                suppress_explorer: false,
                auto_fullscreen: false,
            },
        }
    }
}

pub struct SettingsState(pub Mutex<Settings>);

impl SettingsState {
    /// Loads settings from disk, falling back to defaults.
    pub fn load(app: &AppHandle) -> Self {
        let settings = read_settings(app).unwrap_or_default();
        Self(Mutex::new(settings))
    }

    fn config_file(app: &AppHandle) -> PathBuf {
        app.path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("moonblast-config"))
            .join("settings.json")
    }
}

fn read_settings(app: &AppHandle) -> Option<Settings> {
    let path = SettingsState::config_file(app);
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Settings>(&raw).ok()
}

fn save_settings(app: &AppHandle, settings: &Settings) -> std::io::Result<()> {
    let path = SettingsState::config_file(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Atomic write: write to a temp file, then rename over the target.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(settings)?)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    settings: Settings,
) -> Settings {
    {
        let mut current = state.0.lock().unwrap();
        *current = settings.clone();
    }
    let _ = save_settings(&app, &settings);
    let _ = app.emit("settings-changed", &settings);
    settings
}