mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .manage(sidecar::new_state())
    .invoke_handler(tauri::generate_handler![
      sidecar::sidecar_health,
      sidecar::sidecar_analyze,
      sidecar::sidecar_clean,
      sidecar::sidecar_flux_status,
      sidecar::sidecar_flux_download
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      sidecar::spawn(app.handle());
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // Kill the sidecar child when the app exits.
      if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
        app.state::<sidecar::Sidecar>().shutdown();
      }
    });
}
