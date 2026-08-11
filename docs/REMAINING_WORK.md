# Remaining & planned work

Status snapshot for the typesetter-only app. The scope is deliberately narrow:
**import → detect/OCR → typeset → export**. Image cleaning (OpenCV/FLUX inpaint,
brush tools, patch layers) and machine translation were removed — the app
consumes already-cleaned pages and text you supply, and its job is putting that
text on the page well.

The app builds (`vite build`, `cargo check`) and the sidecar serves
`/health`, `/analyze` and the model-cache routes.

## Shipped (for context)

- **Python sidecar** — lifecycle (spawn, health, parent-death watchdog, dynamic
  loopback port, token auth) + mokuro-based detection/OCR (comic-text-detector +
  manga-ocr) with panel-aware RTL reading order.
- **Typesetting** — place/text tools, per-box style (font, outline, shadow,
  roughen, curve, flip, rotation), bulk style apply, text queue, inspector.
- **Import** — numbered-text JSON (tolerant of several shapes), cleaned/raw
  images, layered PSD (lossless when exported here, best-effort for foreign
  files).
- **Export** — PNG / JPG / WebP at native resolution, layered editable **PSD**
  (Text group + Base group, full project embedded as XMP JSON for a lossless
  round-trip), and **JSON** of the detected text + geometry.

---

## P1 — Worth doing next

### 1. Full desktop end-to-end verification
Checks here are the browser preview plus direct Python/Rust runs; the packaged
**Tauri app** (`npm run tauri dev` / a real bundle) still wants a pass on real
hardware:
- Detect → typeset → export on a real chapter.
- PSD lossless round-trip opened in actual Photoshop.
- JSON text export re-imported through **Import JSON**.

### 2. Re-detect preserves typesetting
`applyDetection` clears `p.boxes`, so re-running Detect on a page discards boxes
you already placed. It should reconcile by line number instead.
- File: `src/lib/store.svelte.js`.

---

## P2 — Feature gaps

### 1. Settings panel
Covers sidecar status/restart, model-cache size/clear and the default export
directory. A **theme** toggle is a nice-to-have (the app is dark-only today).
- File: `src/lib/SettingsModal.svelte`.

### 2. Auto-place from detection
Detection geometry (`p.detect.boxes`) is stored and exported but only used
manually. Placing a text box per detected region — sized and positioned from the
detected bbox — would remove most of the click work.

---

## P3 — Low-severity / cosmetic (from audits)

### 1. fs scope stays `allow: "**"` — deliberate (investigated)
`src-tauri/capabilities/default.json` keeps the broad `allow: "**"` (with the
credential-dir deny list). Investigated whether Tauri v2's dialog plugin
runtime-grants fs access to user-picked paths, which would let the static scope
narrow to the standard trees (`$HOME`, `$DOWNLOAD`, `$DESKTOP`, `$DOCUMENT`,
`$TEMP`). It does **not**:
- In Tauri v2 the dialog plugin returns a path but grants no fs scope. The fs
  scope is static (capabilities) unless extended at runtime in Rust via
  `tauri_plugin_fs::FsExt` (`app.fs_scope().allow_file` / `allow_directory`); a
  path outside the static scope fails `writeFile` with a *forbidden path* error.
  (Tauri v2 fs-plugin docs; tauri-apps/tauri discussion #9195, issue #12704.)
- Our export flow (`saveNative` in `src/lib/exporter.js`) calls the JS `save()` /
  `open()` dialog and then `writeFile` directly — the picked path never reaches
  Rust, so nothing can `FsExt`-grant it. Narrowing to the standard trees would
  break save-anywhere export (external drives `/Volumes/**`, any non-standard
  root), which is the whole point of the picker.
- Doing it safely would mean routing the picked path through a Rust command that
  calls `FsExt::allow_directory` before the write, then verifying on a packaged
  build (P1 #1). Not worth the export-regression risk for a cosmetic tightening;
  the credential-dir deny list already covers the real exposure.

### 2. Detector model auto-download total cap — fixed
`python/sidecar/detect.py`. An overall wall-clock cap (`MT_DOWNLOAD_DEADLINE`,
default 300 s) wraps the streamed loop, so a stalled mirror raises a clear
`TimeoutError` instead of hanging the first `/analyze`. The stream writes to a
`.part` temp that's renamed on success (no truncated model left behind that
would later read as "already present").

### 3. Dev sidecar path resolution — fixed
`src-tauri/src/sidecar.rs`. The dev branch resolves `python/` against the crate
(`CARGO_MANIFEST_DIR`) and, failing that, walks up from the cwd for a
`python/sidecar` package — it no longer assumes cwd = `src-tauri/`. The prod
(bundled) path is unchanged.

### 4. Child stdout capture — fixed
`src-tauri/src/sidecar.rs`. The sidecar child's stdout is piped to the log (same
reader-thread pattern as stderr), so uvicorn/startup lines are visible in
windowed release builds.

---

## P4 — Future / nice-to-have

- ~~**Dynamic sidecar port** instead of hardcoded 8765.~~ **Done.** Each spawn
  binds `127.0.0.1:0` to grab an OS-assigned free port (`free_port` in
  `src-tauri/src/sidecar.rs`), stores it in the managed `Sidecar` state, passes
  it via `MT_SIDECAR_PORT` (read by `python/sidecar/config.py`), and reads it
  back in `base_url()` so every proxy command targets the right port — no more
  clash with a stale/other instance on 8765 (kept only as a fallback if the OS
  won't hand one out).
- ~~**Windows sidecar watchdog** — the parent-death watchdog is POSIX-only.~~
  **Done (needs Windows verification).** `python/sidecar/__main__.py` has a
  Windows path: `_watch_parent_windows` opens a `SYNCHRONIZE` handle to the
  parent by PID (via ctypes/`kernel32`) once and blocks on
  `WaitForSingleObject`, exiting the sidecar when that handle signals. Holding
  the handle pins the process object, so PID reuse after the parent exits can't
  fool it. POSIX behaviour is unchanged (verified: child exits rc 0 within ~2 s
  of parent death). The Windows branch **cannot be exercised on macOS**
  (`WinDLL` is unavailable) — **manually verify on Windows** that killing the
  host app tears the sidecar down.
- ~~**CI**~~ **Done.** `.github/workflows/ci.yml` runs on push to `main` / PR /
  manual dispatch, with three jobs: **frontend** (`npm ci` + `npx vite build`),
  **rust** (`cargo check` + `cargo clippy -D warnings`, with the Tauri Linux
  system deps installed so the webkit/gtk sys-crates link), and **python**
  (installs the base `requirements.txt` + httpx/pytest and runs
  `python -c "import sidecar.main"` plus `python/tests/test_smoke.py` — import,
  `/health`, and the token gate). It deliberately skips the heavy ML stack and
  the `external/` vendor tree; the smoke test passes with base deps only because
  the ML imports are lazy inside the route handlers.

---

## Known limitations (by design / environment)

- **Cleaning is out of scope** — the app typesets on pages you have already
  cleaned (import them as *Cleaned*, or work directly over the raw).
- **Translation is out of scope** — bring text in via **Import JSON**, or type it
  straight into a box.
- **Detection needs the desktop app** — the browser preview no-ops the sidecar
  gracefully (manual workflows only).
- **Model weights are not committed** — cached under `~/.mangatypesetter/models`
  by default; they download on first Detect.
