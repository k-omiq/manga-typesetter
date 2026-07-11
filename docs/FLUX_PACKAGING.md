# FLUX in packaged builds — decision & first-run UX

_Scope: how the opt-in, multi-GB FLUX redraw path is handled in a packaged
(bundled) build vs a dev/source run. Companion to P4 #3 in
[REMAINING_WORK.md](REMAINING_WORK.md)._

## TL;DR

- **Weights are never bundled.** They are multi-GB and opt-in; they stream lazily
  from HuggingFace on the first FLUX clean into a stable, writable cache dir. This
  is unchanged and correct.
- **The FLUX cache dir now resolves correctly in a packaged build.** The one
  CWD-relative cache root (MangaTranslator's `./models`) is pinned at startup so
  it lands in `MODEL_DIR` instead of an unwritable `/models`.
- **The pip-based "Download & Install" is dev/source-run only.** A frozen
  PyInstaller build ships no pip and no venv, so the install can't run there. The
  app now detects this and tells the user to run from source (or use classical
  cleaning) instead of failing with a confusing pip error.
- **Bundling the whole FLUX Python stack into the base app is rejected** — it
  would add the entire torch/diffusers footprint to every download and defeat the
  "opt-in, light by default" design. The packaged-FLUX story is deferred to the
  CUDA-endpoint offload (P1) or a separate optional component download.

## What was investigated

### 1. Model-cache directories

Two cache roots exist (see `python/sidecar/models.py`):

| Root | Set by | Resolves to (dev) | Resolves to (packaged, before fix) |
|------|--------|-------------------|-------------------------------------|
| `config.MODEL_DIR` | `MT_MODEL_DIR` env, default `~/.mangatypesetter/models` | absolute — fine | absolute — **fine** (CWD-independent, writable) |
| `./models` (MangaTranslator) | `Path("./models")` in `core/ml/model_manager.py` (e.g. `flux_cache_dir = Path("./models/flux")`) | `python/` CWD → `python/models` | inherited app CWD (often `/`) → **`/models`, unwritable** |

- **Detector / OCR / panel** weights use `config.MODEL_DIR` (absolute) — these
  already resolve correctly in a packaged build. No change needed.
- **FLUX** weights use MangaTranslator's `./models`, which is **relative to the
  process CWD**. In dev the Rust side launches the sidecar with the CWD set to
  `python/` (`current_dir(&py_root)`), so `./models` → `python/models`. The frozen
  `mt-sidecar` binary is launched with **no** `current_dir`, so it inherits
  whatever CWD the OS gives the app — typically `/` when launched from Finder on
  macOS — and `./models` would resolve to an **unwritable `/models`**. The first
  FLUX weight fetch would then fail.

**Fix (`python/sidecar/__main__.py::_stabilize_model_cwd`).** When frozen
(`sys.frozen`), chdir into `MODEL_DIR`'s parent before the model manager is
created, so `./models` coincides with `config.MODEL_DIR`
(`~/.mangatypesetter/models` by default) — a stable, writable, CWD-independent
location the Settings cache/clear already knows about. Dev (non-frozen) behaviour
is untouched. (If `MT_MODEL_DIR` is overridden to a dir not named `models`, the
two roots don't perfectly coincide but both remain writable and stable, and
`models.py` de-dups/sums both — acceptable.)

### 2. "Download & Install" from a packaged build

`flux.download()` runs `[sys.executable, "-m", "pip", "install", <deps>]` into the
sidecar venv. In a **frozen** build:

- `sys.executable` is the `mt-sidecar` app binary, not a Python interpreter.
- There is no bundled pip and no venv to install into.

So the install path **cannot work** in a packaged build as written. Rather than
run a broken `mt-sidecar -m pip install` and surface a confusing failure, the
backend now **detects the frozen build and fails fast with guidance**:

- `flux.download()` returns `ok=false` with a "run from source / use Telea-NS"
  message when `sys.frozen` and deps aren't already present.
- `flux.status()` adds `frozen` and `installable` fields; `installable` is `false`
  in a frozen build. When not ready, the `reason` explains the packaged-build
  limitation.
- The Settings panel (`SettingsModal.svelte`) shows a **"Run from source"** tag,
  disables the install button (labelled "Unavailable in packaged app"), and shows
  the reason — instead of a button that would error.

### 3. Lazy weight fetch

Unchanged and correct: `FluxKleinInpainter` fetches weights via HuggingFace on
first use into the (now-stabilised) cache dir. Nothing is bundled. An `HF_TOKEN`
pass-through for rate-limited downloads is tracked separately (P1 #2).

## Why not just bundle the deps / weights?

- **Weights (multi-GB):** bundling would bloat every release by the model size for
  a feature most users won't enable. Streaming on first use is the right call.
- **Python deps (torch/diffusers/sdnq/…):** these are hundreds of MB and would
  have to be frozen into the base `mt-sidecar` for _every_ user, again defeating
  the opt-in-light design. A cleaner long-term answer is to **offload FLUX to a
  CUDA endpoint** (also the P1 speed win, since Triton has no Apple-Silicon
  backend) so the desktop app never ships the diffusion stack at all — or to ship
  FLUX as a **separate optional component** the user downloads on demand.

## Verification status

- **Verified in this environment (source run):** `status()`/`download()` frozen
  guards (simulated via `sys.frozen`) return the right `installable`/`ok` values
  and guidance; `_stabilize_model_cwd()` is a no-op when non-frozen and, when
  frozen, makes `./models` resolve to `MODEL_DIR`.
- **Needs verification on a packaged build (P1 #3):** that the frozen sidecar
  actually resolves `MODEL_DIR`/`./models` to the expected writable paths on each
  OS, that Settings shows the "Run from source" state, and — for a source run
  packaged alongside a Python env — that install + lazy fetch complete end-to-end.
