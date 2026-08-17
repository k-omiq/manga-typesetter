//! Engine state and the Tauri commands that replace the sidecar's HTTP routes.
//!
//! Three ONNX graphs live behind one mutex, each loaded the first time something
//! needs it. Loading is expensive — the OCR encoder alone is 343 MB — and the
//! app's own use is one page at a time, so a mutex over the whole set is both
//! simpler and closer to what the Python sidecar did (module-level singletons
//! behind the GIL) than any finer-grained scheme.
//!
//! What the mutex must *not* do is swallow a first-run download. The weights are
//! ~640 MB fetched over the network, and a user who opens Settings while that is
//! happening should still get an answer. So the download runs on the async side,
//! before the lock is taken, and the blocking section only ever reads files that
//! are already on disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use ort::ep::ExecutionProvider;
use ort::session::Session;
use tauri::async_runtime::Mutex as AsyncMutex;

use super::analyze::{analyze, decode_image, AnalyzeResponse};
use super::ocr::OcrEngine;
use super::panels;
use super::textdetector::TextDetector;

/// A weight file: where it lives under the model directory, and where it comes
/// from if it is not there yet.
struct ModelFile {
    rel: &'static str,
    url: &'static str,
}

const PANEL_MODEL: ModelFile = ModelFile {
    rel: "manga109_yolo_l_yv11.onnx",
    url: "https://huggingface.co/deepghs/manga109_yolo/resolve/main/v2023.12.07_l_yv11/model.onnx",
};
const TEXT_DETECTOR: ModelFile = ModelFile {
    rel: "comictextdetector.onnx",
    url: "https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx",
};
const OCR_FILES: [ModelFile; 3] = [
    ModelFile {
        rel: "manga-ocr/encoder_model.onnx",
        url: "https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/encoder_model.onnx",
    },
    ModelFile {
        rel: "manga-ocr/decoder_model.onnx",
        url: "https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/decoder_model.onnx",
    },
    ModelFile {
        rel: "manga-ocr/vocab.txt",
        url: "https://huggingface.co/kha-white/manga-ocr-base/resolve/main/vocab.txt",
    },
];

/// The directory every downloaded weight lives under, relative to `$HOME`.
///
/// Also the guard `detect_models_cache_clear` checks before it deletes anything;
/// see [`guard_models_dir`].
const MODELS_SUFFIX: [&str; 2] = [".mangatypesetter", "models"];

/// Wall-clock cap on a single first-run download.
///
/// An HTTP read timeout only bounds the gap between chunks, so a mirror that
/// dribbles bytes — or one that stalls just often enough to reset the read clock
/// — can hang a detect forever. This bounds the whole transfer. `MT_DOWNLOAD_DEADLINE`
/// overrides it, in seconds, as it does on the Python side.
fn download_deadline() -> Duration {
    let secs = std::env::var("MT_DOWNLOAD_DEADLINE")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| *v > 0.0)
        .unwrap_or(300.0);
    Duration::from_secs_f64(secs)
}

#[derive(Default)]
struct Sessions {
    detector: Option<TextDetector>,
    panels: Option<Session>,
    ocr: Option<OcrEngine>,
}

struct Inner {
    models_dir: PathBuf,
    sessions: Mutex<Sessions>,
    /// One gate per weight file, created on demand. See [`DetectEngine::ensure`].
    downloads: Mutex<HashMap<&'static str, Arc<AsyncMutex<()>>>>,
}

/// Lazily-loaded detection models, shared across commands.
///
/// Cloning is cheap and is how a command hands the engine to a blocking task:
/// `tauri::State` borrows for the life of the call, which is shorter than the
/// `'static` a spawned task needs.
#[derive(Clone)]
pub struct DetectEngine(Arc<Inner>);

impl DetectEngine {
    pub fn new(models_dir: PathBuf) -> DetectEngine {
        DetectEngine(Arc::new(Inner {
            models_dir,
            sessions: Mutex::new(Sessions::default()),
            downloads: Mutex::new(HashMap::new()),
        }))
    }

