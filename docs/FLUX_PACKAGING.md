# FLUX in packaged builds — the out-of-process, model-of-your-choice design

_Scope: how the opt-in, multi-GB FLUX redraw path runs in a packaged (bundled)
build vs a dev/source run, and how the user picks which model to download.
Supersedes the earlier "run from source only" conclusion. Companion to P4 #3 in
[REMAINING_WORK.md](REMAINING_WORK.md)._

## TL;DR

- **FLUX runs out of process.** The heavy diffusers/sdnq (or sdcpp) stack can't be
  installed into the frozen base app (`sys.executable` is the app binary — no
  pip, no venv). So FLUX runs in a **separate `mt-flux` sidecar** under an
  **external, uv-provisioned** Python environment (a real interpreter). The base
  sidecar spawns it on demand and proxies region crops to it over loopback.
- **"Download & Install" now works in packaged builds.** It provisions the
  external venv with a bundled `uv` (fetches a standalone CPython + installs the
  deps) — no system Python required. The old `installable=false` /
  "run from source" dead-end is gone.
- **Users pick the model.** The Settings panel exposes the same choices
  MangaTranslator does — family (Klein / Kontext), variant (4B / 9B), backend
  (sdnq / sdcpp / nunchaku), and a GGUF quant for sdcpp — plus an HF token for
  gated repos. The choice is persisted and drives which weights download.
- **Weights are never bundled.** They stream lazily from HuggingFace on first use
  into a stable, writable cache — unchanged and correct.
- **Nothing heavy ships in the base app.** Only the tiny `flux_sidecar` source and
  the `uv` binary (~35 MB) ride along; the torch/diffusers footprint lives in the
  user-provisioned env, downloaded only on opt-in.

## Architecture

```
Rust (Tauri)
  └─ spawns  mt-sidecar         (base app, frozen, light — no FLUX deps)
       │  clean.py:_load_flux_inpainter()
       │    1. flux_proxy.get_proxy_inpainter()  ── external path (packaged) ──┐
       │    2. flux.load_inpainter()             ── in-process (dev fallback)  │
       └─ spawns lazily  mt-flux  ◄───────────────────────────────────────────┘
            • external uv venv (~/.mangatypesetter/flux-env): torch/diffusers/sdnq
            • loopback HTTP: GET /health, POST /inpaint (crop+mask → patch)
            • PYTHONPATH → bundled flux_sidecar/ ; MT_FLUX_MT_DIR → bundled MangaTranslator/
            • own token + parent-death watchdog (exits if mt-sidecar dies)
```

The cleaner asks for an inpainter per FLUX region. `flux_proxy` returns a small
proxy object whose `.inpaint_mask(pil, mask)` POSTs the crop to `mt-flux` — a
drop-in for MangaTranslator's in-process inpainter, so `clean.py` barely changed.
The proxy spawns `mt-flux` lazily on the first FLUX region, health-checks it,
reuses it, and restarts it when the model selection changes.

### Why out-of-process (and not bundle the deps)

- **Frozen apps can't `pip install`.** Installing compiled extensions (torch et
  al.) into the frozen base interpreter is not reliable — its runtime is baked in.
  A separate process with its **own real interpreter** sidesteps all ABI coupling.
- **Bundling the stack into the base app is rejected.** Hundreds of MB of
  torch/diffusers on every download, for a feature most users won't enable,
  defeats the opt-in-light design.
- **We already had a loopback sidecar.** `mt-flux` is an extension of that
  pattern, not a new mechanism.

## Provisioning (uv)

`flux.provision()` runs, with the bundled `uv`:

1. `uv venv --python 3.12 <flux-env>` — a managed standalone CPython, so we don't
   depend on a system Python being present or compatible.
2. `uv pip install --python <flux-env> <_FLUX_DEPS>` — resolves the right
   platform wheels (MPS / CUDA / CPU torch) and the mt-flux server stack
   (fastapi/uvicorn/pydantic) into that venv.

A `.provisioned` marker is written only on full success, so a killed install
re-runs cleanly. The venv lives next to the model cache
(`~/.mangatypesetter/flux-env`) so Settings' cache location covers it and it's
stable/writable regardless of the frozen app's CWD.

