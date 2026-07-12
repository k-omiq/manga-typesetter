"""FastAPI app for the Manga Typesetter sidecar.

Phase 0: lifecycle + /health only. Detection, OCR, cleaning and translation
routers are mounted in later phases.
"""

from __future__ import annotations

import base64
import statistics

import json

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from . import __version__, config


def detect_device() -> str:
    """Best available compute device. torch is optional in Phase 0."""
    try:
        import torch  # noqa: WPS433 (lazy: torch isn't installed yet in Phase 0)

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
        return "cpu"
    except Exception:
        return "cpu"


def create_app() -> FastAPI:
    config.ensure_dirs()
    app = FastAPI(title="Manga Typesetter Sidecar", version=__version__)

    @app.middleware("http")
    async def _auth(request, call_next):
        # When the app sets a token, require it on every request except /health.
        # NOTE: raising HTTPException inside a Starlette @middleware does NOT map
        # to a 401 — it escapes the exception-handler layer and becomes a 500.
        # Return the response directly so the client sees a real 401.
        if config.TOKEN and request.url.path != "/health":
            if request.headers.get("x-mt-token") != config.TOKEN:
                return JSONResponse(status_code=401, content={"detail": "bad sidecar token"})
        return await call_next(request)

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "version": __version__,
            "device": detect_device(),
            "model_dir": str(config.MODEL_DIR),
        }

    @app.post("/analyze")
    async def analyze(image: UploadFile = File(...), ocr: bool = True):
        """Detect text blocks + OCR. Returns lines in JP reading order + mask PNG.

        The upload is read on the event loop; the CPU/model-bound work is offloaded
        to the threadpool so /health and concurrent requests aren't blocked.
        """
        raw = await image.read()
        return await run_in_threadpool(_analyze_image, raw, ocr)

    @app.post("/clean")
    async def clean(
        image: UploadFile = File(...),
        regions: str = Form("[]"),
        mask_png: str = Form(""),
        method: str = Form("telea"),
        flux: bool = Form(False),
        uniform_threshold: float = Form(12.0),
    ):
        """Smart-clean each text region into its own editable patch layer.

        `regions` is JSON: [{n, box:[x1,y1,x2,y2], method?}]. `mask_png` is the
        base64 text mask from /analyze; if omitted, detection is re-run to derive
        both the mask and the regions. Per-region `method` overrides the
        uniform->fill / textured->inpaint choice. Heavy work runs in the threadpool.
        """
        raw = await image.read()
        return await run_in_threadpool(
            _clean_image, raw, regions, mask_png, method, flux, uniform_threshold
        )

    @app.post("/clean/brush")
    async def clean_brush(
        image: UploadFile = File(...),
        mask_png: str = Form(""),
        method: str = Form("telea"),
        flux: bool = Form(False),
    ):
        """Content-aware fill over a user-painted brush mask.

        `image` is the current clean composite (raw + visible patches, so residue
        can be touched up); `mask_png` is the base64 painted alpha (full-page).
        Returns a single patch layer { box:[x,y,w,h], patch_png, method, fell_back }
        the client turns into a brush layer. Heavy work runs in the threadpool.
        """
        raw = await image.read()
        return await run_in_threadpool(_brush_inpaint, raw, mask_png, method, flux)

    @app.get("/translate/providers")
    async def translate_providers():
        from . import translate as tr

        return {"providers": tr.providers()}

    @app.post("/translate")
    def translate(payload: dict = Body(...)):
        """Translate detected JP lines via a BYOK LLM provider. Text->text.

        Sync handler on purpose: the provider call is a blocking `requests.post`
        with long timeouts, so FastAPI runs this in its threadpool instead of
        stalling the event loop (which would freeze /health, /analyze, etc.).

        payload = { lines:[{n,type,jp}], provider, model, api_key, base_url?,
                    output_language?, special_instructions?, reasoning_effort? }
        Returns { lines:[{n,en}] }.
        """
        from . import translate as tr

        lines = payload.get("lines") or []
        provider = payload.get("provider") or ""
        model = payload.get("model") or ""
        if not provider or not model:
            raise HTTPException(status_code=400, detail="provider and model are required")
        try:
            result = tr.translate_lines(
                lines,
                provider=provider,
                model=model,
                api_key=payload.get("api_key", ""),
                base_url=payload.get("base_url", ""),
                output_language=payload.get("output_language") or "English",
                input_language=payload.get("input_language") or "Japanese",
                reading_direction=payload.get("reading_direction") or "rtl",
                special_instructions=payload.get("special_instructions") or "",
                reasoning_effort=payload.get("reasoning_effort"),
            )
        except ValueError as e:
            # validation (bad provider, missing key field)
            raise HTTPException(status_code=400, detail=str(e)) from e
        except RuntimeError as e:
            # TranslationError: a missing key / missing base URL is the client's
            # fault (400); an upstream provider/HTTP failure is not (502, so the
            # UI can say "retry" rather than telling the user to fix config).
            msg = str(e)
            low = msg.lower()
            code = 400 if ("api key" in low or "url is missing" in low) else 502
            raise HTTPException(status_code=code, detail=msg) from e
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"translate failed: {e}") from e

        return {"lines": result}

    @app.get("/models/cache")
    async def models_cache():
        """On-disk size + location of the downloaded model caches (Settings panel)."""
        from . import models as models_mod

        return await run_in_threadpool(models_mod.cache_info)

    @app.post("/models/cache/clear")
    async def models_cache_clear():
        """Delete the downloaded model weights to free disk. Weights re-download lazily."""
        from . import models as models_mod

        return await run_in_threadpool(models_mod.clear_cache)

    @app.get("/clean/flux-status")
    async def flux_status():
        from . import flux as flux_mod
        from . import flux_models, flux_proxy

        def _gather():
            st = flux_mod.status()
            st["catalogue"] = flux_models.catalogue()
            st["process"] = flux_proxy.status()
            return st

        return await run_in_threadpool(_gather)

    @app.post("/clean/flux-download")
    async def flux_download(payload: dict = Body(default={})):
        from . import flux as flux_mod

        # Provisioning the external uv venv (torch/diffusers) is many minutes —
        # must not run on the event loop or it freezes /health and every other
        # request for the whole install. The body carries the chosen model
        # selection + optional HF token.
        selection = payload.get("selection")
        hf_token = payload.get("hf_token", "")
        return await run_in_threadpool(flux_mod.download, selection, hf_token)

    @app.on_event("shutdown")
    async def _stop_flux():
        # Tear down the out-of-process FLUX sidecar with us (its own watchdog is
        # the backstop for a hard crash; this is the graceful path).
        from . import flux_proxy

        flux_proxy.shutdown()

    return app