    pub fn models_dir(&self) -> &Path {
        &self.0.models_dir
    }

    /// Take the session lock, recovering it if an earlier call panicked while
    /// holding it.
    ///
    /// `Mutex::lock` returns `Err` *forever* once a holder has panicked, and
    /// every call site here used to answer that with `if let Ok` or a bare
    /// error — so one panic in `analyze_blocking` bricked detection until the
    /// app was restarted, with no way back short of that. Poisoning tells us
    /// only that the `Sessions` may be half-built, which is entirely
    /// recoverable: throw the graphs away and let the next call reload them.
    ///
    /// The `bool` is "this call is the one that found the poison", so exactly
    /// one caller reports the panic and later ones get a working engine
    /// instead of inheriting a stale error.
    fn lock_sessions(&self) -> (MutexGuard<'_, Sessions>, bool) {
        match self.0.sessions.lock() {
            Ok(guard) => (guard, false),
            Err(poisoned) => {
                self.0.sessions.clear_poison();
                let mut guard = poisoned.into_inner();
                *guard = Sessions::default();
                (guard, true)
            }
        }
    }

    /// Fetch any of `files` that is not on disk yet.
    ///
    /// Deliberately not holding the session mutex: this can take minutes on a
    /// cold machine, and a `detect_models_cache` call arriving meanwhile has no
    /// reason to wait for it.
    ///
    /// It does hold a per-file gate, because two detects racing a cold cache
    /// would otherwise both pull the same 343 MB. The loser wakes up, re-checks
    /// the path, and finds the file already there. The gate is per file rather
    /// than one global lock so an OCR download cannot delay the panel model.
    async fn ensure(&self, files: &[&ModelFile]) -> Result<(), String> {
        for f in files {
            let path = self.0.models_dir.join(f.rel);
            if path.is_file() {
                continue;
            }
            let gate = {
                let mut map = self.0.downloads.lock().unwrap_or_else(|e| e.into_inner());
                Arc::clone(map.entry(f.rel).or_default())
            };
            let _held = gate.lock().await;
            if path.is_file() {
                continue;
            }
            download(f.url, &path).await?;
        }
        Ok(())
    }

    /// Run one page through the pipeline, loading whatever it needs first.
    ///
    /// Blocking: hold this on a blocking thread, not the async runtime.
    fn analyze_blocking(&self, bytes: &[u8], want_ocr: bool) -> Result<AnalyzeResponse, String> {
        let img = decode_image(bytes)?;
        let dir = &self.0.models_dir;
        let (mut s, recovered) = self.lock_sessions();
        if recovered {
            // Reported once, by the call that cleared it. The graphs have been
            // dropped, so retrying this same page is the right next move — and
            // silently succeeding here would hide that a page took the engine
            // down, which is the sort of thing that wants a bug report.
            return Err("the detection engine panicked on an earlier page and has been \
                        reset; retry this page"
                .to_string());
        }

        if s.detector.is_none() {
            s.detector = Some(
                TextDetector::load(&dir.join(TEXT_DETECTOR.rel))
                    .map_err(|e| format!("failed to load the text detector: {e}"))?,
            );
        }
        if s.panels.is_none() {
            // Best-effort, as `detect_panels` is in the Python: without panels
            // the reading order falls back to a spatial sort rather than failing.
            match panels::load_session(&dir.join(PANEL_MODEL.rel)) {
                Ok(session) => s.panels = Some(session),
                Err(e) => log::warn!("panel model unavailable, reading order degrades: {e}"),
            }
        }
        if want_ocr && s.ocr.is_none() {
            s.ocr = Some(
                OcrEngine::load(&dir.join("manga-ocr"))
                    .map_err(|e| format!("failed to load the OCR models: {e}"))?,
            );
        }

        let Sessions { detector, panels, ocr } = &mut *s;
        let detector = detector.as_mut().expect("loaded above");
        analyze(
            &img,
            detector,
            panels.as_mut(),
            if want_ocr { ocr.as_mut() } else { None },
        )
    }
}