`_FLUX_DEPS` is the **complete** set (torch, opencv, pillow, scipy, the diffusers
stack + its transitive core/utils deps, and the server stack), because the
external venv is a fresh interpreter — unlike the base venv, which already carries
torch/opencv for detection/OCR.

## Model selection

`sidecar/flux_models.py` is the single source of truth, built **from** the
vendored MangaTranslator metadata (`utils/model_metadata.py`) so the two can't
drift. It offers `catalogue()` (for the UI), `normalize()` (clamps a selection to
valid values, never raises), and `spawn_env()` (translates a selection into the
`MT_FLUX_*` env `mt-flux` is spawned with). The selection + HF token persist in
`~/.mangatypesetter/flux-selection.json` / `hf-token`, read by both the external
spawn and the in-process dev path.

## Bundling

`python/build-sidecar.sh` stages, into the PyInstaller onedir:

- `flux_sidecar/` → `_internal/flux_sidecar` (as **source** — the external venv's
  interpreter imports it; it can't load the base app's frozen modules), and
- the `uv` binary → `_internal/uv/uv`.

`MangaTranslator/` is already bundled there. Tauri's `bundle.resources` glob
(`binaries/mt-sidecar/**/*`) ships the whole onedir, so both ride along with no
extra Tauri config. `flux.flux_src_dir()` / `flux._uv_bin()` / `flux._MT_DIR`
resolve these from `sys._MEIPASS` when frozen, and from the repo checkout in dev.

## Dev vs packaged

- **Packaged:** provision the external env → `mt-flux` → proxy. The default path.
- **Dev:** if the FLUX deps are already importable in the base venv,
  `flux.load_inpainter()` loads the inpainter **in process** — faster iteration,
  no duplicate multi-GB install. The cleaner prefers the external proxy when the
  env is provisioned, else falls back to in-process, else to classical Telea/NS.

## The model-cache CWD fix (still relevant)

MangaTranslator caches FLUX weights at a CWD-relative `./models`. `mt-flux`
pins its CWD to `MODEL_DIR`'s parent at startup (`flux_sidecar/_util.py`) so
`./models` resolves to the same writable `~/.mangatypesetter/models` the base
sidecar's cache size/clear already manages — regardless of the CWD it's spawned
with. (The base sidecar does the equivalent for its own in-process path.)

## Verification status

- **Audit-driven fixes (4-way parallel review):** `_FLUX_DEPS` was missing
  `ultralytics` — the inpainter's import chain reaches it via
  `core/__init__.py → core.ml.model_manager`, so packaged FLUX would have spawned,
  reported "ready", then silently fallen back to classical on every region. Also
  fixed: `nunchaku` dropped from the offered backends (can't be uv-provisioned);
  the `mt-flux` child now negative-caches a failed model build (no per-region
  reload storms); the child env is scrubbed of inherited `VIRTUAL_ENV`/
  `PYTHONHOME`/`PYTHONPATH`; `/health` is model-verified before a child is
  accepted; `status()`/`shutdown()` no longer block behind an in-flight spawn; and
  a dev model-switch persists + reloads in-process instead of forcing an external
  provision.
- **Verified here (source run):** the full Python path imports and wires; the
  model catalogue matches MangaTranslator with correct clamping/gating; the
  `mt-flux` HTTP contract round-trips a crop+mask end-to-end (auth 401 on a bad
  token; masked pixels redrawn, geometry exact, unmasked preserved); the
  provisioning flow issues the right `uv` commands, writes the marker, persists
  the selection, and reports `already` on re-download; the frontend builds and the
  Rust command compiles.
- **Needs on-target verification (P1 #3):** a real packaged build — that `uv`
  provisions the external venv on each OS, that `mt-flux` spawns and serves under
  it, that the bundled `uv`/`flux_sidecar`/`MangaTranslator` resolve from
  `_MEIPASS` (and `uv` keeps/regains its exec bit), and that a genuine FLUX
  redraw completes through the app UI for a chosen model + quant.
