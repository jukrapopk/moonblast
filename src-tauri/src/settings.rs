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
    pub machines: Vec<MoonlightHost>,
    #[serde(default)]
    pub app_shortcuts: Vec<AppShortcut>,
    pub customization: Customization,
}

/// TopBar system-status visibility. All default on; `show_battery` is
/// additionally gated in the UI on battery hardware being present.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Customization {
    #[serde(default = "default_true")]
    pub show_time: bool,
    #[serde(default = "default_true")]
    pub show_date: bool,
    #[serde(default = "default_true")]
    pub show_wifi: bool,
    #[serde(default = "default_true")]
    pub show_battery: bool,
    #[serde(default = "default_true")]
    pub show_audio: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Customization {
    fn default() -> Self {
        Self {
            show_time: true,
            show_date: true,
            show_wifi: true,
            show_battery: true,
            show_audio: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoonlightHost {
    pub name: String,
    pub address: String,
}

/// A user-curated app in the Apps tab.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppShortcut {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub source: String, // "" | "Store" | "Steam"
    #[serde(default = "default_kind")]
    pub kind: String, // "exe" | "store" | "steam"
    #[serde(default)]
    pub display_name: Option<String>, // None/empty → use `name`
    #[serde(default)]
    pub custom_icon: Option<String>,
    #[serde(default)]
    pub use_desktop_icon: bool,
    #[serde(default)]
    pub steamgrid_icon: Option<String>,
}

fn default_kind() -> String {
    "exe".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct General {
    pub start_with_windows: bool,
    #[serde(default = "default_last_view")]
    pub last_view: String,
}

fn default_last_view() -> String {
    "apps".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Integrations {
    pub moonlight_folder: Option<String>,
    pub moonlight_enabled: bool,
    pub apps_enabled: bool,
    pub steamgrid_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MoonlightStreaming {
    // Retained / legacy fields (kept so existing settings.json loads cleanly).
    pub resolution: String, // "WxH", or "auto" = detect client display
    pub refresh_rate: String, // "60 Hz", or "auto" = detect client display
    pub bitrate: f64, // Mbps (0.5–500) — slider 1–100, modal for outside
    pub codec: String, // "Auto" | "H.264" | "HEVC" | "AV1"
    pub fullscreen: bool, // legacy
    pub fps_overlay: bool, // maps to --performance-overlay
    pub gamepad: bool, // legacy
    pub mouse_smoothing: bool, // legacy

    // Video / display
    pub aspect_ratio: String, // "16:9" | "16:10" | "21:9" | "32:9" | "4:3" | "5:4"
    pub display_mode: String, // "fullscreen" | "windowed" | "borderless"
    pub video_decoder: String, // "auto" | "software" | "hardware"
    pub vsync: bool,
    pub hdr: bool,
    pub yuv444: bool,
    pub frame_pacing: bool,
    pub packet_size: Option<u32>, // bytes (>1024)
    pub keep_awake: bool,
    pub quit_after: bool,
    pub game_optimization: bool,

    // Audio
    pub audio_config: String, // "stereo" | "5.1-surround" | "7.1-surround"
    pub audio_on_host: bool,
    pub mute_on_focus_loss: bool,

    // Input
    pub multi_controller: bool,
    pub background_gamepad: bool,
    pub swap_gamepad_buttons: bool,
    pub absolute_mouse: bool,
    pub mouse_buttons_swap: bool,
    pub reverse_scroll_direction: bool,
    pub capture_system_keys: String, // "never" | "fullscreen" | "always"
}

impl Default for MoonlightStreaming {
    fn default() -> Self {
        Self {
            resolution: "auto".to_string(),
            refresh_rate: "auto".to_string(),
            bitrate: 40.0,
            codec: "Auto".to_string(),
            fullscreen: true,
            fps_overlay: false,
            gamepad: true,
            mouse_smoothing: false,
            aspect_ratio: "16:9".to_string(),
            display_mode: "fullscreen".to_string(),
            video_decoder: "auto".to_string(),
            vsync: true,
            hdr: false,
            yuv444: false,
            frame_pacing: true,
            packet_size: None,
            keep_awake: true,
            quit_after: false,
            game_optimization: true,
            audio_config: "stereo".to_string(),
            audio_on_host: false,
            mute_on_focus_loss: true,
            multi_controller: true,
            background_gamepad: false,
            swap_gamepad_buttons: false,
            absolute_mouse: false,
            mouse_buttons_swap: false,
            reverse_scroll_direction: false,
            capture_system_keys: "never".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fullscreen {
    pub suppress_explorer: bool,
    pub auto_fullscreen: bool,
    /// Sign in straight into Moonblast: registers the launcher as the Windows
    /// shell (see `shell.rs`) and enters Immersive Mode on that boot.
    #[serde(default)]
    pub auto_immersive: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            general: General {
                start_with_windows: false,
                last_view: "apps".to_string(),
            },
            integrations: Integrations {
                moonlight_folder: None,
                moonlight_enabled: false,
                apps_enabled: true,
                steamgrid_key: None,
            },
            moonlight: MoonlightStreaming::default(),
            fullscreen: Fullscreen {
                suppress_explorer: false,
                auto_fullscreen: false,
                auto_immersive: false,
            },
            machines: Vec::new(),
            app_shortcuts: Vec::new(),
            customization: Customization::default(),
        }
    }
}

pub struct SettingsState(pub Mutex<Settings>);

impl SettingsState {
    /// Loads settings from disk, falling back to defaults.
    pub fn load(app: &AppHandle) -> Self {
        // One-time migration from the old Roaming (`app_config_dir`) location.
        migrate_from_roaming(app);
        let settings = read_settings(app).unwrap_or_default();
        Self(Mutex::new(settings))
    }

    // All Moonblast persistent data lives in one Local folder (Windows:
    // `%LOCALAPPDATA%\<identifier>` via `app_data_dir`). `settings.json` sits at
    // the root; the `.icons` icon cache is a sibling folder under the same root
    // (see lib.rs icon_cache_dir).
    fn config_file(app: &AppHandle) -> PathBuf {
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("moonblast-local"))
            .join("settings.json")
    }
}

/// Copy `settings.json` from the legacy Roaming (`app_config_dir`) location into
/// the new Local location if the new one doesn't exist yet.
fn migrate_from_roaming(app: &AppHandle) {
    let new = SettingsState::config_file(app);
    if new.exists() {
        return;
    }
    let old = app
        .path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .ok()
        .filter(|p| p.exists());
    if let Some(old) = old {
        if let Some(parent) = new.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::copy(&old, &new);
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

/// Force `auto_immersive` off from Rust and persist it.
///
/// Used when a boot-time rescue (Shift held at sign-in, or the crash bail-out)
/// has already restored the normal shell: the stored intent would otherwise
/// disagree with reality and silently re-arm the takeover on the next launch.
pub fn disable_auto_immersive(app: &AppHandle, state: &SettingsState) {
    let updated = {
        let mut guard = state.0.lock().unwrap();
        guard.fullscreen.auto_immersive = false;
        guard.clone()
    };
    let _ = save_settings(app, &updated);
    let _ = app.emit("settings-changed", &updated);
}
