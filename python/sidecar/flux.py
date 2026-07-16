"""Opt-in FLUX inpainting: provision an external env + the in-process dev path.

FLUX is the AI redraw used for textured regions (the auto-clean default when a
region's surround isn't a solid colour); OpenCV Telea/NS is the always-available
*fallback* when it isn't available. FLUX is heavy and opt-in: it needs the
diffusers/sdnq (or sdcpp) stack and a multi-GB model that we do NOT ship or
install by default.

**How it runs (packaged builds):** the heavy stack can't be installed into the
frozen base app (no bundled pip/venv — ``sys.executable`` is the app binary), so
FLUX runs *out of process* in a separate ``mt-flux`` sidecar under an **external,
uv-provisioned** Python environment (a real interpreter). ``download()`` creates
that venv and installs the deps; the base sidecar then spawns ``mt-flux`` and
proxies region crops to it (see ``flux_proxy.py``). Model weights still stream
lazily on first use. This module owns provisioning + status; the proxy owns the
process.

**Dev path:** when the FLUX deps are already importable in the base venv, the
cleaner can load the inpainter *in process* (``load_inpainter``) instead of
provisioning a second env — faster iteration, no duplicate multi-GB install.

The selected model (family / variant / backend / quant — see ``flux_models``) is
persisted here so both the external spawn and the in-process path honour it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from . import config

# Full dependency set for the *external* FLUX venv. Unlike the base venv (which
# already carries torch/opencv/etc. for detection/OCR), the uv-provisioned env is
# a fresh interpreter with nothing, so this must be COMPLETE.
#
# This is the actual import closure of MangaTranslator's `core.image.inpainting`,
# NOT a curated "FLUX-only" subset — importing that submodule executes
# `core/__init__.py`, which eagerly imports `core.ml.model_manager`, which does an
# unconditional top-level `from ultralytics import YOLO`. So `ultralytics` is on
# the inpainter's critical path even though it's "detection" software; omitting it
# makes the child import fail and every FLUX region silently fall back to
# classical. Derive additions from the real import graph, not intuition.
_FLUX_DEPS = [
    "torch",
    "torchvision",
    "numpy>=1.24.0",
    "opencv-contrib-python>=4.8.0",
    "pillow>=11.1.0",
    "scipy>=1.10.0",
    "requests>=2.32.3",
    "packaging>=24.0",
    "diffusers>=0.37.0",
    "transformers>=5.0.0",
    "safetensors>=0.4.0",
    "accelerate>=0.30",
    "sdnq>=0.1.3",
    "spandrel>=0.3.0",
    "pyoxipng>=9.1.1",
    "scikit-learn>=1.3.0",
    "skia-python>=87.7",
    "uharfbuzz>=0.48.0",
    "fonttools>=4.56.0",
    "huggingface_hub>=0.20",
    "ultralytics>=8.3.94",  # reached via core.__init__ → core.ml.model_manager
    # mt-flux process server stack:
    "fastapi>=0.110",
    "uvicorn>=0.29",
    "pydantic>=2.0",
]

# Import names to probe for the *in-process* (base-venv/dev) readiness check.
# Some differ from the pip name (pyoxipng->oxipng, scikit-learn->sklearn,
# skia-python->skia). Covers the transitive chain so the probe can't report
# "ready" while the import fails.
_FLUX_IMPORTS = ("diffusers", "sdnq", "transformers", "spandrel", "oxipng", "sklearn", "skia")

# Vendored MangaTranslator tree (its inpainters + core/*). Dev: repo checkout.
# Packaged (PyInstaller): bundled into the onedir `_internal` as `MangaTranslator/`.
if getattr(sys, "frozen", False):
    _MT_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "MangaTranslator"
else:
    _MT_DIR = Path(__file__).resolve().parents[2] / "external" / "MangaTranslator"

# ---------------------------------------------------------------------------
# External uv-provisioned FLUX environment
# ---------------------------------------------------------------------------

# The venv lives next to the model cache so Settings' cache location covers it and
# it's stable/writable regardless of the frozen app's CWD.
FLUX_ENV_DIR = config.MODEL_DIR.resolve().parent / "flux-env"
# Written only after a fully successful provision, so a half-finished install
# (killed mid-`uv pip install`) reads as "not provisioned" and re-runs.
_PROVISIONED_MARKER = FLUX_ENV_DIR / ".provisioned"
# Where the selected model is persisted (shared by the spawn + in-process paths).
_SELECTION_FILE = config.MODEL_DIR.resolve().parent / "flux-selection.json"

_probe: tuple[str, str] | None = None  # cached in-process probe (see _probe_flux)


def venv_python() -> Path | None:
    """Path to the external FLUX venv's interpreter, or None if not created."""
    sub = "Scripts" if os.name == "nt" else "bin"
    exe = "python.exe" if os.name == "nt" else "python"
    py = FLUX_ENV_DIR / sub / exe
    return py if py.exists() else None


