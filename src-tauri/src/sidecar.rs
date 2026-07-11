//! Python sidecar lifecycle: spawn on startup, health-check, kill on exit.
//!
//! Dev: runs `python -m sidecar` from the repo's `python/.venv`.
//! Prod: runs the bundled `mt-sidecar` binary placed next to the app executable
//! (produced by PyInstaller; wired as a Tauri sidecar in a later phase).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;

use tauri::Manager;

/// Fallback loopback port, used only if allocating a free one fails. Each spawn
/// binds an OS-assigned free port (see `free_port`) and stores it in `Sidecar`,
/// so a stale/other instance holding this number no longer causes a clash.
pub const SIDECAR_PORT: u16 = 8765;

/// Managed state: the running child, the shared auth token, and the loopback
/// port the current child was told to bind (0 until the first spawn).
#[derive(Default)]
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    port: AtomicU16,
    pub token: String,
}

impl Sidecar {
    pub fn base_url(&self) -> String {
        let port = self.port.load(Ordering::Relaxed);
        format!("http://127.0.0.1:{port}")
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

    /// Liveness of the spawned child, without blocking:
    /// - `Some(true)`  — running
    /// - `Some(false)` — exited (spawn failed to stay up)
    /// - `None`        — never spawned (no python env / binary)
    pub fn child_running(&self) -> Option<bool> {
        let mut guard = self.child.lock().ok()?;
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(Some(_status)) => Some(false), // has exited
            Ok(None) => Some(true),           // still running
            Err(_) => Some(true),             // can't tell → assume alive
        }
    }
}

/// Unguessable loopback secret from the OS CSPRNG (falls back to time+pid only
/// if getrandom somehow fails). This gates /analyze, /clean, /translate — the
/// last of which forwards the user's BYOK API key — so it must not be
/// enumerable by another local process from launch time + pid.
fn make_token() -> String {
    let mut bytes = [0u8; 24];
    if getrandom::getrandom(&mut bytes).is_ok() {
        return bytes.iter().map(|b| format!("{b:02x}")).collect();
    }
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}{:x}", std::process::id())
}

/// Ask the OS for a currently-free loopback port by binding `:0` and reading the
/// assigned number back, then dropping the listener so the sidecar can claim it.
/// There's a tiny window where another process could grab it first; that only
/// means the child fails to bind and the health poll reports it — no orphan and
/// no silent clash, which is the whole point over a fixed port.
fn free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()?
        .local_addr()
        .ok()
        .map(|addr| addr.port())
}

/// Resolve how to launch the sidecar for the current build profile.
/// Returns a ready-to-spawn `Command` or `None` if no sidecar is available.
fn build_command(app: &tauri::AppHandle, token: &str, port: u16) -> Option<Command> {
    let exe = if cfg!(windows) {
        "mt-sidecar.exe"
    } else {
        "mt-sidecar"
    };

    // Prod: PyInstaller --onedir folder shipped via `bundle.resources`
    // (binaries/mt-sidecar/) and unpacked into the app's resource dir. The glob
    // preserves the relative path, so the binary lands at
    // <resources>/binaries/mt-sidecar/mt-sidecar.
    if let Ok(res_dir) = app.path().resource_dir() {
        let bin = res_dir.join("binaries").join("mt-sidecar").join(exe);
        if bin.exists() {
            let mut cmd = Command::new(bin);
            apply_env(&mut cmd, token, port);
            return Some(cmd);
        }
    }

    // Dev: python -m sidecar from python/.venv. The python project sits next to
    // the crate (../python), but we must not assume a particular cwd — the binary
    // can be launched from anywhere. Resolve against the crate dir first, then
    // fall back to walking up from the cwd, and only then to a resource-dir copy.
    let py_root = resource_python_dir(app)
        .or_else(crate_python_dir)
        .or_else(cwd_python_dir)?;

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
    apply_env(&mut cmd, token, port);
    Some(cmd)
}

/// Packaged copy of the python project unpacked into the app resource dir
/// (secondary to the bundled `mt-sidecar` binary; supports a prod layout that
/// ships the sources instead of the frozen binary).
fn resource_python_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("python");
    dir.exists().then_some(dir)
}

