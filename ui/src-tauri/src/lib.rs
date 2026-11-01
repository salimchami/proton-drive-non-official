mod daemon;
mod update;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use daemon::DaemonClient;

/// Forwards a protocol request (without id) to the daemon.
#[tauri::command]
async fn daemon_request(client: State<'_, Arc<DaemonClient>>, request: Value) -> Result<Value, String> {
    client.request(request).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(DaemonClient::default()))
        .invoke_handler(tauri::generate_handler![daemon_request])
        .setup(|app| {
            let client = app.state::<Arc<DaemonClient>>().inner().clone();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { client.run(handle).await });

            // Linux trays emit no click events: everything goes through the menu.
            let open = MenuItem::with_id(app, "open", "Open drive-sync", true, None::<&str>)?;
            let folder = MenuItem::with_id(app, "folder", "Open synced folder", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &folder, &quit])?;
            TrayIconBuilder::new()
                .icon(themed_icon().unwrap_or_else(|| app.default_window_icon().expect("bundle icon").clone()))
                .tooltip("drive-sync")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "folder" => open_synced_folder(app.clone()),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        // Closing the window keeps the app in the tray; the daemon syncs regardless.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Icon name in the hicolor theme, as installed by the package (see the desktop entry).
const ICON_NAME: &str = "drive-sync-ui";

/// The app icon from the user's or the system's hicolor theme, so a user override in
/// ~/.local/share/icons applies to the tray as it does to the application menu.
fn themed_icon() -> Option<Image<'static>> {
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    let data_dirs = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    data_home
        .into_iter()
        .chain(data_dirs.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from))
        .flat_map(|dir| {
            ["256x256", "128x128", "512x512", "32x32"]
                .map(|size| dir.join("icons/hicolor").join(size).join("apps").join(format!("{ICON_NAME}.png")))
        })
        .find_map(|path| Image::from_path(path).ok())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn open_synced_folder(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = app.state::<Arc<DaemonClient>>().inner().clone();
        if let Ok(status) = client.request(json!({ "method": "status" })).await {
            if let Some(local_root) = status["settings"]["localRoot"].as_str() {
                let _ = app.opener().open_path(local_root, None::<&str>);
            }
        }
    });
}