def flux_src_dir() -> Path:
    """Directory to put on PYTHONPATH so ``python -m flux_sidecar`` resolves.

    The ``flux_sidecar`` package ships as *source* (the external venv's real
    interpreter imports it — it can't load the base app's frozen modules).

    * Override: ``MT_FLUX_SRC_DIR`` (points at the dir *containing* flux_sidecar).
    * Frozen: the PyInstaller bundle root (``sys._MEIPASS``), where
      ``build-sidecar.sh`` stages ``flux_sidecar/`` via ``--add-data``.
    * Dev: the repo's ``python/`` (parent of this ``sidecar`` package).
    """
    env = os.environ.get("MT_FLUX_SRC_DIR")
    if env:
        return Path(env)
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parents[1]


def _uv_bin() -> str | None:
    """Locate the ``uv`` binary: an app override, the bundled copy, then PATH.

    Frozen builds ship ``uv`` alongside the sidecar (``build-sidecar.sh`` stages
    it into ``sys._MEIPASS/uv/``) so provisioning works with no system Python/uv.
    """
    env = os.environ.get("MT_FLUX_UV")
    if env and Path(env).exists():
        return env
    if getattr(sys, "frozen", False):
        exe = "uv.exe" if os.name == "nt" else "uv"
        bundled = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "uv" / exe
        if bundled.exists():
            return str(bundled)
    return shutil.which("uv")


def env_provisioned() -> bool:
    """True once the external FLUX venv exists and finished provisioning."""
    return _PROVISIONED_MARKER.is_file() and venv_python() is not None


def saved_selection() -> dict:
    """The persisted model selection (validated), or the default."""
    from . import flux_models

    try:
        raw = json.loads(_SELECTION_FILE.read_text())
    except (OSError, ValueError):
        raw = None
    return flux_models.normalize(raw)


def save_selection(selection: dict | None) -> dict:
    """Persist (validated) `selection`, invalidate the in-process model, return it.

    Clearing the in-process ``_inpainter`` singleton makes a model change actually
    take effect on the dev in-process path without a sidecar restart (the external
    path restarts the child on a selection-signature change; see flux_proxy).
    """
    global _inpainter
    from . import flux_models

    norm = flux_models.normalize(selection)
    try:
        _SELECTION_FILE.parent.mkdir(parents=True, exist_ok=True)
        _SELECTION_FILE.write_text(json.dumps(norm))
    except OSError:
        pass  # non-fatal: a failed persist just means next run reads the default
    _inpainter = None  # rebuild for the new selection on next in-process load
    return norm


