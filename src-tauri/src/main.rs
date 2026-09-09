// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Winlogon runs us with `--shell` when Moonblast has replaced the Windows
    // desktop. That mode is a tiny supervisor, not the app: handle it before any
    // Tauri/WebView setup (and before the single-instance plugin) so it stays
    // cheap and can't be blocked by an already-running launcher.
    if std::env::args().skip(1).any(|a| a == "--shell") {
        tauri_app_lib::run_shell_stub();
    }
    tauri_app_lib::run()
}
