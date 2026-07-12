"""Environment-driven configuration for the FLUX sidecar.

The base ``mt-sidecar`` spawns this process and passes everything via env vars,
mirroring ``sidecar/config.py``. All values have standalone-run defaults so the
process can also be launched by hand for testing.

The *model selection* (family / variant / backend / quant / HF token) is chosen
in the app's Settings panel, validated by ``sidecar/flux_models.py`` on the base
side, and forwarded here as resolved fields — this process does not re-derive the
catalogue, it just constructs the inpainter from the fields it is given.
"""

from __future__ import annotations

import os
from pathlib import Path

# Loopback only. The base sidecar picks a free port and injects it (same scheme
# as mt-sidecar); the default is only for a standalone hand-run.
HOST = os.environ.get("MT_FLUX_HOST", "127.0.0.1")
PORT = int(os.environ.get("MT_FLUX_PORT", "8766"))

# Shared secret the base sidecar injects (checked on every route but /health).
TOKEN = os.environ.get("MT_FLUX_TOKEN", "")

# PID of the process that spawned us (the base sidecar). The watchdog exits this
# process if that parent goes away, so a base-sidecar/app crash can't orphan the
# heavy FLUX process. 0 when hand-run (no watchdog).
try:
    PARENT_PID = int(os.environ.get("MT_FLUX_PARENT_PID", "0"))
except ValueError:
    PARENT_PID = 0

# Vendored MangaTranslator source tree (its inpainters + core/*). The base
# sidecar knows where this is (bundled resource when packaged, repo checkout in
# dev) and passes it through so both processes agree on one copy.
_mt = os.environ.get("MT_FLUX_MT_DIR", "")
if _mt:
    MT_DIR = Path(_mt)
else:  # standalone-run fallback: the repo's external/MangaTranslator
    MT_DIR = Path(__file__).resolve().parents[1] / "external" / "MangaTranslator"

# Where model weights are cached (shared with the base sidecar's MODEL_DIR so the
# Settings "cache size / clear" covers FLUX weights too).
MODEL_DIR = Path(os.environ.get("MT_MODEL_DIR", Path.home() / ".mangatypesetter" / "models"))

# ---- Model selection (resolved fields, validated base-side) ----------------
# family: "klein" (CPU/MPS-friendly, default) | "kontext" (CUDA-leaning).
FAMILY = os.environ.get("MT_FLUX_FAMILY", "klein").lower()
# variant: "4b" (default) | "9b" (Klein only).
VARIANT = os.environ.get("MT_FLUX_VARIANT", "4b").lower()
# backend: "sdnq" (Diffusers/torch) | "sdcpp" (GGUF) | "nunchaku" (Kontext/CUDA).
BACKEND = os.environ.get("MT_FLUX_BACKEND", "sdnq").lower()
# quant: sdcpp diffusion-model quant, e.g. "Q4_K_M" (empty → the class default).
QUANT = os.environ.get("MT_FLUX_QUANT", "")
# text-encoder quant for sdcpp (empty → the class default).
TEXT_ENCODER_QUANT = os.environ.get("MT_FLUX_TEXT_ENCODER_QUANT", "")
# HF token for gated repos (Klein 9B) / rate-limited downloads. May be empty.
HF_TOKEN = os.environ.get("MT_FLUX_HF_TOKEN", "") or os.environ.get("HF_TOKEN", "")
# Denoising steps (1–12 for the distilled Klein models).
try:
    NUM_INFERENCE_STEPS = int(os.environ.get("MT_FLUX_STEPS", "4"))
except ValueError:
    NUM_INFERENCE_STEPS = 4


def model_summary() -> dict:
    """The selected model, for /health and the Settings panel."""
    return {
        "family": FAMILY,
        "variant": VARIANT,
        "backend": BACKEND,
        "quant": QUANT or None,
        "text_encoder_quant": TEXT_ENCODER_QUANT or None,
        "steps": NUM_INFERENCE_STEPS,
        "hf_token_set": bool(HF_TOKEN),
    }
