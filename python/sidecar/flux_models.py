"""FLUX model catalogue + selection validation (source of truth for the UI).

The Settings panel offers the same model choices MangaTranslator does — family,
variant, backend, and (for the sdcpp/GGUF backend) a quant — so a user can pick
which weights to download and run. This module is the single place that knows the
catalogue and validates a selection; it builds the catalogue *from* the vendored
MangaTranslator metadata so the two never drift.

It is imported by the base sidecar only (to serve the catalogue to the UI, to
validate a chosen selection, and to translate it into the ``MT_FLUX_*`` env the
out-of-process FLUX sidecar is spawned with). The FLUX sidecar itself just
receives the resolved fields — it does not re-derive the catalogue.
"""

from __future__ import annotations

import sys
from functools import lru_cache

from .flux import _MT_DIR  # same vendored MangaTranslator tree the inpainter uses

# Our selection uses (family, variant); MangaTranslator keys models as a single
# string. This is the only mapping between the two vocabularies.
_MODEL_KEY = {
    ("klein", "4b"): "flux_klein_4b",
    ("klein", "9b"): "flux_klein_9b",
    ("kontext", ""): "flux_kontext",
}

# --- MLX (Apple-Silicon native-Metal) backend --------------------------------
# ADDITIVE backend for the klein family: runs FLUX.2 Klein via `mflux` (native
# Metal — no Triton, no MPS-overcommit → ~4-5x faster & ~3.5x less memory than the
# diffusers/SDNQ path on Apple Silicon). It is offered ONLY on Apple Silicon; the
# sdnq/sdcpp diffusers path is left entirely intact and remains the backend for
# CUDA/Windows/Linux. Weights are a pre-quantized 4-bit mflux repo per (family,
# variant). mflux exposes FLUX.2 Klein as in-context *edit* (no mask), so the
# child crops + edits "remove text" + composites under our mask (see
# flux_sidecar/mflux_inpainter.py) — same inpaint_mask contract as the diffusers path.
_MLX_REPO = {
    ("klein", "4b"): "RunPod/FLUX.2-klein-4B-mflux-4bit",
}


def _apple_silicon() -> bool:
    import platform

    return sys.platform == "darwin" and platform.machine() == "arm64"


def _mlx_available(family: str, variant: str) -> bool:
    """True when the MLX backend can be offered for this model on this machine."""
    return _apple_silicon() and (family, variant) in _MLX_REPO

# Quality↔speed presets. The two levers we can drive on the inpainter are
# `num_inference_steps` (linear in time) and `upscale_small_crops` (whether small
# crops are scaled up to ~1MP before diffusing — the expensive part). This matters
# most on Apple Silicon, where FLUX has no Triton backend and runs eager/slow.
QUALITY_PRESETS = {
    "fast": {"steps": 2, "upscale": False, "label": "Fast", "detail": "2 steps, no upscale — quickest"},
    "balanced": {"steps": 4, "upscale": True, "label": "Balanced", "detail": "4 steps, ~1MP — default"},
    "quality": {"steps": 8, "upscale": True, "label": "Quality", "detail": "8 steps, ~1MP — best"},
}

# Hard floor on the inference steps that actually reach the child, regardless of the
# selected preset. A 2-step FLUX redraw cannot reconstruct the masked region — the
# diffusion has too few steps to resolve, so it returns a cloudy grey hallucination
# where the text was. 4 steps is the lowest that produces a usable redraw; the "fast"
# preset stays selectable in the UI but resolves to this floor for real inference. We
# deliberately do NOT force everyone up to 8 (quality) — that just makes it slow.
_MIN_REDRAW_STEPS = 4

DEFAULT_SELECTION = {
    "family": "klein",
    "variant": "4b",
    "backend": "sdnq",
    "quant": "",  # sdcpp only; "" → the backend's own default
    "text_encoder_quant": "",
    "quality": "balanced",  # → steps + upscale via QUALITY_PRESETS
}


def _metadata():
    """Import MangaTranslator's model metadata (lightweight: stdlib-only module)."""
    if str(_MT_DIR) not in sys.path:
        sys.path.insert(0, str(_MT_DIR))
    from utils import model_metadata

    return model_metadata