def provision(progress=None) -> dict:
    """Create the external uv venv and install the FLUX deps into it.

    Works in both a frozen build and dev (installs into a *real* external
    interpreter, never the frozen app). Returns ``{ok, message}``. Heavy — only
    called on explicit opt-in; run it off the event loop.
    """
    uv = _uv_bin()
    if not uv:
        return {
            "ok": False,
            "message": (
                "The `uv` tool isn't available, so the FLUX environment can't be "
                "created. (Bundled with the app; on a source run, install uv.)"
            ),
        }

    # Bundled resources can lose their executable bit when unpacked — restore it
    # so we don't fail with a permission error on the first spawn (POSIX only).
    if os.name == "posix":
        try:
            os.chmod(uv, 0o755)
        except OSError:
            pass
    # On macOS a bundled binary unpacked from app resources can carry
    # com.apple.quarantine and be blocked by Gatekeeper regardless of the exec
    # bit. Best-effort strip it (a signed/notarised app usually avoids this, but
    # this covers ad-hoc/dev bundles). Ignore failures — the attr may be absent.
    if sys.platform == "darwin":
        try:
            subprocess.run(
                ["xattr", "-d", "com.apple.quarantine", uv],
                capture_output=True,
                check=False,
            )
        except OSError:
            pass

    FLUX_ENV_DIR.parent.mkdir(parents=True, exist_ok=True)
    steps = [
        # A managed standalone CPython so we don't depend on a system Python.
        [uv, "venv", "--python", "3.12", str(FLUX_ENV_DIR)],
        # Resolve the right platform wheels (MPS/CUDA/CPU torch) into that venv.
        [uv, "pip", "install", "--python", str(FLUX_ENV_DIR), *_FLUX_DEPS],
    ]
    tail: list[str] = []
    for cmd in steps:
        if progress:
            progress(f"$ {' '.join(cmd[:3])} …")
        proc = subprocess.run(cmd, capture_output=True, text=True)
        tail = (proc.stdout + proc.stderr).strip().splitlines()[-15:]
        if proc.returncode != 0:
            return {"ok": False, "message": "\n".join(tail) or f"failed: {' '.join(cmd)}"}

    try:
        _PROVISIONED_MARKER.write_text("ok")
    except OSError:
        pass
    return {"ok": True, "message": "\n".join(tail) or "FLUX environment ready"}


def status(selection: dict | None = None) -> dict:
    """Report whether FLUX can run and how it will run, for the Settings panel.

    Reports the external-env provisioning state (the primary, packaged-capable
    path), the in-process dev availability, and the selected model.

    Deliberately *light*: the in-process check is ``find_spec`` only (no heavy
    torch/diffusers import), so merely opening Settings can't drag the diffusion
    stack into the base process. The authoritative import happens lazily at first
    use (``load_inpainter`` / ``mt-flux``), which falls back to classical on any
    failure — so an optimistic "deps present" here is safe.
    """
    sel = flux_models_normalize(selection)
    provisioned = env_provisioned()
    inproc_ready = not _missing_deps()  # find_spec only — no heavy import
    uv_ok = _uv_bin() is not None

    available = provisioned or inproc_ready
    if available:
        how = "external" if provisioned else "in-process"
        reason = f"ready ({how})"
    elif not uv_ok:
        reason = "uv not available — can't provision the FLUX environment"
    else:
        reason = "not installed — click Download & Install to provision FLUX"

    return {
        "available": available,
        "reason": reason,
        "model": sel,
        "env_provisioned": provisioned,
        "in_process": inproc_ready,
        "uv_available": uv_ok,
    }


def flux_models_normalize(selection: dict | None) -> dict:
    """Persist-aware selection resolve: an explicit selection wins, else the saved."""
    from . import flux_models

    if selection is not None:
        return flux_models.normalize(selection)
    return saved_selection()


def download(selection: dict | None = None, hf_token: str = "", progress=None) -> dict:
    """One-click setup: persist the model choice + provision the external env.

    Model weights still fetch lazily on the first FLUX clean, honouring the saved
    selection. Returns ``{ok, already, message, model}``.
    """
    model = save_selection(selection)
    if hf_token:
        _save_hf_token(hf_token)
    if env_provisioned():
        return {"ok": True, "already": True, "message": "FLUX environment already provisioned", "model": model}
    # Dev fast path: if FLUX already runs in-process (deps in the base venv) and
    # the external env isn't provisioned, a model change shouldn't trigger a heavy
    # external uv provision — the choice is persisted and the in-process model was
    # invalidated by save_selection(), so it just reloads on the next clean.
    if _probe_flux()[0] == "ready":
        return {"ok": True, "already": True, "message": "model updated (in-process)", "model": model}
    res = provision(progress=progress)
    return {"ok": res["ok"], "already": False, "message": res["message"], "model": model}


# --- HF token (gated 9B / rate-limited downloads) --------------------------

_HF_TOKEN_FILE = config.MODEL_DIR.resolve().parent / "hf-token"


def _save_hf_token(token: str) -> None:
    try:
        _HF_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        _HF_TOKEN_FILE.write_text(token.strip())
        os.chmod(_HF_TOKEN_FILE, 0o600)
    except OSError:
        pass


