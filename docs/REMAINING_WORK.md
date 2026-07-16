# Remaining & planned work

Status snapshot as of the latest `main` (`569a3f8`). Phases 0–4 are implemented
and merged; this doc tracks what's left, known limitations, and future ideas.
Nothing here is a blocker — the app builds (`vite build`, `cargo check`) and the
core pipeline (detect → clean → translate → typeset → export) works.

## Shipped (for context)

- **Phase 0–1** — Python sidecar lifecycle + mokuro-based detection/OCR (comic-text-detector + manga-ocr) + panel-aware RTL reading order.
- **Phase 2** — Smart per-region cleaning as editable patch layers. Policy: solid-colour surround → OpenCV fill; textured → **AI redraw (FLUX)** with Telea/NS fallback.
- **Phase 3** — BYOK LLM translation reusing MangaTranslator's provider set.
- **Phase 4** — Manual brush tools (Fill / Clone / Paint / Erase), Bake/Flatten, PSD layered lossless round-trip.
- **Settings panel** — installs the opt-in FLUX model (deps + weights); model-cache size/clear, default export directory, and sidecar restart (see P2 #5).
- **Translation options** — input language, reading direction, and reasoning effort are wired from `TranslateControls.svelte` through to `/translate` (see P2 #4).
- Cross-repo audit fixes: sidecar event-loop offload, parent-death watchdog, health early-bail, 401 auth, random token, brush page-pinning/undo, clone sharpness, importer/PSD hygiene.

---

## P1 — Worth doing next

### 1. FLUX inference speed on Apple Silicon
`~37 s/step × 4 ≈ 2.5–3 min per textured region` on MPS. Root cause: **Triton
has no Apple-Silicon backend** (no macOS/arm64 wheel; SDNQ falls back to eager),
so this can't be fixed with a kernel compiler. Practical levers:
- **Quality ↔ speed setting — landed.** A Fast/Balanced/Quality control in
  Settings drives `num_inference_steps` (2/4/8) and `upscale_small_crops`
  (Fast skips the ~1 MP upscale of small crops). Fast is ~2× fewer steps and
  skips the upscale, roughly halving time for some quality loss. Persisted in the
  model selection; a change restarts `mt-flux`. Remaining lever: a finer target-
  megapixel cap would need a MangaTranslator patch (no direct constructor knob).
- Consider fp16 (non-SDNQ) on MPS if RAM allows (~8 GB for the 4B) — may be
  faster per-op by skipping dequant, at a memory cost.
- Optional: offload FLUX to a CUDA endpoint (where Triton works) — architectural.
  A "quality ↔ speed" (resolution/steps) setting fits naturally alongside the new
  Settings model picker, applied when constructing the inpainter.
- Files: `python/flux_sidecar/inpainter.py`, `python/sidecar/flux.py`,
  `external/MangaTranslator/core/image/inpainting.py`.

### 2. HF token pass-through for model downloads — done (folded into the FLUX rework)
FLUX weight downloads hit HuggingFace anonymous rate limits. The Settings panel
now has an HF-token field (shown for gated repos like Klein 9B); the token is
persisted (`~/.mangatypesetter/hf-token`), passed to the inpainter via
`huggingface_token=` in both the external `mt-flux` spawn and the in-process dev
path. Files: `python/sidecar/flux.py`, `python/flux_sidecar/`, `src/lib/SettingsModal.svelte`.

### 3. Full desktop end-to-end verification
Everything was verified via the browser preview + direct Python/Rust checks, but
the packaged **Tauri app** (`npm run tauri dev` / a real bundle) was never run in
this environment. Before release, manually verify on real hardware:
- Detect → Clean (with FLUX installed) → Translate → Export on a real page.
- **FLUX out-of-process path (new):** the packaged "Download & Install" provisions
  the external uv venv; `mt-flux` spawns and serves under it; the bundled
  `uv` / `flux_sidecar` / `MangaTranslator` resolve from `_MEIPASS` (and `uv`
  keeps its exec bit); a genuine FLUX redraw completes through the UI for a chosen
  model + quant; switching the model restarts `mt-flux`. See
  [FLUX_PACKAGING.md](FLUX_PACKAGING.md).
- FLUX auto-redraw of a genuinely textured region through the app UI.
- PSD lossless round-trip opened in actual Photoshop.

---

## P2 — Feature gaps

_Items 4 and 5 are done (see "Shipped" above); the remaining candidates below
are follow-ups gated on the P1 work._

### 5a. Settings panel — remaining candidates
The panel now covers the FLUX model + sidecar status, model-cache size/clear,
default export directory, and sidecar restart. Still to add once their P1
siblings land: the **HF token field** (P1 #2) and the **FLUX speed / quality**
setting (P1 #1). A **theme** toggle is also a nice-to-have (the app is dark-only
today).
- File: `src/lib/SettingsModal.svelte`.

---

## P3 — Low-severity / cosmetic (from audits)

Items 2–6 are **done** (this hardening pass); item 1 was investigated and left
as-is deliberately, with the rationale recorded below.

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
  build (P1 #3). Not worth the export-regression risk for a cosmetic tightening;
  the credential-dir deny list already covers the real exposure.

### 2. Brush FLUX checkbox — fixed
`src/lib/CleanPanel.svelte`. The brush **Fill** FLUX toggle now shows an explicit
"Installing…" state (disabled + spinner) during the multi-minute install and
reconciles to real availability on completion/failure (a failed install ends
unchecked, not falsely on).

### 3. Detector model auto-download total cap — fixed
`python/sidecar/detect.py`. Added an overall wall-clock cap
(`MT_DOWNLOAD_DEADLINE`, default 300 s) around the streamed loop, so a stalled
mirror raises a clear `TimeoutError` instead of hanging the first `/analyze`. The
stream now writes to a `.part` temp that's renamed on success (no truncated model
left behind that would later read as "already present").

### 4. FLUX "not installed" vs "install broken" — fixed
`python/sidecar/flux.py`, `src/lib/sidecar.js`, `src/lib/SettingsModal.svelte`.
`status()` now returns a `state` (`ready` / `deps_missing` / `import_error` /
`not_vendored`) by probing the real import chain (not just `find_spec`), so a
broken install (present but failing to import) is reported distinctly from "just
not installed". Settings shows "Install broken" + the failing reason and offers a
"Repair install" action.

### 5. Dev sidecar path resolution — fixed
`src-tauri/src/sidecar.rs`. The dev branch now resolves `python/` against the
crate (`CARGO_MANIFEST_DIR`) and, failing that, walks up from the cwd for a
`python/sidecar` package — it no longer assumes cwd = `src-tauri/`. The prod
(bundled) path is unchanged.

### 6. Child stdout capture — fixed
`src-tauri/src/sidecar.rs`. The sidecar child's stdout is now piped to the log
(same reader-thread pattern as stderr), so uvicorn/startup lines are visible in
windowed release builds.

---

## P4 — Future / nice-to-have

- ~~**Dynamic sidecar port** instead of hardcoded 8765.~~ **Done.** Each spawn now
  binds `127.0.0.1:0` to grab an OS-assigned free port (`free_port` in
  `src-tauri/src/sidecar.rs`), stores it in the managed `Sidecar` state, passes it
  via `MT_SIDECAR_PORT` (already read by `python/sidecar/config.py`), and reads it
  back in `base_url()` so every proxy command targets the right port — no more
  clash with a stale/other instance on 8765 (kept only as a fallback if the OS
  won't hand one out). Verified: sidecar started on an OS-assigned port answers
  `/health` and a token-gated proxied call; the full path through the packaged
  Tauri app still wants a desktop run (see P1 #3).
- ~~**Windows sidecar watchdog** — the parent-death watchdog is POSIX-only.~~
  **Done (needs Windows verification).** `python/sidecar/__main__.py` now has a
  Windows path: `_watch_parent_windows` opens a `SYNCHRONIZE` handle to the parent
  by PID (via ctypes/`kernel32`) once and blocks on `WaitForSingleObject`, exiting
  the sidecar when that handle signals. Holding the handle pins the process
  object, so PID reuse after the parent exits can't fool it. POSIX behaviour is
  unchanged (verified: child exits rc 0 within ~2 s of parent death). The Windows
  branch **cannot be exercised in this macOS environment** (`WinDLL` is
  unavailable) — **manually verify on Windows** that killing the host app tears
  the sidecar down. The Job-Object-from-Rust approach (`KILL_ON_JOB_CLOSE`) is
  noted in the code as the heavier but more crash-robust alternative if the
  handle-wait proves insufficient.
- ~~**Prod bundling of the FLUX path** — weights are multi-GB and opt-in; decide
  caching/first-run UX for packaged builds.~~ **Built & documented** in
  [FLUX_PACKAGING.md](FLUX_PACKAGING.md). FLUX now runs **out of process** in a
  separate `mt-flux` sidecar under an **external, uv-provisioned** venv, so a
  packaged build *can* install and run it (into a real interpreter, not the frozen
  app) — the old `installable=false` / "run from source" limitation is gone. The
  Settings panel exposes a **model picker** (family / variant / backend / quant +
  HF token) matching MangaTranslator, and "Download & Install" provisions the env
  with a bundled `uv`. Weights are still never bundled (stream lazily); the
  torch/diffusers stack lives in the user-provisioned env, not the base app. New:
  `python/flux_sidecar/`, `python/sidecar/{flux,flux_proxy,flux_models}.py`;
  `build-sidecar.sh` stages `uv` + `flux_sidecar` into the onedir. Verified here
  by import/HTTP-contract/provisioning tests; a real packaged build still needs
  on-target verification (P1 #3).
- ~~**CI** — no automated build/test pipeline; the checks in this repo are
  manual.~~ **Done.** `.github/workflows/ci.yml` runs on push to `main` / PR /
  manual dispatch, with three jobs: **frontend** (`npm ci` + `npx vite build`),
  **rust** (`cargo check` + `cargo clippy -D warnings`, with the Tauri Linux
  system deps installed so the webkit/gtk sys-crates link), and **python**
  (installs the base `requirements.txt` + httpx/pytest and runs
  `python -c "import sidecar.main"` plus `python/tests/test_smoke.py` — import,
  `/health`, and the token gate). It deliberately skips the heavy ML stack and the
  `external/` vendor trees; the smoke test passes with base deps only because the
  ML imports are lazy inside the route handlers. Verified locally: vite build,
  clippy `-D warnings`, and the smoke tests all green in a base-only venv with
  `external/` absent.

---

## Known limitations (by design / environment)

- **FLUX is opt-in and heavy** — classical fill/inpaint is the always-available
  default; FLUX needs a ~5 GB model + is slow on Apple Silicon (see P1-1). It runs
  out of process in a separate uv-provisioned env (see [FLUX_PACKAGING.md](FLUX_PACKAGING.md)).
- **ML features need the desktop app** — the browser preview no-ops the sidecar
  gracefully (manual workflows only).
- **Model weights are not committed** — cached under `python/models/`
  (gitignored); they download on first use.
