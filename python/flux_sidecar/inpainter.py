"""Build + run MangaTranslator's FLUX inpainter from the selected model config.

Mirrors ``sidecar/flux.py::load_inpainter`` but parameterised by the model
selection (family / variant / backend / quant), so the user's Settings choice
actually drives which weights load. Model weights are still fetched lazily by the
inpainter on first use into the (CWD-stabilised) ``./models`` cache.
"""

from __future__ import annotations

import threading

from . import config
from ._util import ensure_mt_on_path

_inpainter = None  # lazy singleton
_build_error: Exception | None = None  # cached build failure (see get_inpainter)
_lock = threading.Lock()  # first /inpaint builds the model; serialise the build


def _build():
    ensure_mt_on_path(config.MT_DIR)

    # The inpainter expects a torch.device (it does ``device.type`` internally);
    # reuse MangaTranslator's own detector so cuda/mps/cpu + dtype line up.
    from core.device import get_best_device

    device = get_best_device()
    non_cuda = getattr(device, "type", str(device)) != "cuda"

    if config.FAMILY == "kontext":
        from core.image.inpainting import FluxKontextInpainter

        backend = config.BACKEND if config.BACKEND in ("nunchaku", "sdnq", "sdcpp") else "sdnq"
        kwargs = dict(device=device, backend=backend, huggingface_token=config.HF_TOKEN)
        if backend == "sdcpp" and config.QUANT:
            kwargs["sdcpp_diffusion_quant"] = config.QUANT
        if backend == "sdcpp" and config.TEXT_ENCODER_QUANT:
            kwargs["sdcpp_text_encoder_quant"] = config.TEXT_ENCODER_QUANT
        return FluxKontextInpainter(**kwargs)

    from core.image.inpainting import FluxKleinInpainter

    variant = config.VARIANT if config.VARIANT in ("4b", "9b") else "4b"
    backend = config.BACKEND if config.BACKEND in ("sdnq", "sdcpp") else "sdnq"
    kwargs = dict(
        variant=variant,
        device=device,
        backend=backend,
        huggingface_token=config.HF_TOKEN,
        num_inference_steps=config.NUM_INFERENCE_STEPS,
        # low_vram (sequential CPU offload) everywhere but CUDA, matching flux.py.
        low_vram=non_cuda,
    )
    if backend == "sdcpp" and config.QUANT:
        kwargs["sdcpp_diffusion_quant"] = config.QUANT
    if backend == "sdcpp" and config.TEXT_ENCODER_QUANT:
        kwargs["sdcpp_text_encoder_quant"] = config.TEXT_ENCODER_QUANT
    return FluxKleinInpainter(**kwargs)


def get_inpainter():
    """Return the lazily-built inpainter singleton (raises if the build fails).

    A build failure (missing dep, OOM, bad/gated weights) is *cached* and re-raised
    on every subsequent call: the cleaner asks for the inpainter once per textured
    region, so without this a broken selection would re-attempt the full model
    build — and its multi-GB weight download — for every region on the page. The
    proxy restarts this process whenever the model selection changes, so caching
    the failure for the process lifetime is safe (a new selection = a new process).
    """
    global _inpainter, _build_error
    if _inpainter is not None:
        return _inpainter
    if _build_error is not None:
        raise _build_error
    with _lock:
        if _inpainter is None and _build_error is None:
            try:
                _inpainter = _build()
            except Exception as e:
                _build_error = e
                raise
    if _build_error is not None:
        raise _build_error
    return _inpainter


def is_loaded() -> bool:
    return _inpainter is not None