/// A scratch path for one download of `path`, unique to this call.
///
/// The suffix is appended, not substituted: `with_extension` would turn
/// `vocab.txt` into `vocab.part` and collide with any other `vocab.*`.
///
/// And it carries a per-call serial, because a fixed `<file>.part` is a shared
/// mutable path. Two cold-start detects that both decided the weight was
/// missing would open the same scratch file and interleave their bytes into it;
/// whichever finished first would then rename the resulting mixture into place,
/// and every later run would read a corrupt ONNX graph as "already present".
/// The serial is process-local — a second process could still collide, so the
/// pid goes in too.
fn part_path(path: &Path) -> PathBuf {
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let n = SERIAL.fetch_add(1, Ordering::Relaxed);
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".{}.{n}.part", std::process::id()));
    PathBuf::from(tmp)
}

/// Move a finished download into place, taking the scratch file with it.
///
/// Every exit leaves no `.part` behind: a failed rename used to skip the
/// cleanup that only the transfer-error path had, so a full disk or a
/// permissions problem littered hundreds of megabytes that nothing would ever
/// collect.
///
/// A file already at `path` means another download of the same weight won the
/// race. Its bytes are these bytes, and it may already be open in a loaded
/// session, so the loser drops its copy rather than renaming over it.
fn commit_download(tmp: &Path, path: &Path) -> Result<(), String> {
    if path.is_file() {
        let _ = std::fs::remove_file(tmp);
        return Ok(());
    }
    match std::fs::rename(tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(tmp);
            Err(format!("{}: {e}", path.display()))
        }
    }
}

/// Stream one weight file to disk.
///
/// Written to a scratch sibling and renamed on success, so an interrupted or
/// timed-out download cannot leave a truncated file that the next run reads as
/// "already present" — which would then fail as a corrupt ONNX graph, a long way
/// from the cause.
///
/// The writing happens on a blocking thread rather than inline. These are
/// hundreds of megabytes, and `File::write_all` plus a final `sync_all` are
/// syscalls that park the calling thread — inline, that thread is a Tokio
/// worker, and every other async task sharing it stalls behind the disk. The
/// bounded channel is the backpressure: it caps how far ahead of the disk the
/// network is allowed to buffer.
async fn download(url: &str, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let tmp = part_path(path);
    let deadline = Instant::now() + download_deadline();

    // `Vec<u8>` rather than reqwest's `Bytes`, which would move without a copy
    // but is a type this crate cannot name without taking a dependency on
    // `bytes` for one channel. A memcpy per chunk is nothing beside the write
    // it is queueing for.
    let (tx, mut rx) = tauri::async_runtime::channel::<Vec<u8>>(8);
    let writer = {
        let tmp = tmp.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            use std::io::Write;
            let mut file =
                std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
            while let Some(chunk) = rx.blocking_recv() {
                file.write_all(&chunk).map_err(|e| format!("{}: {e}", tmp.display()))?;
            }
            file.sync_all().map_err(|e| format!("{}: {e}", tmp.display()))
        })
    };

    let streamed = async {
        let mut resp = reqwest::Client::new()
            .get(url)
            .timeout(download_deadline())
            .send()
            .await
            .map_err(|e| format!("{url}: {e}"))?
            .error_for_status()
            .map_err(|e| format!("{url}: {e}"))?;

        // `chunk()` rather than `bytes_stream()`: the same streaming, without
        // pulling the `stream` feature and `futures-util` in for one loop.
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("{url}: {e}"))? {
            if Instant::now() > deadline {
                return Err(format!(
                    "download exceeded {:.0}s (stalled mirror?): {url}",
                    download_deadline().as_secs_f64()
                ));
            }
            if tx.send(chunk.to_vec()).await.is_err() {
                // The only way the receiver hangs up is a write error, and it
                // is holding the message that says which. Stop feeding it and
                // let the join below report the real cause.
                break;
            }
        }
        Ok(())
    }
    .await;

    // Closing the channel is what ends the writer's loop, so it has to happen
    // before the join whatever the transfer did.
    drop(tx);
    let written = writer
        .await
        .map_err(|e| format!("download writer failed: {e}"))
        .and_then(|r| r);

    match streamed.and(written) {
        Ok(()) => commit_download(&tmp, path),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// `~/.mangatypesetter/models`, the one directory this module owns.
pub fn default_models_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(MODELS_SUFFIX[0]).join(MODELS_SUFFIX[1])
}

