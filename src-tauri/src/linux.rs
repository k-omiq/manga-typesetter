//! Process environment fixes for the Linux builds. Everything here runs before
//! Tauri creates a window, because WebKitGTK reads these variables once, on
//! first use, and never again.
//!
//! The AppImage deliberately bundles no GTK or WebKitGTK (see
//! scripts/build-appimage.sh), so there is nothing to pin here: the UI
//! process, WebKit's helper processes and its injected bundle all come from the
//! host and are always one version.

// Compiled under `test` on every OS for the unit tests; only Linux calls it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::env;
use std::path::Path;

pub fn prepare() {
    avoid_nvidia_dmabuf(Path::new("/proc/driver/nvidia/version"));
}

/// WebKitGTK 2.42+ renders through DMA-BUF by default, and the NVIDIA
/// proprietary driver takes that path down: a blank window, or the web
/// process aborting in the GL layer. WebKit's own switch turns the renderer
/// off; nouveau and every other driver keep the fast path. A value the user
/// already set, even `0`, is left alone.
///
/// `/proc/driver/nvidia/version` exists only while the proprietary module is
/// loaded, which is exactly the case that breaks.
fn avoid_nvidia_dmabuf(nvidia_marker: &Path) {
    if env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        return;
    }
    if nvidia_marker.exists() {
        env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        log::info!("NVIDIA proprietary driver present, WebKit DMA-BUF renderer disabled");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    // The tests share one process environment.
    static ENV: Mutex<()> = Mutex::new(());

    fn marker(exists: bool) -> std::path::PathBuf {
        let p = env::temp_dir().join(format!("mt-nvidia-marker-{}-{exists}", std::process::id()));
        if exists {
            fs::write(&p, "NVRM version: 550").unwrap();
        } else {
            let _ = fs::remove_file(&p);
        }
        p
    }

    #[test]
    fn the_proprietary_driver_turns_the_dmabuf_renderer_off() {
        let _g = ENV.lock().unwrap();
        env::remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
        avoid_nvidia_dmabuf(&marker(true));
        assert_eq!(env::var("WEBKIT_DISABLE_DMABUF_RENDERER").as_deref(), Ok("1"));
        env::remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
    }

    #[test]
    fn other_drivers_keep_the_default_renderer() {
        let _g = ENV.lock().unwrap();
        env::remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
        avoid_nvidia_dmabuf(&marker(false));
        assert!(env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none());
    }

    #[test]
    fn a_value_the_user_set_is_left_alone() {
        let _g = ENV.lock().unwrap();
        env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "0");
        avoid_nvidia_dmabuf(&marker(true));
        assert_eq!(env::var("WEBKIT_DISABLE_DMABUF_RENDERER").as_deref(), Ok("0"));
        env::remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
    }
}