@lru_cache(maxsize=1)
def catalogue() -> dict:
    """The model choices for the Settings picker, derived from MangaTranslator.

    Shape::

        {
          "families": [
            {"family": "klein", "variant": "4b", "model_key": "flux_klein_4b",
             "label": "FLUX.2 Klein 4B", "backends": ["sdnq", "sdcpp"],
             "quants": ["Q8_0", ...], "default_quant": "Q4_K_M"},
            ...
          ],
          "default": DEFAULT_SELECTION,
        }

    Returned to the UI; the base sidecar never needs the raw metadata elsewhere.
    """
    m = _metadata()
    labels = {
        "flux_klein_4b": "FLUX.2 Klein 4B",
        "flux_klein_9b": "FLUX.2 Klein 9B",
        "flux_kontext": "FLUX.1 Kontext dev",
    }
    families = []
    for (family, variant), key in _MODEL_KEY.items():
        spec = m.FLUX_SDCPP_QUANT_FILES.get(key, {}).get("diffusion_model", {})
        quants = list(spec.get("filenames", {}).keys())
        # Backends: probe MangaTranslator's own validator so we can't offer one it
        # rejects (Klein has no nunchaku; Kontext adds it). We additionally drop
        # `nunchaku` — it's CUDA-only and needs a special build the uv provisioning
        # can't install, so offering it would let a user pick a backend that fails
        # at model-build time. Only the provisionable backends are surfaced.
        backends = [
            b for b in m.FLUX_BACKENDS if m.flux_valid_backend(key, b) == b and b != "nunchaku"
        ]
        # Offer MLX first on Apple Silicon (it's the fast/light default there).
        if _mlx_available(family, variant):
            backends.insert(0, "mlx")
        families.append(
            {
                "family": family,
                "variant": variant,
                "model_key": key,
                "label": labels.get(key, key),
                "gated": key == "flux_klein_9b",  # 9B repo needs an HF token
                "backends": backends,
                "quants": quants,
                "default_quant": spec.get("default", ""),
            }
        )
    qualities = [
        {"key": k, "label": v["label"], "detail": v["detail"]}
        for k, v in QUALITY_PRESETS.items()
    ]
    # Seed the picker to MLX on Apple Silicon (the fast/light native-Metal path);
    # elsewhere keep the cross-platform SDNQ default. This only sets what the UI
    # pre-selects — DEFAULT_SELECTION stays sdnq so normalize()'s fallback is safe
    # on every platform.
    default = dict(DEFAULT_SELECTION)
    if _mlx_available(default["family"], default["variant"]):
        default["backend"] = "mlx"
    return {"families": families, "qualities": qualities, "default": default}


def normalize(selection: dict | None) -> dict:
    """Validate a raw selection into resolved fields, clamping bad values.

    Never raises — an unknown family/variant/backend/quant falls back to the
    nearest valid default so a stale or malformed request still spawns *something*
    runnable rather than erroring.
    """
    m = _metadata()
    sel = {**DEFAULT_SELECTION, **(selection or {})}

    family = str(sel.get("family", "klein")).lower()
    variant = str(sel.get("variant", "4b")).lower()
    if family == "kontext":
        variant = ""
    if (family, variant) not in _MODEL_KEY:
        family, variant = "klein", "4b"
    key = _MODEL_KEY[(family, variant)]

    backend_req = str(sel.get("backend", "sdnq")).lower()
    # MLX is our own additive backend (not in MangaTranslator's validator); accept it
    # only when the machine + model actually support it, else fall through to the
    # diffusers validation so a stale mlx selection on a non-Mac degrades to sdnq.
    if backend_req == "mlx" and _mlx_available(family, variant):
        backend = "mlx"
    else:
        backend = m.flux_valid_backend(key, backend_req)
        if backend == "nunchaku":  # not provisionable (see catalogue) — clamp to sdnq
            backend = "sdnq"

    quant = ""
    text_encoder_quant = ""
    if backend == "sdcpp":
        diff = m.FLUX_SDCPP_QUANT_FILES[key]["diffusion_model"]
        req_q = str(sel.get("quant", "") or "")
        quant = req_q if req_q in diff["filenames"] else diff["default"]
        text_encoder_quant = m.flux_sdcpp_valid_text_encoder_quant(
            key, str(sel.get("text_encoder_quant", "") or "")
        )

    quality = str(sel.get("quality", "balanced")).lower()
    if quality not in QUALITY_PRESETS:
        quality = "balanced"
    preset = QUALITY_PRESETS[quality]

    return {
        "family": family,
        "variant": variant,
        "model_key": key,
        "backend": backend,
        "quant": quant,
        "text_encoder_quant": text_encoder_quant,
        # The mflux repo for the MLX backend ("" for every other backend).
        "mlx_repo": _MLX_REPO.get((family, variant), "") if backend == "mlx" else "",
        "quality": quality,
        # Derived from the quality preset, then floored: a real redraw never runs below
        # `_MIN_REDRAW_STEPS` (2-step output is unusable — cloudy hallucination).
        "steps": max(int(preset["steps"]), _MIN_REDRAW_STEPS),
        "upscale": preset["upscale"],
    }


def spawn_env(selection: dict | None, *, hf_token: str = "") -> dict:
    """The ``MT_FLUX_*`` model env for launching the FLUX sidecar with `selection`."""
    r = normalize(selection)
    env = {
        "MT_FLUX_FAMILY": r["family"],
        "MT_FLUX_VARIANT": r["variant"],
        "MT_FLUX_BACKEND": r["backend"],
        "MT_FLUX_QUANT": r["quant"],
        "MT_FLUX_TEXT_ENCODER_QUANT": r["text_encoder_quant"],
        "MT_FLUX_STEPS": str(r["steps"]),
        "MT_FLUX_UPSCALE": "1" if r["upscale"] else "0",
        "MT_FLUX_MLX_REPO": r["mlx_repo"],
    }
    if hf_token:
        env["MT_FLUX_HF_TOKEN"] = hf_token
    return env
