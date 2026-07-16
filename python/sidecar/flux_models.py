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

# Quality↔speed presets. The two levers we can drive on the inpainter are
# `num_inference_steps` (linear in time) and `upscale_small_crops` (whether small
# crops are scaled up to ~1MP before diffusing — the expensive part). This matters
# most on Apple Silicon, where FLUX has no Triton backend and runs eager/slow.
QUALITY_PRESETS = {
    "fast": {"steps": 2, "upscale": False, "label": "Fast", "detail": "2 steps, no upscale — quickest"},
    "balanced": {"steps": 4, "upscale": True, "label": "Balanced", "detail": "4 steps, ~1MP — default"},
    "quality": {"steps": 8, "upscale": True, "label": "Quality", "detail": "8 steps, ~1MP — best"},
}

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
    return {"families": families, "qualities": qualities, "default": DEFAULT_SELECTION}


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

    backend = m.flux_valid_backend(key, str(sel.get("backend", "sdnq")).lower())
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
        "quality": quality,
        "steps": preset["steps"],  # derived from the quality preset
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
    }
    if hf_token:
        env["MT_FLUX_HF_TOKEN"] = hf_token
    return env
