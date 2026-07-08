"""Opt-in FLUX inpainting (one-click download).

FLUX is the AI redraw used for textured regions (the auto-clean default when a
region's surround isn't a solid colour); OpenCV Telea/NS is the always-available
*fallback* when it isn't installed. FLUX is heavy and opt-in: it needs the
diffusers/sdnq stack and a multi-GB model that we do NOT ship or install by
default. This module gates that behind an explicit download (see the Settings
panel) so the base cleaning pipeline stays light.

It wraps MangaTranslator's `FluxKleinInpainter` (Apache-2.0) -- the Klein variant
runs on CPU/MPS via the SDNQ backend, unlike the CUDA-only Kontext/Nunchaku path.
The model weights themselves are fetched lazily by that class on first use
(HuggingFace Hub -> ~/.cache), so "download" here means installing the Python
deps; the weights stream in on the first FLUX clean.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

# Deps required by MangaTranslator's Flux inpainters. NOTE: importing
# core.image.inpainting transitively pulls in MangaTranslator's core/utils
# (model manager, metadata, rendering), so this needs more than the raw
# diffusers/sdnq stack — spandrel, pyoxipng, scikit-learn and skia-python are all
# reached on import. Mirrors external/MangaTranslator/requirements.txt (minus the
# web-UI-only packages like gradio).
_FLUX_DEPS = [
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
]

# Import names to probe for readiness (some differ from the pip name:
# pyoxipng->oxipng, scikit-learn->sklearn, skia-python->skia). Covers the whole
# transitive chain so `status()` can't report "ready" while the import fails.
_FLUX_IMPORTS = ("diffusers", "sdnq", "transformers", "spandrel", "oxipng", "sklearn", "skia")

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MT_DIR = _REPO_ROOT / "external" / "MangaTranslator"

_inpainter = None  # lazy singleton


def _deps_available() -> tuple[bool, str]:
    import importlib.util

    missing = [m for m in _FLUX_IMPORTS if importlib.util.find_spec(m) is None]
    if missing:
        return False, f"missing python deps: {', '.join(missing)}"
    if not (_MT_DIR / "core" / "image" / "inpainting.py").is_file():
        return False, "external/MangaTranslator not vendored"
    return True, "ready"


def status() -> dict:
    """Report whether the FLUX path can run, and why not if it can't."""
    available, reason = _deps_available()
    return {
        "available": available,
        "reason": reason,
        "backend": "flux_klein_4b/sdnq",
        "loaded": _inpainter is not None,
    }


def download() -> dict:
    """One-click setup: pip-install the FLUX deps into the sidecar venv.

    Heavy and explicit -- only called when the user opts in. Model weights are
    fetched lazily on the first FLUX clean, not here.
    """
    available, _ = _deps_available()
    if available:
        return {"ok": True, "already": True, "message": "FLUX deps already installed"}

    proc = subprocess.run(
        [sys.executable, "-m", "pip", "install", *_FLUX_DEPS],
        capture_output=True,
        text=True,
    )
    ok = proc.returncode == 0
    tail = (proc.stdout + proc.stderr).strip().splitlines()[-12:]
    return {"ok": ok, "already": False, "message": "\n".join(tail)}


def load_inpainter():
    """Return a ready FluxKleinInpainter (SDNQ backend) or None if unavailable."""
    global _inpainter
    if _inpainter is not None:
        return _inpainter

    available, _ = _deps_available()
    if not available:
        return None

    if str(_MT_DIR) not in sys.path:
        sys.path.insert(0, str(_MT_DIR))

    try:
        from core.image.inpainting import FluxKleinInpainter
        from core.device import get_best_device

        # The inpainter expects a torch.device (it does `device.type` internally);
        # passing a bare string crashes get_best_dtype. Reuse MangaTranslator's own
        # detector so cuda/mps/cpu + dtype line up.
        device = get_best_device()
        _inpainter = FluxKleinInpainter(
            variant="4b",
            device=device,
            backend="sdnq",
            num_inference_steps=4,
            low_vram=(getattr(device, "type", str(device)) != "cuda"),
        )
        return _inpainter
    except Exception:
        return None


def _device():
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"
