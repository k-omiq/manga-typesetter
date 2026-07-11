# Remaining & planned work

Status snapshot as of the latest `main` (`27ac224`). Phases 0–4 are implemented
and merged; this doc tracks what's left, known limitations, and future ideas.
Nothing here is a blocker — the app builds (`vite build`, `cargo check`) and the
core pipeline (detect → clean → translate → typeset → export) works.

## Shipped (for context)

- **Phase 0–1** — Python sidecar lifecycle + mokuro-based detection/OCR (comic-text-detector + manga-ocr) + panel-aware RTL reading order.
- **Phase 2** — Smart per-region cleaning as editable patch layers. Policy: solid-colour surround → OpenCV fill; textured → **AI redraw (FLUX)** with Telea/NS fallback.
- **Phase 3** — BYOK LLM translation reusing MangaTranslator's provider set.
- **Phase 4** — Manual brush tools (Fill / Clone / Paint / Erase), Bake/Flatten, PSD layered lossless round-trip.
- **Settings panel** — installs the opt-in FLUX model (deps + weights).
- Cross-repo audit fixes: sidecar event-loop offload, parent-death watchdog, health early-bail, 401 auth, random token, brush page-pinning/undo, clone sharpness, importer/PSD hygiene.

---

## P1 — Worth doing next

### 1. FLUX inference speed on Apple Silicon
`~37 s/step × 4 ≈ 2.5–3 min per textured region` on MPS. Root cause: **Triton
has no Apple-Silicon backend** (no macOS/arm64 wheel; SDNQ falls back to eager),
so this can't be fixed with a kernel compiler. Practical levers:
- **Cap the inpaint working resolution** (biggest win). The inpainter upscales
  each region to ~1 MP (`1056×976`) before diffusing; running at ~0.25 MP would
  be ~4× faster for some quality loss. Needs checking whether
  `FluxKleinInpainter` exposes a target-resolution/megapixel knob, then a
  "quality ↔ speed" setting in the UI.
- Consider fp16 (non-SDNQ) on MPS if RAM allows (~8 GB for the 4B) — may be
  faster per-op by skipping dequant, at a memory cost.
- Optional: offload FLUX to a CUDA endpoint (where Triton works) — architectural.
- Files: `python/sidecar/flux.py`, `external/MangaTranslator/core/image/inpainting.py`.

### 2. HF token pass-through for model downloads
FLUX weight downloads hit HuggingFace anonymous rate limits (stalled until an
`HF_TOKEN` was supplied manually). The app has no way to provide one.
- Read `HF_TOKEN` / a Settings field in `flux.load_inpainter()` and pass
  `huggingface_token=` to `FluxKleinInpainter`; forward the env from Rust
  (`apply_env`) like the other `MT_*` vars.
- Add an optional token field to the Settings panel.
- Files: `python/sidecar/flux.py`, `src-tauri/src/sidecar.rs`, `src/lib/SettingsModal.svelte`.

### 3. Full desktop end-to-end verification
Everything was verified via the browser preview + direct Python/Rust checks, but
the packaged **Tauri app** (`npm run tauri dev`) was never run in this
environment. Before release, manually verify on real hardware:
- Detect → Clean (with FLUX installed) → Translate → Export on a real page.
- FLUX auto-redraw of a genuinely textured region through the app UI.
- PSD lossless round-trip opened in actual Photoshop.
- The Settings "Download & Install" button end-to-end (deps + weights).

---

## P2 — Feature gaps

### 4. Translation options not wired to the UI
The sidecar `/translate` accepts `input_language`, `reading_direction`, and
`reasoning_effort`, but `TranslateControls.svelte` / `sidecar.js` never send
them (they default server-side). Expose them (esp. `reasoning_effort` for the
Anthropic/BYOK path).
- Files: `src/lib/TranslateControls.svelte`, `src/lib/sidecar.js`, `python/sidecar/main.py`.

### 5. Settings panel is models-only
Currently just the FLUX model + sidecar status. Candidates to add: model-cache
location/size + "clear cache", theme, default export dir, sidecar restart, the
HF token field (#2), the FLUX speed setting (#1).
- File: `src/lib/SettingsModal.svelte`.

---

## P3 — Low-severity / cosmetic (from audits)

- **fs scope** still `allow: "**"` (broad, needed for save-anywhere export;
  credential dirs are denied). Narrowing safely needs verifying Tauri v2
  dialog→fs runtime grants on real builds. `src-tauri/capabilities/default.json`.
- **Brush FLUX checkbox** shows the pre-install value during a multi-minute
  install (eventual state is correct). `src/lib/CleanPanel.svelte`.
- **Detector model auto-download** uses only a connect timeout (no total cap); a
  stalled mirror can hang the first `/analyze`. `python/sidecar/detect.py:60`.
- **FLUX "not installed" vs "install broken"** are indistinguishable to the user
  (both → Telea fallback); the completion toast now reports fallback counts, but
  a clearer per-cause message would help. `python/sidecar/flux.py`, `sidecar.js`.
- **Dev sidecar path resolution** assumes cwd = `src-tauri/`; fragile off the
  standard layout. `src-tauri/src/sidecar.rs`.
- **Child stdout** isn't captured (only stderr piped to log). `src-tauri/src/sidecar.rs`.

---

## P4 — Future / nice-to-have

- **Dynamic sidecar port** instead of hardcoded 8765 (avoids clashes; comment at
  `src-tauri/src/sidecar.rs:13`). Watchdog already prevents orphans holding it.
- **Windows sidecar watchdog** — the parent-death watchdog is POSIX-only
  (`getppid`); Windows should use a Job Object. `python/sidecar/__main__.py`.
- **Prod bundling of the FLUX path** — weights are multi-GB and opt-in; decide
  caching/first-run UX for packaged builds.
- **CI** — no automated build/test pipeline; the checks in this repo are manual.

---

## Known limitations (by design / environment)

- **FLUX is opt-in and heavy** — classical fill/inpaint is the always-available
  default; FLUX needs a ~5 GB model + is slow on Apple Silicon (see P1-1).
- **ML features need the desktop app** — the browser preview no-ops the sidecar
  gracefully (manual workflows only).
- **Model weights are not committed** — cached under `python/models/`
  (gitignored); they download on first use.
