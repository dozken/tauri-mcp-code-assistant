use serde::Serialize;

/// Shown in the sidebar footer so bug reports carry the build they came from.
#[derive(Serialize)]
pub struct AppInfo {
    version: String,
    platform: String,
    /// Where the webview should reach the NestJS backend.
    backend_url: String,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        // Overridable so a packaged build can point at a bundled sidecar on
        // another port without rebuilding the frontend.
        backend_url: std::env::var("COMPANION_BACKEND_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:3001".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Powers the native "Add folder" picker in the sidebar.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
