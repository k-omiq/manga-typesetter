"""FastAPI app for the Manga Typesetter sidecar.

Routes: /health, /analyze (detection + OCR) and the model-cache endpoints the
Settings panel uses. The app is a typesetter — image cleaning and machine
translation are deliberately not part of it.
"""

from __future__ import annotations

import statistics

from fastapi import FastAPI, File, HTTPException, UploadFile
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

    return {
        "img_width": result["img_width"],
        "img_height": result["img_height"],
        "lines": lines,
        "panels": result.get("panels", []),
    }


def _assign_types(blocks: list) -> None:
    """Rough type guess from relative glyph size.

    Outsized font relative to the page median → SFX; everything else → dialogue.
    """
    if not blocks:
        return
    med = statistics.median(b["font_size"] for b in blocks) or 1.0
    for b in blocks:
        b["type"] = "sfx" if b["font_size"] > 2.2 * med else "dialogue"


app = create_app()
