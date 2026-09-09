// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // `--probe-device <provider>`: the child half of the detection device probe.
  // The parent always passes a name; a bare flag probes nothing and exits,
  // which is the safe reading - it must never fall through and open a window.
  let mut args = std::env::args().skip(1);
  if args.next().as_deref() == Some(app_lib::PROBE_FLAG) {
    app_lib::probe_device_main(args.next().unwrap_or_default().as_str());
    return;
  }
  app_lib::run();
}
