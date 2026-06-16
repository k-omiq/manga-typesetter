"""FastAPI app for the Manga Typesetter sidecar.

Phase 0: lifecycle + /health only. Detection, OCR, cleaning and translation
routers are mounted in later phases.
"""

from __future__ import annotations

import base64
import statistics

from fastapi import FastAPI, File, HTTPException, UploadFile

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
        if config.TOKEN and request.url.path != "/health":
            if request.headers.get("x-mt-token") != config.TOKEN:
                raise HTTPException(status_code=401, detail="bad sidecar token")
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
        """Detect text blocks + OCR. Returns lines in JP reading order + mask PNG."""
        import cv2
        import numpy as np

        from . import detect

        raw = await image.read()
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
        mask_png = base64.b64encode(buf.tobytes()).decode("ascii") if ok else None

        return {
            "img_width": result["img_width"],
            "img_height": result["img_height"],
            "lines": lines,
            "panels": result.get("panels", []),
            "mask_png": mask_png,
        }

    return app


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
