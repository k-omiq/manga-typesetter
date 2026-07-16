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

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from . import config, inpainter


class InpaintRequest(BaseModel):
    image_b64: str  # PNG, RGB — the region crop
    mask_b64: str  # PNG, 8-bit — nonzero = inpaint here
    seed: int = 1


def _decode_png(b64: str):
    from PIL import Image

    return Image.open(io.BytesIO(base64.b64decode(b64)))


def _run_inpaint(req: InpaintRequest) -> str:
    import numpy as np

    pil = _decode_png(req.image_b64).convert("RGB")
    mask = np.array(_decode_png(req.mask_b64).convert("L")) > 0
    out = inpainter.get_inpainter().inpaint_mask(
        pil, mask, seed=req.seed, verbose=False
    )
    buf = io.BytesIO()
    out.convert("RGB").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


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
        try:
            await run_in_threadpool(inpainter.get_inpainter)
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