// ---------------------------------------------------------------------------
// Cache inspection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CacheEntry {
    pub path: String,
    pub exists: bool,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CacheInfo {
    pub entries: Vec<CacheEntry>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CacheClear {
    pub ok: bool,
    pub cleared: Vec<String>,
    pub freed_bytes: u64,
    pub errors: Vec<String>,
}

/// Total bytes of a directory tree, best-effort.
///
/// Symlinks are counted as links, not followed: the target may be shared with
/// something outside the cache, and reporting its size as reclaimable would be
/// a lie. Unreadable entries are skipped rather than aborting the walk, so a
/// permissions problem in one corner still yields a useful number.
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.path().symlink_metadata() else { continue };
        if meta.is_dir() {
            total += dir_size(&entry.path());
        } else {
            total += meta.len();
        }
    }
    total
}

pub fn cache_info(models_dir: &Path) -> CacheInfo {
    let resolved = models_dir.canonicalize().unwrap_or_else(|_| models_dir.to_path_buf());
    let exists = resolved.is_dir();
    let bytes = if exists { dir_size(&resolved) } else { 0 };
    CacheInfo {
        entries: vec![CacheEntry { path: resolved.display().to_string(), exists, bytes }],
        total_bytes: bytes,
    }
}

/// Refuse to delete anything that is not the model cache.
///
/// `clear` is an `rm -rf` driven from the UI, so the path it is handed is
/// checked rather than trusted: it is resolved through symlinks first and then
/// required to end in `.mangatypesetter/models`. A misconfigured or
/// maliciously-set model directory should fail this, not take the user's home
/// with it.
fn guard_models_dir(dir: &Path) -> Result<PathBuf, String> {
    let resolved = dir
        .canonicalize()
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut tail = resolved.components().rev().take(2).collect::<Vec<_>>();
    tail.reverse();
    let names: Vec<String> = tail.iter().map(|c| c.as_os_str().to_string_lossy().into()).collect();
    if names != MODELS_SUFFIX {
        return Err(format!(
            "refusing to clear {}: not a {}/{} directory",
            resolved.display(),
            MODELS_SUFFIX[0],
            MODELS_SUFFIX[1]
        ));
    }
    Ok(resolved)
}

pub fn cache_clear(models_dir: &Path) -> CacheClear {
    let mut out = CacheClear { ok: true, cleared: Vec::new(), freed_bytes: 0, errors: Vec::new() };
    if !models_dir.is_dir() {
        // Nothing there is a success, and the directory is recreated below so
        // the next detect has somewhere to download into.
        let _ = std::fs::create_dir_all(models_dir);
        return out;
    }
    let resolved = match guard_models_dir(models_dir) {
        Ok(p) => p,
        Err(e) => {
            out.ok = false;
            out.errors.push(e);
            return out;
        }
    };
    let size = dir_size(&resolved);
    match std::fs::remove_dir_all(&resolved) {
        Ok(()) => {
            out.freed_bytes = size;
            out.cleared.push(resolved.display().to_string());
        }
        Err(e) => {
            out.ok = false;
            out.errors.push(format!("{}: {e}", resolved.display()));
        }
    }
    let _ = std::fs::create_dir_all(&resolved);
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Detect text blocks (+ optional OCR) and panels on one page.
#[tauri::command]
pub async fn detect_analyze(
    state: tauri::State<'_, DetectEngine>,
    image: Vec<u8>,
    ocr: bool,
) -> Result<AnalyzeResponse, String> {
    let engine = state.inner().clone();
    let mut needed: Vec<&ModelFile> = vec![&TEXT_DETECTOR, &PANEL_MODEL];
    if ocr {
        needed.extend(OCR_FILES.iter());
    }
    engine.ensure(&needed).await?;

    tauri::async_runtime::spawn_blocking(move || engine.analyze_blocking(&image, ocr))
        .await
        .map_err(|e| format!("analyze task failed: {e}"))?
}

/// On-disk size + location of the downloaded model weights (Settings panel).
#[tauri::command]
pub async fn detect_models_cache(
    state: tauri::State<'_, DetectEngine>,
) -> Result<CacheInfo, String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache_info(engine.models_dir()))
        .await
        .map_err(|e| format!("cache task failed: {e}"))
}

