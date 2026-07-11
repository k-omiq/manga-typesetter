"""Text detection + OCR.

Wraps `comic_text_detector` (text-block detection + segmentation mask) and
`manga-ocr` (Japanese OCR per line). Models load lazily on first use.

The per-line chunking logic (`split_into_chunks`) is adapted from mokuro
(GPL-3.0, kha-white) — this sidecar is GPL-3.0, so that's fine.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from . import config

# --- locate vendored comic_text_detector -----------------------------------
# Dev: repo's external/mokuro. Packaged: MT_VENDOR_DIR points at the bundled copy.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_VENDOR = Path(os.environ.get("MT_VENDOR_DIR", _REPO_ROOT / "external" / "mokuro"))
if str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

_DETECTOR_URL = (
    "https://github.com/zyddnys/manga-image-translator/releases/download/"
    "beta-0.2.1/comictextdetector.pt"
)

_PANEL_REPO = "deepghs/manga109_yolo"
_PANEL_FILE = "v2023.12.07_l_yv11/model.pt"

# Lazy singletons.
_detector = None
_mocr = None
_panel_model = None


def _device() -> str:
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


# Overall wall-clock cap for the first-run detector download. `requests`'
# `timeout` only bounds connect + per-read gaps, so a mirror that dribbles bytes
# (or stalls after each chunk resets the read clock) can hang /analyze forever.
# This caps the whole streamed transfer. Override via MT_DOWNLOAD_DEADLINE.
try:
    _DOWNLOAD_DEADLINE_S = float(os.environ.get("MT_DOWNLOAD_DEADLINE", "300"))
except ValueError:
    _DOWNLOAD_DEADLINE_S = 300.0


def _ensure_detector_model() -> Path:
    path = config.MODEL_DIR / "comictextdetector.pt"
    if path.is_file():
        return path

    import time

    import requests

    config.ensure_dirs()
    # Stream to a temp file and rename on success so an interrupted/timed-out
    # download can't leave a truncated .pt that later reads as "already present".
    tmp = path.with_suffix(path.suffix + ".part")
    deadline = time.monotonic() + _DOWNLOAD_DEADLINE_S
    try:
        with requests.get(_DETECTOR_URL, stream=True, timeout=60) as r:
            r.raise_for_status()
            with tmp.open("wb") as f:
                for chunk in r.iter_content(1 << 16):
                    if time.monotonic() > deadline:
                        raise TimeoutError(
                            f"detector model download exceeded "
                            f"{_DOWNLOAD_DEADLINE_S:.0f}s (stalled mirror?): {_DETECTOR_URL}"
                        )
                    if chunk:
                        f.write(chunk)
        tmp.replace(path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return path


def get_detector():
    global _detector
    if _detector is None:
        from comic_text_detector.inference import TextDetector

        model_path = _ensure_detector_model()
        _detector = TextDetector(
            model_path=str(model_path), input_size=1024, device=_device(), act="leaky"
        )
    return _detector


def get_mocr():
    global _mocr
    if _mocr is None:
        from manga_ocr import MangaOcr

        _mocr = MangaOcr(force_cpu=_device() == "cpu")
    return _mocr


def get_panel_model():
    global _panel_model
    if _panel_model is None:
        from huggingface_hub import hf_hub_download
        from ultralytics import YOLO

        path = hf_hub_download(
            _PANEL_REPO, _PANEL_FILE, cache_dir=str(config.MODEL_DIR / "hf")
        )
        _panel_model = YOLO(path)
    return _panel_model


def detect_panels(img_bgr: np.ndarray, confidence: float = 0.25) -> list:
    """Return panel boxes [[x1,y1,x2,y2], ...] (only the 'frame' class)."""
    try:
        model = get_panel_model()
        res = model(img_bgr, conf=confidence, device=_device(), verbose=False, imgsz=640)[0]
        if res.boxes is None or len(res.boxes) == 0:
            return []
        frame_id = None
        for cid, name in getattr(model, "names", {}).items():
            if str(name).lower() == "frame":
                frame_id = cid
                break
        boxes = []
        for i, b in enumerate(res.boxes.xyxy.tolist()):
            if frame_id is not None and int(res.boxes.cls[i]) != frame_id:
                continue
            boxes.append([int(round(v)) for v in b])
        return boxes
    except Exception:
        # Panel detection is best-effort; reading order degrades to spatial sort.
        return []


# --- per-line chunking (adapted from mokuro.manga_page_ocr) ------------------
def _split_into_chunks(img, mask_refined, blk, line_idx, textheight, max_ratio, anchor_window):
    from scipy.signal.windows import gaussian

    line_crop = blk.get_transformed_region(img, line_idx, textheight)
    h, w = line_crop.shape[:2]
    ratio = w / h
    if ratio <= max_ratio:
        return [line_crop]

    k = gaussian(textheight * 2, textheight / 8)
    line_mask = blk.get_transformed_region(mask_refined, line_idx, textheight)
    num_chunks = int(np.ceil(ratio / max_ratio))
    anchors = np.linspace(0, w, num_chunks + 1)[1:-1]

    line_density = np.convolve(line_mask.sum(axis=0), k, "same")
    peak = line_density.max()
    if peak <= 0:
        # Empty line mask: normalizing by 0 yields all-NaN, so every argmin
        # collapses to the window start → duplicate/out-of-order cut points and
        # zero-width crops that break OCR. Nothing to split here.
        return [line_crop]
    line_density /= peak
    win = anchor_window * textheight

    cut_points = []
    for anchor in anchors:
        anchor = int(anchor)
        n0 = int(np.clip(anchor - win // 2, 0, w))
        n1 = int(np.clip(anchor + win // 2, 0, w))
        p = line_density[n0:n1].argmin() + n0
        cut_points.append(p)
    return np.split(line_crop, cut_points, axis=1)


def analyze(img_bgr: np.ndarray, do_ocr: bool = True, do_panels: bool = True) -> dict:
    """Detect text blocks (+ optional OCR) and panels. Returns blocks, panels, mask.

    block = { box:[x1,y1,x2,y2], vertical:bool, font_size:float, jp:str }
    """
    from comic_text_detector.utils.textmask import REFINEMASK_INPAINT
    from PIL import Image

    detector = get_detector()
    H, W = img_bgr.shape[:2]
    _, mask_refined, blk_list = detector(
        img_bgr, refine_mode=REFINEMASK_INPAINT, keep_undetected_mask=True
    )

    panels = detect_panels(img_bgr) if do_panels else []

    mocr = get_mocr() if do_ocr else None
    blocks = []
    for blk in blk_list:
        jp = ""
        if do_ocr:
            max_ratio = 16 if blk.vertical else 8
            parts = []
            for line_idx in range(len(blk.lines_array())):
                crops = _split_into_chunks(
                    img_bgr, mask_refined, blk, line_idx,
                    textheight=64, max_ratio=max_ratio, anchor_window=2,
                )
                line_text = ""
                for crop in crops:
                    if blk.vertical:
                        crop = cv2.rotate(crop, cv2.ROTATE_90_CLOCKWISE)
                    line_text += mocr(Image.fromarray(crop))
                parts.append(line_text)
            jp = "".join(parts)

        x1, y1, x2, y2 = [int(v) for v in blk.xyxy]
        blocks.append({
            "box": [x1, y1, x2, y2],
            "vertical": bool(blk.vertical),
            "font_size": float(blk.font_size),
            "jp": jp,
        })

    return {
        "img_width": int(W),
        "img_height": int(H),
        "blocks": blocks,
        "panels": panels,
        "mask_refined": mask_refined,  # uint8 single-channel; encoded by caller
    }
