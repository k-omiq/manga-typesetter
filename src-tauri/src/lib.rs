// `pub` because the `.sut` parser and its scorer are reachable from the crate's
// tests as well as from the `brush_import` command below.
pub mod brush;
mod detect;
mod durability;
mod memory;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    // In-process ONNX engine for detection and OCR.
    .manage(detect::engine::DetectEngine::new(detect::engine::default_models_dir()))
    .invoke_handler(tauri::generate_handler![
      detect::engine::detect_analyze,
      detect::engine::detect_models_cache,
      detect::engine::detect_models_cache_clear,
      detect::engine::detect_health,
      brush::brush_import,
      memory::process_memory,
      durability::fsync_path
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
