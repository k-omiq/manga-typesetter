"""Loopback HTTP surface for the FLUX sidecar.

Two routes:

* ``GET  /health``  — liveness + the selected model + whether it's loaded yet.
* ``POST /inpaint`` — one region crop + mask → the redrawn crop.

The base sidecar's ``flux_proxy`` calls ``/inpaint`` once per FLUX region. The
payload is base64 PNG on the wire (crop as RGB, mask as an 8-bit 0/255 image);
the response is the redrawn crop as base64 PNG. Heavy model work runs in the
threadpool so ``/health`` stays responsive during a multi-second redraw.
"""

from __future__ import annotations

import base64
import io
import threading

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from . import config, inpainter


class InpaintRequest(BaseModel):
    image_b64: str  # PNG, RGB — the full page (the model crops to mask + context)
    mask_b64: str  # PNG, 8-bit — nonzero = inpaint here (full-page sized)
    seed: int = 1
    # Clip the composite to the exact mask extent (no feather bleed past the
    # glyphs). Defaults to the library default (False); the cleaner opts in.
    strict_mask_clipping: bool = False

# One inpaint at a time, end to end. run_in_threadpool means overlapping HTTP
# requests would otherwise run _run_inpaint concurrently; MangaTranslator's
# manager.flux_inference_lock already serialises the pipeline call itself, but
# this lock also covers model load, PIL/mask staging, compositing, and the
# post-request allocator purge — a second request can't allocate its working
# set (or observe a half-purged allocator) while one diffusion is in flight.
_INPAINT_LOCK = threading.Lock()


def _decode_png(b64: str):
    from PIL import Image

    return Image.open(io.BytesIO(base64.b64decode(b64)))


def _run_inpaint(req: InpaintRequest) -> str:
    import numpy as np

    with _INPAINT_LOCK:
        try:
            pil = _decode_png(req.image_b64).convert("RGB")
            mask = np.array(_decode_png(req.mask_b64).convert("L")) > 0
            inp = inpainter.get_inpainter()
            inp.load_models()  # idempotent; ensures the pipeline exists…
            inpainter.apply_low_mem(inp)  # …so VAE tiling can be applied to it
            out = inp.inpaint_mask(
                pil,
                mask,
                seed=req.seed,
                verbose=False,
                strict_mask_clipping=req.strict_mask_clipping,
            )
            buf = io.BytesIO()
            out.convert("RGB").save(buf, format="PNG")
            return base64.b64encode(buf.getvalue()).decode("ascii")
        finally:
            # Keep the footprint flat across sequential regions/pages — without
            # this the MPS allocator retains ~1 GB+ of unreusable cached blocks
            # between requests and grows across a long clean (see release_memory).
            inpainter.release_memory()


def create_app() -> FastAPI:
    app = FastAPI(title="mt-flux", docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def _auth(request: Request, call_next):
        # Same scheme as mt-sidecar: token required on everything but /health.
        # A middleware must return a response (not raise) for the 401 to map.
        if config.TOKEN and request.url.path != "/health":
            if request.headers.get("x-mt-token") != config.TOKEN:
                return JSONResponse(status_code=401, content={"detail": "bad flux token"})
        return await call_next(request)

    @app.get("/health")
    async def health():
        return {"ok": True, "loaded": inpainter.is_loaded(), "model": config.model_summary()}

    @app.post("/warmup")
    async def warmup():
        # Force the model to build now, which fetches its (multi-GB) weights into
        # the shared cache. Lets "Download & Install" actually download the model
        # up front instead of stalling the first clean. Idempotent + cached.
        #
        # get_inpainter() only *constructs* MangaTranslator's inpainter — its
        # __init__ sets self.pipeline = None and defers the actual weight download
        # to load_models() (called lazily on the first inpaint_mask). So we must
        # call load_models() explicitly here; otherwise warmup returns instantly
        # having downloaded nothing, and the weights only stream on the first clean.
        try:
            inp = await run_in_threadpool(inpainter.get_inpainter)
            await run_in_threadpool(inp.load_models)
            inpainter.apply_low_mem(inp)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")
        return {"ok": True, "loaded": True, "model": config.model_summary()}

    @app.post("/inpaint")
    async def inpaint(req: InpaintRequest):
        try:
            image_b64 = await run_in_threadpool(_run_inpaint, req)
        except Exception as e:  # model load / inference failure
            raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")
        return {"image_b64": image_b64}

    return app