/// Delete the downloaded weights to free disk. They re-download lazily.
#[tauri::command]
pub async fn detect_models_cache_clear(
    state: tauri::State<'_, DetectEngine>,
) -> Result<CacheClear, String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Drop the loaded graphs first: they are the deleted files, and keeping
        // them would report freed disk the process is still holding open.
        //
        // Held *across* the delete, not released before it. Unlocking first
        // left a window in which a concurrent `detect_analyze` — already past
        // `ensure`, so past the point where it checks the files exist — took
        // the free lock and started loading ONNX graphs out of the directory
        // `remove_dir_all` was walking. Now it waits, and reloads afterwards
        // from a directory that is simply empty.
        let (mut s, _) = engine.lock_sessions();
        *s = Sessions::default();
        let out = cache_clear(engine.models_dir());
        drop(s);
        out
    })
    .await
    .map_err(|e| format!("cache-clear task failed: {e}"))
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Health {
    pub status: String,
    pub device: String,
    pub engine: String,
}

/// What the detection engine is and what it is running on.
///
/// `device` reports whether ONNX Runtime can offer CoreML at all — which on this
/// build is exactly what every `load_session` asks for. It is not a promise that
/// a given graph ran there: the OCR decoder is deliberately CPU-only because
/// CoreML recompiles per input shape and that graph grows a token every step,
/// and any session may silently fall back if an operator is unsupported.
#[tauri::command]
pub async fn detect_health() -> Result<Health, String> {
    let device = match ort::ep::CoreML::default().is_available() {
        Ok(true) => "coreml",
        _ => "cpu",
    };
    Ok(Health {
        status: "ok".into(),
        device: device.into(),
        engine: "onnx-rust".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mt-engine-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn the_default_model_dir_is_under_the_users_home() {
        let d = default_models_dir();
        assert!(d.ends_with(".mangatypesetter/models"), "{}", d.display());
    }

    #[test]
    fn cache_info_reports_a_missing_directory_as_empty() {
        let root = scratch("missing");
        let info = cache_info(&root.join("models"));
        assert_eq!(info.entries.len(), 1);
        assert!(!info.entries[0].exists);
        assert_eq!(info.total_bytes, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_info_sums_a_tree_including_subdirectories() {
        let root = scratch("sizes");
        std::fs::write(root.join("a.onnx"), vec![0u8; 1000]).unwrap();
        std::fs::create_dir_all(root.join("manga-ocr")).unwrap();
        std::fs::write(root.join("manga-ocr/b.onnx"), vec![0u8; 234]).unwrap();
        let info = cache_info(&root);
        assert!(info.entries[0].exists);
        assert_eq!(info.total_bytes, 1234);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_clear_guard_rejects_a_directory_that_is_not_the_model_cache() {
        // The whole point of the guard: this function is one `remove_dir_all`
        // away from a user's home directory, driven by a button in Settings.
        let root = scratch("guard");
        let wrong = root.join("Documents");
        std::fs::create_dir_all(&wrong).unwrap();
        assert!(guard_models_dir(&wrong).is_err());

        let nearly = root.join(".mangatypesetter").join("model");
        std::fs::create_dir_all(&nearly).unwrap();
        assert!(guard_models_dir(&nearly).is_err(), "one letter off must not pass");

        let shallow = root.join("models");
        std::fs::create_dir_all(&shallow).unwrap();
        assert!(guard_models_dir(&shallow).is_err(), "the parent must match too");

        let right = root.join(".mangatypesetter").join("models");
        std::fs::create_dir_all(&right).unwrap();
        assert!(guard_models_dir(&right).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_a_guarded_directory_empties_it_and_recreates_it() {
        let root = scratch("clear");
        let models = root.join(".mangatypesetter").join("models");
        std::fs::create_dir_all(models.join("manga-ocr")).unwrap();
        std::fs::write(models.join("a.onnx"), vec![7u8; 500]).unwrap();
        std::fs::write(models.join("manga-ocr/b.onnx"), vec![7u8; 100]).unwrap();

        let out = cache_clear(&models);
        assert!(out.ok, "{out:?}");
        assert_eq!(out.freed_bytes, 600);
        assert_eq!(out.cleared.len(), 1);
        assert!(models.is_dir(), "the directory must survive for the next download");
        assert_eq!(cache_info(&models).total_bytes, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_a_directory_that_fails_the_guard_deletes_nothing() {
        let root = scratch("clear-guard");
        let wrong = root.join("Pictures");
        std::fs::create_dir_all(&wrong).unwrap();
        std::fs::write(wrong.join("holiday.png"), vec![1u8; 10]).unwrap();

        let out = cache_clear(&wrong);
        assert!(!out.ok);
        assert_eq!(out.cleared, Vec::<String>::new());
        assert_eq!(out.freed_bytes, 0);
        assert!(wrong.join("holiday.png").exists(), "the file must still be there");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_a_missing_cache_succeeds_and_creates_it() {
        let root = scratch("clear-missing");
        let models = root.join(".mangatypesetter").join("models");
        let out = cache_clear(&models);
        assert!(out.ok);
        assert_eq!(out.freed_bytes, 0);
        assert!(models.is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_download_deadline_honours_its_override() {
        // Not parallel-safe against other env readers, so it sets, reads and
        // restores in one place rather than relying on test isolation.
        let prev = std::env::var("MT_DOWNLOAD_DEADLINE").ok();
        std::env::set_var("MT_DOWNLOAD_DEADLINE", "12.5");
        assert_eq!(download_deadline(), Duration::from_secs_f64(12.5));
        std::env::set_var("MT_DOWNLOAD_DEADLINE", "not a number");
        assert_eq!(download_deadline(), Duration::from_secs(300));
        match prev {
            Some(v) => std::env::set_var("MT_DOWNLOAD_DEADLINE", v),
            None => std::env::remove_var("MT_DOWNLOAD_DEADLINE"),
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn this_build_reports_coreml_as_its_device() {
        // The `coreml` feature is on in Cargo.toml, so a "cpu" here means the
        // runtime was linked without it and every session is silently falling
        // back — which shows up as a several-times-slower detect and nothing
        // else. Worth one assertion.
        assert!(ort::ep::CoreML::default().is_available().unwrap_or(false));
    }

    #[test]
    fn two_downloads_of_one_file_never_share_a_scratch_path() {
        // The bug this pins: a fixed `<file>.part` meant two cold-start
        // detects wrote into the same file and renamed the interleaving into
        // place as a "valid" weight.
        let path = PathBuf::from("/models/manga-ocr/encoder_model.onnx");
        let a = part_path(&path);
        let b = part_path(&path);
        assert_ne!(a, b);
        for p in [&a, &b] {
            let s = p.to_string_lossy();
            assert!(s.starts_with("/models/manga-ocr/encoder_model.onnx."), "{s}");
            assert!(s.ends_with(".part"), "{s}");
        }
        // And the suffix is appended rather than substituted, so two weights
        // that differ only by extension still cannot collide.
        let txt = part_path(Path::new("/models/vocab.txt"));
        let onnx = part_path(Path::new("/models/vocab.onnx"));
        assert!(txt.to_string_lossy().contains("vocab.txt."), "{}", txt.display());
        assert!(onnx.to_string_lossy().contains("vocab.onnx."), "{}", onnx.display());
    }

    #[test]
    fn committing_a_download_moves_it_and_leaves_no_scratch_file() {
        let root = scratch("commit");
        let tmp = root.join("model.onnx.1.part");
        let dest = root.join("model.onnx");
        std::fs::write(&tmp, b"weights").unwrap();

        assert!(commit_download(&tmp, &dest).is_ok());
        assert!(!tmp.exists(), "the scratch file must not survive");
        assert_eq!(std::fs::read(&dest).unwrap(), b"weights");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_loser_of_a_download_race_drops_its_copy_rather_than_replacing_the_winners() {
        // Same bytes either way, but the winner's file may already be open in
        // a loaded session, so renaming over it buys nothing and risks a lot.
        let root = scratch("commit-race");
        let tmp = root.join("model.onnx.2.part");
        let dest = root.join("model.onnx");
        std::fs::write(&tmp, b"mine").unwrap();
        std::fs::write(&dest, b"theirs").unwrap();

        assert!(commit_download(&tmp, &dest).is_ok());
        assert!(!tmp.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"theirs");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_commit_still_cleans_up_the_scratch_file() {
        // The leak: cleanup used to live only on the transfer-error path, so a
        // rename that failed left the whole download on disk forever. A
        // directory at the destination is the cheapest way to make rename fail.
        let root = scratch("commit-fail");
        let tmp = root.join("model.onnx.3.part");
        let dest = root.join("model.onnx");
        std::fs::write(&tmp, vec![0u8; 64]).unwrap();
        std::fs::create_dir_all(dest.join("occupied")).unwrap();

        assert!(commit_download(&tmp, &dest).is_err());
        assert!(!tmp.exists(), "a failed rename must not leak the scratch file");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_panic_under_the_session_lock_is_reported_once_and_then_recovered() {
        // Before: one panic in `analyze_blocking` poisoned the mutex and every
        // later command's `if let Ok` silently did nothing, so detection was
        // dead until the app restarted.
        let engine = DetectEngine::new(scratch("poison"));
        let other = engine.clone();
        let panicked = std::thread::spawn(move || {
            let _guard = other.0.sessions.lock().unwrap();
            panic!("pretend a graph blew up mid-load");
        })
        .join();
        assert!(panicked.is_err(), "the helper thread was supposed to panic");
        assert!(engine.0.sessions.is_poisoned());

        let (guard, recovered) = engine.lock_sessions();
        assert!(recovered, "the first caller after a panic must be told about it");
        drop(guard);

        let (guard, recovered) = engine.lock_sessions();
        assert!(!recovered, "later callers must get a working engine, not a stale error");
        drop(guard);
        assert!(!engine.0.sessions.is_poisoned());
        assert!(engine.0.sessions.lock().is_ok());
        let _ = std::fs::remove_dir_all(engine.models_dir());
    }

    #[test]
    fn every_model_url_is_https() {
        // These are the only outbound requests the app makes, and the reqwest
        // dependency grew a TLS backend for them; if one ever regressed to
        // plain http that backend would be silently unused.
        let all: Vec<&ModelFile> =
            [&PANEL_MODEL, &TEXT_DETECTOR].into_iter().chain(OCR_FILES.iter()).collect();
        for f in all {
            assert!(f.url.starts_with("https://"), "{}", f.url);
            assert!(!f.rel.starts_with('/') && !f.rel.contains(".."), "{}", f.rel);
        }
    }
}
