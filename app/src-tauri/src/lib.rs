use std::net::TcpListener;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Shown in the sidebar footer so bug reports carry the build they came from.
#[derive(Serialize)]
pub struct AppInfo {
    version: String,
    platform: String,
    /// Where the webview should reach the NestJS backend.
    backend_url: String,
}

/// The backend this window talks to, and the process serving it.
///
/// A packaged app has to bring its own backend: telling the user to start one in
/// a terminal is not a desktop app. The sidecar is a single executable with the
/// Node runtime inside it, so there is nothing to install and nothing to compile.
struct Backend {
    url: String,
    /// `None` in development, where the backend is already running from `npm run dev`.
    child: Mutex<Option<CommandChild>>,
}

impl Backend {
    /// Stops the child. Idempotent, because exit can be reached more than one way.
    fn stop(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

/// A port nobody is using, by asking the OS for one and letting it go.
///
/// There is a race between closing this and the child binding it, and it is the
/// standard one: the alternative is a fixed port, and 3001 is exactly the port a
/// developer already has something on.
fn free_port() -> Option<u16> {
    TcpListener::bind("127.0.0.1:0")
        .ok()?
        .local_addr()
        .ok()
        .map(|address| address.port())
}

/// Starts the bundled backend and returns where it is listening.
///
/// Only in a release build. `tauri dev` runs against the backend that `npm run dev`
/// already started, and spawning a second one would index into a different
/// database and answer on a different port.
fn start_backend(app: &tauri::AppHandle) -> Backend {
    if let Ok(url) = std::env::var("COMPANION_BACKEND_URL") {
        return Backend {
            url,
            child: Mutex::new(None),
        };
    }

    let fallback = "http://127.0.0.1:3001".to_string();
    if cfg!(debug_assertions) {
        return Backend {
            url: fallback,
            child: Mutex::new(None),
        };
    }

    let Some(port) = free_port() else {
        return Backend {
            url: fallback,
            child: Mutex::new(None),
        };
    };

    // Its own directory under the OS's app-data location: a packaged app must not
    // write its database next to wherever it happened to be launched from.
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("ai-code-companion"));
    let _ = std::fs::create_dir_all(&data_dir);

    let spawned = app
        .shell()
        .sidecar("companion-backend")
        .and_then(|command| {
            command
                .env("PORT", port.to_string())
                .env("HOST", "127.0.0.1")
                // A clean quit stops the child below; a crash or a `kill -9` never
                // runs that code, and an orphaned backend holds a port and a database
                // with no window to show for it. The child watches the pipe instead.
                .env("COMPANION_EXIT_WITH_PARENT", "1")
                .env(
                    "METADATA_DB",
                    data_dir
                        .join("metadata.sqlite")
                        .to_string_lossy()
                        .to_string(),
                )
                .env(
                    "COMPANION_TOKEN_FILE",
                    data_dir.join("token").to_string_lossy().to_string(),
                )
                .spawn()
        });

    match spawned {
        Ok((_events, child)) => Backend {
            url: format!("http://127.0.0.1:{port}"),
            child: Mutex::new(Some(child)),
        },
        Err(error) => {
            // Better a window that says it cannot reach a backend than one that
            // never opens: the user may well have one running already.
            eprintln!("could not start the bundled backend: {error}");
            Backend {
                url: fallback,
                child: Mutex::new(None),
            }
        }
    }
}

#[tauri::command]
fn app_info(backend: State<'_, Backend>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        backend_url: backend.url.clone(),
    }
}

/// Registers the updater, but only in a build that was given one to use.
///
/// `plugins.updater` in `tauri.conf.json` carries the public key updates are
/// verified against, and the plugin refuses to initialise without it — so
/// registering it unconditionally would break every build that has not been
/// through `npm run updater:enable`. Compiled in, inert until configured: that is
/// what lets turning it on be a configuration change rather than a code change.
#[cfg(desktop)]
fn register_updater(handle: &tauri::AppHandle) {
    if !handle.config().plugins.0.contains_key("updater") {
        return;
    }

    if let Err(error) = handle.plugin(tauri_plugin_updater::Builder::new().build()) {
        // Not fatal: an app that cannot check for updates is still an app, and
        // refusing to start over it would be the worse failure.
        eprintln!("the updater is configured but did not load: {error}");
        return;
    }

    // Restarting into the new version is half of applying an update, and on macOS
    // and Linux nothing else does it.
    if let Err(error) = handle.plugin(tauri_plugin_process::init()) {
        eprintln!("the process plugin did not load, so no restart after an update: {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Powers the native "Add folder" picker in the sidebar.
        .plugin(tauri_plugin_dialog::init())
        // Registered for the Rust side only: the sidecar is started here, and the
        // webview is granted no shell permission at all.
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![app_info])
        .setup(|app| {
            let backend = start_backend(app.handle());
            app.manage(backend);
            #[cfg(desktop)]
            register_updater(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the tauri application");

    app.run(|handle, event| {
        // Both, because a window close and a quit arrive differently, and a backend
        // that outlives its window is a process the user cannot see or stop.
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            handle.state::<Backend>().stop();
        }
    });
}