# ---------------------------------------------------------------------------
# CPU/model-bound route bodies, run via run_in_threadpool so the async event
# loop stays free. They raise HTTPException like inline handlers would — the
# exception propagates out of the threadpool into the endpoint and is handled
# by FastAPI normally (unlike the auth *middleware*, which must not raise).
# ---------------------------------------------------------------------------
def _analyze_image(raw: bytes, ocr: bool) -> dict:
    import cv2
    import numpy as np

    from . import detect

    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="could not decode image")

    try:
        result = detect.analyze(img, do_ocr=ocr)
    except Exception as e:  # surface model/runtime errors to the client
        raise HTTPException(status_code=500, detail=f"analyze failed: {e}") from e

    from .sorting import sort_bubbles_by_reading_order

    # Panel-aware RTL reading order: panels top→bottom, right→left; text
    # ordered within each panel. Falls back to spatial sort if no panels.
    dets = [dict(b, bbox=b["box"]) for b in result["blocks"]]
    ordered = sort_bubbles_by_reading_order(dets, "rtl", result.get("panels") or None)
    _assign_types(ordered)
    lines = [
        {
            "n": i + 1,
            "type": b["type"],
            "jp": b["jp"],
            "en": "",
            "box": b["box"],
            "vertical": b["vertical"],
            "font_size": b["font_size"],
        }
        for i, b in enumerate(ordered)
    ]

    ok, buf = cv2.imencode(".png", result["mask_refined"])
    if not ok:
        # Don't silently return mask_png:null — /clean would then re-run the whole
        # detector to recover a mask. Surface it so the client sees the failure.
        raise HTTPException(status_code=500, detail="failed to encode text mask")
    mask_png = base64.b64encode(buf.tobytes()).decode("ascii")

    return {
        "img_width": result["img_width"],
        "img_height": result["img_height"],
        "lines": lines,
        "panels": result.get("panels", []),
        "mask_png": mask_png,
    }


def _clean_image(
    raw: bytes,
    regions: str,
    mask_png: str,
    method: str,
    flux: bool,
    uniform_threshold: float,
) -> dict:
    import cv2
    import numpy as np

    from . import clean as cleaner

    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="could not decode image")
    H, W = img.shape[:2]

    try:
        region_list = json.loads(regions) if regions else []
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"bad regions json: {e}") from e

    # The global default only applies to textured regions, where only the
    # OpenCV inpaint flavours make sense.
    if method not in ("telea", "ns"):
        method = "telea"

    mask = cleaner._decode_mask(mask_png, img.shape)

    # Fall back to re-detection when the client didn't pass a mask/regions
    # (e.g. cleaning without a prior /analyze round-trip).
    if mask is None or not region_list:
        from . import detect

        try:
            result = detect.analyze(img, do_ocr=False, do_panels=False)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"detect failed: {e}") from e
        if mask is None:
            mask = np.where(result["mask_refined"] > 127, 255, 0).astype(np.uint8)
        if not region_list:
            region_list = [
                {"n": i + 1, "box": b["box"]}
                for i, b in enumerate(result["blocks"])
            ]

    try:
        layers = cleaner.clean_regions(
            img,
            mask,
            region_list,
            default_inpaint=method,
            uniform_threshold=uniform_threshold,
            flux=flux,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"clean failed: {e}") from e

    return {"img_width": W, "img_height": H, "layers": layers}


def _brush_inpaint(raw: bytes, mask_png: str, method: str, flux: bool) -> dict:
    import cv2
    import numpy as np

    from . import clean as cleaner

    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="could not decode image")

    mask = cleaner._decode_mask(mask_png, img.shape)
    if mask is None or not np.any(mask):
        raise HTTPException(status_code=400, detail="empty brush mask")

    flux_inpainter = cleaner._load_flux_inpainter() if flux else None
    try:
        layer = cleaner.inpaint_brush(
            img, mask, method=method, flux=flux, flux_inpainter=flux_inpainter
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"brush inpaint failed: {e}") from e
    if layer is None:
        raise HTTPException(status_code=400, detail="brush mask covered no pixels")
    return layer


def _assign_types(blocks: list) -> None:
    """Rough type guess without bubble detection (refined in Phase 2).

    Outsized font relative to the page median → SFX; everything else → dialogue.
    """
    if not blocks:
        return
    med = statistics.median(b["font_size"] for b in blocks) or 1.0
    for b in blocks:
        b["type"] = "sfx" if b["font_size"] > 2.2 * med else "dialogue"


app = create_app()
