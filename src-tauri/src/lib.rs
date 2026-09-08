use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Tracks live Moonlight stream child processes so we never spawn a duplicate
/// window for the same host+app while one is already running.
pub struct StreamState(Mutex<HashMap<String, Child>>);

impl Default for StreamState {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

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
async fn tailscale_status() -> TailscaleInfo {
    // Offload the subprocess wait off the main thread so the UI never freezes.
    tauri::async_runtime::spawn_blocking(|| {
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
    })
    .await
    .unwrap_or(TailscaleInfo { status: "not-found".to_string() })
}

/// Bring Tailscale up or down. Only meaningful when the daemon is running.
#[tauri::command]
async fn tailscale_set(up: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
        let out = Command::new(&exe)
            .args(["list", &host])
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
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Launch Moonlight's pairing flow for a host and notify when it completes.
#[tauri::command]
fn moonlight_pair(
    app: tauri::AppHandle,
    host: String,
    state: State<'_, settings::SettingsState>,
) -> Result<(), String> {
    let exe = moonlight_exe(&state).ok_or("Moonlight executable not found")?;
    let child = Command::new(&exe)
        .args(["pair", &host])
        .spawn()
        .map_err(|e| e.to_string())?;
    // Wait for Moonlight's pairing process to finish (it exits once the user
    // completes pairing), then notify the frontend.
    std::thread::spawn(move || {
        let success = child
            .wait_with_output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let full_host = host.clone();
        let _ = app.emit(
            "pair-complete",
            serde_json::json!({ "host": full_host, "success": success }),
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
    let exe = moonlight_exe(&state).ok_or("Moonlight executable not found")?;
    let prefs = state.0.lock().unwrap().moonlight.clone();
    let key = format!("{host}\u{1f}{app}");
    let mut map = streams.0.lock().unwrap();
    // Reap any process that has already exited, and detect a still-running one.
    let already_running = match map.get_mut(&key) {
        Some(child) => match child.try_wait() {
            Ok(None) => true, // still streaming
            Ok(Some(_)) => {
                map.remove(&key);
                false
            } // finished — spawn a fresh one next
            Err(_) => false,
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
        .map_err(|e| e.to_string())?;
    map.insert(key, child);
    Ok(true)
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

fn probe_listapps(exe: &std::path::Path, host: &str) -> bool {
    let exe = exe.to_path_buf();
    let host = host.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let ok = Command::new(&exe)
            .args(["list", &host])
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
            app.manage(StreamState::default());
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
            discover_hosts,
            client_display
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}