/// `<crate>/../python` — `CARGO_MANIFEST_DIR` is baked at compile time and points
/// at `src-tauri/`, so this resolves the sibling `python/` no matter what the cwd
/// is when the binary runs (the dev cwd is not guaranteed to be `src-tauri/`).
fn crate_python_dir() -> Option<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?.join("python");
    dir.exists().then_some(dir)
}

/// Last resort: walk up from the current dir looking for a `python/sidecar`
/// package. Covers running the binary from an unusual cwd on a machine whose
/// checkout layout differs from the build machine (stale `CARGO_MANIFEST_DIR`).
fn cwd_python_dir() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if dir.join("python").join("sidecar").is_dir() {
            return Some(dir.join("python"));
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn apply_env(cmd: &mut Command, token: &str, port: u16) {
    cmd.env("MT_SIDECAR_HOST", "127.0.0.1")
        .env("MT_SIDECAR_PORT", port.to_string())
        .env("MT_SIDECAR_TOKEN", token)
        // The sidecar's watchdog exits itself if this PID goes away, so a hard
        // app crash (no graceful shutdown) can't orphan it holding the port.
        .env("MT_SIDECAR_PARENT_PID", std::process::id().to_string());
}

/// Spawn the sidecar and store the child in managed state. Idempotent-ish: a
/// previous child is killed first.
pub fn spawn(app: &tauri::AppHandle) {
    let state = app.state::<Sidecar>();
    state.shutdown();

    // Pick a fresh free port for this child so we never clash with a stale
    // instance (or an unrelated process) squatting on a fixed number. Fall back
    // to the well-known default only if the OS won't hand one out.
    let port = free_port().unwrap_or(SIDECAR_PORT);
    state.port.store(port, Ordering::Relaxed);

    match build_command(app, &state.token, port) {
        Some(mut cmd) => {
            // Pipe stdout+stderr so startup lines (uvicorn "Application startup
            // complete", import errors, port already in use from an orphan) reach
            // the log instead of vanishing — in a windowed release build there's
            // no inherited console to see them.
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());
            match cmd.spawn() {
                Ok(mut child) => {
                    log::info!("sidecar spawned on port {port}");
                    if let Some(stdout) = child.stdout.take() {
                        std::thread::spawn(move || {
                            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                                log::info!("[sidecar] {line}");
                            }
                        });
                    }
                    if let Some(stderr) = child.stderr.take() {
                        std::thread::spawn(move || {
                            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                                log::warn!("[sidecar] {line}");
                            }
                        });
                    }
                    if let Ok(mut guard) = state.child.lock() {
                        *guard = Some(child);
                    }
                }
                Err(e) => log::error!("failed to spawn sidecar: {e}"),
            }
        }
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

    // Up to ~30s: the bundled onedir sidecar can take ~10s on a cold first run
    // (dylib load + macOS first-launch verification).
    let mut last_err = String::from("unreachable");
    for _ in 0..120 {
        // Bail immediately if the child never started or has already exited,
        // instead of polling a dead port for the full 30s.
        match state.child_running() {
            Some(false) => return Err("sidecar process exited during startup".into()),
            None => return Err("sidecar was not started (no python env or binary found)".into()),
            Some(true) => {}
        }
        match client
            .get(&url)
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
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

/// Proxy a page image to the sidecar `/clean` (smart per-region cleaning).
///
/// `regions` is the JSON array the frontend already holds from `/analyze`
/// (`[{n, box, method?}]`); `mask_png` is the base64 text mask from the same
/// call. `method` is the default OpenCV inpaint flavour for textured regions
/// ("telea"/"ns"); `flux` opts into the heavy FLUX path. Returns one patch
/// layer per region.
#[tauri::command]
pub async fn sidecar_clean(
    state: tauri::State<'_, Sidecar>,
    image: Vec<u8>,
    regions: String,
    mask_png: String,
    method: String,
    flux: bool,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/clean", state.base_url());
    let part = reqwest::multipart::Part::bytes(image).file_name("page.png");
    let form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("regions", regions)
        .text("mask_png", mask_png)
        .text("method", method)
        .text("flux", flux.to_string());

    let resp = reqwest::Client::new()
        .post(&url)
        .header("x-mt-token", &state.token)
        // FLUX cleaning can be slow; cap so a hung run can't block forever.
        .timeout(std::time::Duration::from_secs(1800))
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

/// Proxy a brush-inpaint request to the sidecar `/clean/brush`.
///
/// `image` is the current clean composite (raw + visible patches); `mask_png` is
/// the base64 painted alpha mask; `method` is the OpenCV inpaint flavour
/// ("telea"/"ns") and `flux` opts into the heavy path. Returns one patch layer.
#[tauri::command]
pub async fn sidecar_clean_brush(
    state: tauri::State<'_, Sidecar>,
    image: Vec<u8>,
    mask_png: String,
    method: String,
    flux: bool,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/clean/brush", state.base_url());
    let part = reqwest::multipart::Part::bytes(image).file_name("page.png");
    let form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("mask_png", mask_png)
        .text("method", method)
        .text("flux", flux.to_string());

    let resp = reqwest::Client::new()
        .post(&url)
        .header("x-mt-token", &state.token)
        // FLUX brush fill can be slow; cap so a hung run can't block forever.
        .timeout(std::time::Duration::from_secs(1800))
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

/// Report whether the opt-in FLUX inpainter can run on this machine.
#[tauri::command]
pub async fn sidecar_flux_status(
    state: tauri::State<'_, Sidecar>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/clean/flux-status", state.base_url());
    let resp = reqwest::Client::new()
        .get(&url)
        .header("x-mt-token", &state.token)
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

/// One-click install of the FLUX deps into the sidecar venv (heavy, opt-in).
#[tauri::command]
pub async fn sidecar_flux_download(
    state: tauri::State<'_, Sidecar>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/clean/flux-download", state.base_url());
    // pip install can take a while; allow a long timeout.
    let resp = reqwest::Client::new()
        .post(&url)
        .header("x-mt-token", &state.token)
        .timeout(std::time::Duration::from_secs(1800))
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

/// Report the on-disk size + location of the downloaded model caches.
#[tauri::command]
pub async fn sidecar_models_cache(
    state: tauri::State<'_, Sidecar>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/models/cache", state.base_url());
    let resp = reqwest::Client::new()
        .get(&url)
        .header("x-mt-token", &state.token)
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

/// Clear the downloaded model caches (frees disk; weights re-download lazily).
#[tauri::command]
pub async fn sidecar_models_cache_clear(
    state: tauri::State<'_, Sidecar>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/models/cache/clear", state.base_url());
    let resp = reqwest::Client::new()
        .post(&url)
        .header("x-mt-token", &state.token)
        // A multi-GB rmtree can take a moment; give it room.
        .timeout(std::time::Duration::from_secs(300))
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

/// Restart the sidecar child (kills the running one and respawns). Used by the
/// Settings "Restart sidecar" action; callers should re-poll /health afterwards.
#[tauri::command]
pub async fn sidecar_restart(app: tauri::AppHandle) -> Result<(), String> {
    spawn(&app);
    Ok(())
}

/// List the BYOK translation providers the sidecar supports (id + default model).
#[tauri::command]
pub async fn sidecar_translate_providers(
    state: tauri::State<'_, Sidecar>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/translate/providers", state.base_url());
    let resp = reqwest::Client::new()
        .get(&url)
        .header("x-mt-token", &state.token)
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

/// Proxy a translation request to the sidecar `/translate`. The BYOK API key
/// travels in the JSON body and stays loopback-local; the webview never talks to
/// the provider or the sidecar directly. `payload` =
/// { lines:[{n,type,jp}], provider, model, api_key, base_url?, ... }.
#[tauri::command]
pub async fn sidecar_translate(
    state: tauri::State<'_, Sidecar>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/translate", state.base_url());
    let resp = reqwest::Client::new()
        .post(&url)
        .header("x-mt-token", &state.token)
        .timeout(std::time::Duration::from_secs(300))
        .json(&payload)
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
        port: AtomicU16::new(0), // set on first spawn
        token: make_token(),
    }
}
