mod detect;
mod memory;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    // The in-process ONNX engine — the whole of detection and OCR. It replaced
    // the Python sidecar outright: there is no child process to spawn, health-
    // poll or kill any more.
    .manage(detect::engine::DetectEngine::new(detect::engine::default_models_dir()))
    .invoke_handler(tauri::generate_handler![
      detect::engine::detect_analyze,
      detect::engine::detect_models_cache,
      detect::engine::detect_models_cache_clear,
      detect::engine::detect_health,
      memory::process_memory
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