def hf_token() -> str:
    """The saved HF token, or the ``HF_TOKEN`` env, or ""."""
    try:
        t = _HF_TOKEN_FILE.read_text().strip()
        if t:
            return t
    except OSError:
        pass
    return os.environ.get("HF_TOKEN", "")


# ---------------------------------------------------------------------------
# In-process (base-venv / dev) path — unchanged behaviour, now selection-aware
# ---------------------------------------------------------------------------

_inpainter = None  # lazy singleton for the in-process path


def _missing_deps() -> list[str]:
    """Cheap check (find_spec, no import) for deps that were never installed."""
    import importlib.util

    return [m for m in _FLUX_IMPORTS if importlib.util.find_spec(m) is None]


def _probe_flux() -> tuple[str, str]:
    """Classify the *in-process* FLUX install into (state, reason).

    state ∈ {"ready", "deps_missing", "import_error", "not_vendored"}. Only the
    terminal verdicts are cached; a first-run "deps_missing" re-evaluates so a
    later provision/install is picked up without a restart.
    """
    global _probe
    if _probe is not None:
        return _probe

    missing = _missing_deps()
    if missing:
        return ("deps_missing", f"missing python deps: {', '.join(missing)}")

    import importlib

    for m in _FLUX_IMPORTS:
        try:
            importlib.import_module(m)
        except Exception as e:  # present but broken (ABI/version mismatch, ...)
            _probe = ("import_error", f"{m} import failed: {type(e).__name__}: {e}")
            return _probe

    if not (_MT_DIR / "core" / "image" / "inpainting.py").is_file():
        _probe = ("not_vendored", "external/MangaTranslator not vendored")
        return _probe

    if str(_MT_DIR) not in sys.path:
        sys.path.insert(0, str(_MT_DIR))
    try:
        importlib.import_module("core.device")
        importlib.import_module("core.image.inpainting")
    except Exception as e:  # vendor tree present but not importable
        _probe = ("import_error", f"MangaTranslator inpainter import failed: {type(e).__name__}: {e}")
        return _probe

    _probe = ("ready", "ready")
    return _probe


def load_inpainter():
    """Return a ready in-process inpainter for the saved model, or None.

    Used only when the FLUX deps live in the *current* (base) interpreter — the
    dev fast path. Packaged builds use the external ``mt-flux`` sidecar instead
    (see ``flux_proxy``). Honours the saved model selection.
    """
    global _inpainter
    if _inpainter is not None:
        return _inpainter

    if _missing_deps():
        return None

    if str(_MT_DIR) not in sys.path:
        sys.path.insert(0, str(_MT_DIR))

    try:
        from core.device import get_best_device

        sel = saved_selection()
        device = get_best_device()
        non_cuda = getattr(device, "type", str(device)) != "cuda"

        if sel["family"] == "kontext":
            from core.image.inpainting import FluxKontextInpainter

            # Mirror the external (mt-flux) Kontext branch: honour the step lever
            # (upscale_small_crops is Klein-only) and both sdcpp quants.
            kwargs = dict(
                device=device,
                backend=sel["backend"],
                huggingface_token=hf_token(),
                num_inference_steps=sel["steps"],
            )
            if sel["backend"] == "sdcpp" and sel["quant"]:
                kwargs["sdcpp_diffusion_quant"] = sel["quant"]
            if sel["backend"] == "sdcpp" and sel["text_encoder_quant"]:
                kwargs["sdcpp_text_encoder_quant"] = sel["text_encoder_quant"]
            _inpainter = FluxKontextInpainter(**kwargs)
            return _inpainter

        from core.image.inpainting import FluxKleinInpainter

        kwargs = dict(
            variant=sel["variant"],
            device=device,
            backend=sel["backend"],
            huggingface_token=hf_token(),
            num_inference_steps=sel["steps"],
            upscale_small_crops=sel["upscale"],  # quality↔speed lever
            low_vram=non_cuda,
        )
        if sel["backend"] == "sdcpp" and sel["quant"]:
            kwargs["sdcpp_diffusion_quant"] = sel["quant"]
        if sel["backend"] == "sdcpp" and sel["text_encoder_quant"]:
            kwargs["sdcpp_text_encoder_quant"] = sel["text_encoder_quant"]
        _inpainter = FluxKleinInpainter(**kwargs)
        return _inpainter
    except Exception:
        return None
