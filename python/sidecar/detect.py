"""Text detection + OCR.

Wraps `comic_text_detector` (text-block detection + segmentation mask) and
`manga-ocr` (Japanese OCR, whole-block by default with a per-line fallback).
Models load lazily on first use.

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
# Dev: repo's external/mokuro. Packaged (PyInstaller): the tree is bundled into
# the onedir `_internal` (sys._MEIPASS) as `mokuro/`. MT_VENDOR_DIR overrides both.
if getattr(sys, "frozen", False):
    _DEFAULT_VENDOR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "mokuro"
else:
    _DEFAULT_VENDOR = Path(__file__).resolve().parents[2] / "external" / "mokuro"
_VENDOR = Path(os.environ.get("MT_VENDOR_DIR", _DEFAULT_VENDOR))
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


# How many crops to push through a single VisionEncoderDecoder.generate() call,
# and how many such calls to run concurrently. The default batch is 1 so each
# generate() sees exactly the arithmetic native manga-ocr would: batched matmuls
# take different reduction paths, which can flip borderline tokens vs the
# one-at-a-time path — quality wins over the amortised-overhead speedup. The
# thread pool is safe to keep: workers overlap independent generate() calls
# (torch releases the GIL inside kernels) without changing per-call arithmetic,
# and results are reassembled by index. Raise MT_OCR_BATCH to trade exactness
# for speed; override workers via MT_OCR_WORKERS.
try:
    _OCR_BATCH = max(1, int(os.environ.get("MT_OCR_BATCH", "1")))
except ValueError:
    _OCR_BATCH = 1
try:
    _OCR_WORKERS = max(1, int(os.environ.get("MT_OCR_WORKERS", "3")))
except ValueError:
    _OCR_WORKERS = 3

# OCR granularity. "block" (default) feeds manga-ocr one crop covering the whole
# text block — the model was trained on whole multi-line text regions, so
# whole-bubble crops generally read more coherently than stitched per-line
# chunks. "lines" restores the mokuro-style per-line/per-chunk pipeline. Blocks
# that would make a degenerate whole-block crop (rotated, or so elongated that
# the processor's fixed 224x224 resize destroys the glyphs) fall back to the
# per-line path automatically. Override via MT_OCR_MODE=block|lines.
_OCR_MODE = os.environ.get("MT_OCR_MODE", "block").strip().lower()

# Whole-block crop guards. The ViT processor squashes every crop to a fixed
# 224x224 input, so a crop only stays readable if its glyphs survive that
# resize: extreme aspect ratios crush one axis, and dense small-print blocks
# (many tiny lines) end up with sub-legible glyphs that send generate() into
# repetition loops. Measured on the benchmark page: blocks that read well have
# >= ~30px effective glyphs, the two that degenerated had < 18px.
_BLOCK_MAX_RATIO = 16.0
_BLOCK_MIN_GLYPH = 20.0
_PROCESSOR_INPUT = 224.0


def _ocr_crops(mocr, crops: list) -> list:
    """Batched manga-ocr over a flat list of PIL crops -> list of strings.

    Mirrors `MangaOcr.__call__` exactly (grayscale->RGB, same processor, same
    `generate(max_length=300)`, same post-processing) but runs `_OCR_BATCH` crops
    per forward pass across `_OCR_WORKERS` threads. Results are reassembled by
    index, so output order matches the input no matter which batch finishes
    first; at the default batch of 1 the content is also bit-identical to
    calling `mocr(crop)` on each crop (larger batches can flip borderline
    tokens — see the `_OCR_BATCH` comment above).
    """
    if not crops:
        return []

    import torch
    from manga_ocr.ocr import post_process

    processor = mocr.processor
    tokenizer = mocr.tokenizer
    model = mocr.model

    def ocr_batch(start: int) -> tuple:
        batch = [c.convert("L").convert("RGB") for c in crops[start : start + _OCR_BATCH]]
        pixel_values = processor(batch, return_tensors="pt").pixel_values.to(model.device)
        with torch.inference_mode():
            generated = model.generate(pixel_values, max_length=300)
        return start, [
            post_process(tokenizer.decode(tokens.cpu(), skip_special_tokens=True))
            for tokens in generated
        ]

    starts = range(0, len(crops), _OCR_BATCH)
    texts: list = [None] * len(crops)
    if _OCR_WORKERS == 1 or len(crops) <= _OCR_BATCH:
        for start, batch_texts in map(ocr_batch, starts):
            texts[start : start + len(batch_texts)] = batch_texts
    else:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=_OCR_WORKERS) as pool:
            for start, batch_texts in pool.map(ocr_batch, starts):
                texts[start : start + len(batch_texts)] = batch_texts
    return texts


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


def _block_crop(img: np.ndarray, blk) -> Optional[np.ndarray]:
    """One crop covering the whole text block, or None to use the per-line path.

    manga-ocr reads whole blocks in their natural orientation (vertical text
    included), so no rotation is applied. Returns None for rotated blocks — an
    axis-aligned bbox would drag in neighbouring art — and for extreme aspect
    ratios, where the processor's fixed-square resize would crush the glyphs.
    """
    if getattr(blk, "angle", 0):
        return None
    im_h, im_w = img.shape[:2]
    x1, y1, x2, y2 = [int(v) for v in blk.xyxy]
    # Breathing margin. eng/unknown-horizontal blocks get loose boxes from the
    # detector, so widen them by font_size/3 exactly like the per-line path
    # (`get_transformed_region`) does. Everything else stays deliberately tight
    # — generous padding drags neighbouring bubbles/art into the crop and
    # corrupts the read — and is sized from the box rather than font_size,
    # which reports the whole line height for single-line horizontal blocks.
    if blk.language == "eng" or (blk.language == "unknown" and not blk.vertical):
        pad = int(round(blk.font_size / 3))
    else:
        pad = max(2, min(8, min(x2 - x1, y2 - y1) // 16))
    x1 = max(x1 - pad, 0)
    y1 = max(y1 - pad, 0)
    x2 = min(x2 + pad, im_w)
    y2 = min(y2 + pad, im_h)
    w, h = x2 - x1, y2 - y1
    if w <= 1 or h <= 1:
        return None
    if max(w, h) / min(w, h) > _BLOCK_MAX_RATIO:
        return None
    if blk.font_size * _PROCESSOR_INPUT / max(w, h) < _BLOCK_MIN_GLYPH:
        return None
    return img[y1:y2, x1:x2]


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

    # OCR runs in two passes: first gather every crop across all blocks into one
    # flat list (recording how many crops each block contributes), then OCR the
    # whole page, then stitch the recognised text back per block. In "block"
    # mode most blocks contribute a single whole-block crop; blocks `_block_crop`
    # rejects — and everything in "lines" mode — go through the mokuro-style
    # per-line/per-chunk path instead. `jp` for each block is its crops' text
    # joined in gathering order, so the response shape is identical either way.
    crops: list = []
    crop_counts: list = []
    if do_ocr:
        for blk in blk_list:
            count = 0
            block_crop = _block_crop(img_bgr, blk) if _OCR_MODE != "lines" else None
            if block_crop is not None:
                crops.append(Image.fromarray(block_crop))
                count = 1
            else:
                max_ratio = 16 if blk.vertical else 8
                for line_idx in range(len(blk.lines_array())):
                    for crop in _split_into_chunks(
                        img_bgr, mask_refined, blk, line_idx,
                        textheight=64, max_ratio=max_ratio, anchor_window=2,
                    ):
                        if blk.vertical:
                            crop = cv2.rotate(crop, cv2.ROTATE_90_CLOCKWISE)
                        crops.append(Image.fromarray(crop))
                        count += 1
            crop_counts.append(count)

        texts = _ocr_crops(get_mocr(), crops)

    blocks = []
    cursor = 0
    for i, blk in enumerate(blk_list):
        jp = ""
        if do_ocr:
            count = crop_counts[i]
            jp = "".join(texts[cursor : cursor + count])
            cursor += count

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
