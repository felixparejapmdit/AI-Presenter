//! Vanguard Deck native backend: hardware inspection, the Ollama bridge and
//! local project storage.

mod hardware;
mod ollama;
mod storage;

use std::time::Duration;

use tauri::Manager;
use tauri_plugin_fs::FsExt;
use tauri_plugin_sql::{Migration, MigrationKind};

fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_projects_and_settings",
        sql: "CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
              );
              CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
              );",
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .manage(ollama::OllamaState::new())
        .setup(|app| {
            let root = storage::resolve_data_dir(app.handle())?;
            std::fs::create_dir_all(root.join("projects"))?;

            // The default scope in tauri.conf.json covers $DATA/vanguard-deck.
            // Extending it here also covers a VANGUARD_DATA_DIR override.
            app.asset_protocol_scope()
                .allow_directory(&root, true)
                .map_err(|e| format!("asset scope: {e}"))?;
            app.fs_scope()
                .allow_directory(&root, true)
                .map_err(|e| format!("fs scope: {e}"))?;

            let db_url = storage::database_url(&root);
            app.handle().plugin(
                tauri_plugin_sql::Builder::new()
                    .add_migrations(&db_url, migrations())
                    .build(),
            )?;
            app.manage(storage::StorageState { root, db_url });

            // The window starts hidden so the first frame the user sees is fully
            // painted. The frontend reveals it; this guards against a frontend
            // failure leaving an invisible window behind.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(6)).await;
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hardware::get_hardware_specs,
            ollama::check_ollama_status,
            ollama::list_local_models,
            ollama::pull_model_stream,
            ollama::cancel_model_pull,
            ollama::analyze_script_to_slides,
            ollama::analyze_image_pin,
            ollama::cancel_analysis,
            ollama::launch_ollama_serve,
            storage::get_storage_info,
            storage::save_image_asset,
            storage::import_image_from_path,
            storage::read_asset_base64,
            storage::write_project_snapshot,
            storage::delete_project_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vanguard Deck");
}
