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
    # MLX backend: native-Metal mflux inpainter (Apple Silicon). It needs neither
    # the vendored MangaTranslator tree nor a torch device, so branch out before any
    # of that — keeping the diffusers path below entirely unchanged.
    if config.BACKEND == "mlx":
        from .mflux_inpainter import MfluxInpainter

        repo = config.MLX_REPO or "RunPod/FLUX.2-klein-4B-mflux-4bit"
        return MfluxInpainter(
            repo,
            steps=config.NUM_INFERENCE_STEPS,
            upscale=config.UPSCALE_SMALL_CROPS,
        )

    ensure_mt_on_path(config.MT_DIR)

    # The inpainter expects a torch.device (it does ``device.type`` internally);
    # reuse MangaTranslator's own detector so cuda/mps/cpu + dtype line up.
    from core.device import get_best_device

    device = get_best_device()
    non_cuda = getattr(device, "type", str(device)) != "cuda"

    if config.FAMILY == "kontext":
        from core.image.inpainting import FluxKontextInpainter

        backend = config.BACKEND if config.BACKEND in ("nunchaku", "sdnq", "sdcpp") else "sdnq"
        # Kontext honours num_inference_steps (the quality knob's step lever) but
        # has no upscale_small_crops arg — that half of the knob is Klein-only.
        kwargs = dict(
            device=device,
            backend=backend,
            huggingface_token=config.HF_TOKEN,
            num_inference_steps=config.NUM_INFERENCE_STEPS,
        )
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
        upscale_small_crops=config.UPSCALE_SMALL_CROPS,  # quality↔speed lever
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


# ---------------------------------------------------------------------------
# Low-memory mode (MT_FLUX_LOW_MEM, default on — see config.LOW_MEM)
# ---------------------------------------------------------------------------

_low_mem_applied = False

# Decode/encode the VAE in bounded tiles. The Flux2 VAE runs in float32
# (``force_upcast``), so an untiled ~1MP decode is the single-inpaint memory
# peak (measured: +2.0 GB footprint spike at decode). 512px tiles bound that
# spike regardless of the inference resolution; the VAE blends tile seams
# (tile_overlap_factor), so output quality is preserved.
_VAE_TILE_SAMPLE = 512


def apply_low_mem(inp) -> None:
    """Apply memory-bounding options to the *loaded* pipeline (idempotent).

    Must run after ``load_models()`` — the pipeline (and its VAE) only exists
    then. AutoencoderKLFlux2 has no ``enable_tiling()`` helper (that API is on
    AutoencoderKL); it exposes ``use_slicing``/``use_tiling`` attributes with
    tiled encode/decode implemented, so set those directly.
    """
    global _low_mem_applied
    if _low_mem_applied or not config.LOW_MEM:
        return
    pipe = getattr(inp, "pipeline", None)
    vae = getattr(pipe, "vae", None)
    if vae is None or not hasattr(vae, "use_tiling"):
        return  # sdcpp backend (no diffusers pipeline) or unexpected VAE
    vae.use_slicing = True
    vae.use_tiling = True
    scale = 2 ** (len(vae.config.block_out_channels) - 1)  # 8 for Flux2
    vae.tile_sample_min_size = _VAE_TILE_SAMPLE
    vae.tile_latent_min_size = _VAE_TILE_SAMPLE // scale
    _low_mem_applied = True


def release_memory() -> None:
    """Return cached allocator blocks after a request (LOW_MEM only).

    Sequential inpaints run at heterogeneous ~1MP shapes (each region crop has
    its own aspect ratio), so the MPS caching allocator retains freed blocks it
    can't reuse and its cache grows across regions/pages (measured: ~1.1 GB
    held between requests plus a slow creep, on top of each request's decode
    spike). Emptying the cache between requests costs a little re-allocation
    time (negligible next to ~35 s/step diffusion) and drops the between-
    request footprint from ~3.5 GB to ~2.4 GB, keeping long multi-region
    cleans flat instead of ratcheting.
    """
    if not config.LOW_MEM:
        return
    import gc

    gc.collect()
    try:
        import torch

        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass  # torch not imported yet / backend quirk — purge is best-effort
