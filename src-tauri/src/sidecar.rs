//! Python sidecar lifecycle: spawn on startup, health-check, kill on exit.
//!
//! Dev: runs `python -m sidecar` from the repo's `python/.venv`.
//! Prod: runs the bundled `mt-sidecar` binary placed next to the app executable
//! (produced by PyInstaller; wired as a Tauri sidecar in a later phase).

use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

/// Loopback port the sidecar binds. Fixed for now; could become dynamic later.
pub const SIDECAR_PORT: u16 = 8765;

/// Managed state: the running child plus the shared auth token.
#[derive(Default)]
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    pub token: String,
}

impl Sidecar {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{SIDECAR_PORT}")
    }

    /// Best-effort kill of the child process.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Cheap, dependency-free token: hex of nanos since epoch + pid.
fn make_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}{:x}", std::process::id())
}

/// Resolve how to launch the sidecar for the current build profile.
/// Returns a ready-to-spawn `Command` or `None` if no sidecar is available.
fn build_command(app: &tauri::AppHandle, token: &str) -> Option<Command> {
    // Prod: bundled binary next to the executable.
    if let Ok(exe_dir) = std::env::current_exe().and_then(|p| {
        p.parent()
            .map(|d| d.to_path_buf())
            .ok_or_else(|| std::io::Error::other("no exe dir"))
    }) {
        let bin = exe_dir.join(if cfg!(windows) {
            "mt-sidecar.exe"
        } else {
            "mt-sidecar"
        });
        if bin.exists() {
            let mut cmd = Command::new(bin);
            apply_env(&mut cmd, token);
            return Some(cmd);
        }
    }

    // Dev: python -m sidecar from python/.venv next to the project root.
    // src-tauri/ is the cwd in dev; the python project sits at ../python.
    let py_root = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("python"))
        .filter(|d| d.exists())
        .or_else(|| {
            let dev = std::env::current_dir().ok()?.join("..").join("python");
            if dev.exists() {
                Some(dev)
            } else {
                None
            }
        })?;

    let py = py_root
        .join(".venv")
        .join(if cfg!(windows) { "Scripts" } else { "bin" })
        .join(if cfg!(windows) {
            "python.exe"
        } else {
            "python"
        });
    let py = if py.exists() {
        py
    } else {
        std::path::PathBuf::from("python") // fall back to PATH python
    };

    let mut cmd = Command::new(py);
    cmd.arg("-m").arg("sidecar").current_dir(&py_root);
    apply_env(&mut cmd, token);
    Some(cmd)
}

fn apply_env(cmd: &mut Command, token: &str) {
    cmd.env("MT_SIDECAR_HOST", "127.0.0.1")
        .env("MT_SIDECAR_PORT", SIDECAR_PORT.to_string())
        .env("MT_SIDECAR_TOKEN", token);
}

/// Spawn the sidecar and store the child in managed state. Idempotent-ish: a
/// previous child is killed first.
pub fn spawn(app: &tauri::AppHandle) {
    let state = app.state::<Sidecar>();
    state.shutdown();

    match build_command(app, &state.token) {
        Some(mut cmd) => match cmd.spawn() {
            Ok(child) => {
                log::info!("sidecar spawned on port {SIDECAR_PORT}");
                *state.child.lock().unwrap() = Some(child);
            }
            Err(e) => log::error!("failed to spawn sidecar: {e}"),
        },
        None => log::warn!("no sidecar binary or python env found; ML features disabled"),
    }
}

/// Poll the sidecar `/health` until it responds or the timeout elapses.
#[tauri::command]
pub async fn sidecar_health(
    state: tauri::State<'_, Sidecar>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/health", state.base_url());
    let client = reqwest::Client::new();

    let mut last_err = String::from("unreachable");
    for _ in 0..40 {
        match client.get(&url).send().await {
            Ok(resp) => match resp.json::<serde_json::Value>().await {
                Ok(v) => return Ok(v),
                Err(e) => last_err = e.to_string(),
            },
            Err(e) => last_err = e.to_string(),
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Err(last_err)
}

/// Proxy a page image to the sidecar `/analyze` (detection + OCR).
/// The token stays server-side; the webview never talks to the sidecar directly.
#[tauri::command]
pub async fn sidecar_analyze(
    state: tauri::State<'_, Sidecar>,
    image: Vec<u8>,
    ocr: bool,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/analyze?ocr={}", state.base_url(), ocr);
    let part = reqwest::multipart::Part::bytes(image).file_name("page.png");
    let form = reqwest::multipart::Form::new().part("image", part);

    let resp = reqwest::Client::new()
        .post(&url)
        .header("x-mt-token", &state.token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("sidecar {code}: {body}"));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Build the managed state (call once before `.manage`).
pub fn new_state() -> Sidecar {
    Sidecar {
        child: Mutex::new(None),
        token: make_token(),
    }
}
