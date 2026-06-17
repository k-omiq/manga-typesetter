"""Smart cleaning engine.

Cleans each detected text region while *minimizing* inpaint-model use:

- Sample the pixel ring just OUTSIDE the text mask and measure its colour
  uniformity.
- **Uniform surround** (flat tone / inside a bubble) -> a cheap OpenCV colour
  fill: paint the text pixels with the surrounding mean colour. No model.
- **Textured surround** (art, screentone, gradients) -> inpaint. OpenCV Telea /
  Navier-Stokes by default; FLUX is opt-in (see `flux.py`) and best-effort.

Each region is cleaned independently and returned as its **own patch** (the
cleaned bounding-box pixels), so the editor can treat every text block as a
separate, toggleable layer. Crucially both cleaning methods only ever change
pixels *under the (dilated) text mask* -- `cv2.inpaint` leaves unmasked pixels
untouched and the colour fill only writes masked pixels -- so the patches keep
the raw pixels everywhere else and composite over the raw page without seams,
even where padded patches overlap.

The colour-classification / fill approach is adapted from MangaTranslator's
`core/image/cleaning.py` (Apache-2.0, meangrinch); the mask here comes from
comic_text_detector rather than YOLO speech bubbles, so the region logic is our
own.
"""

from __future__ import annotations

import base64
from typing import Optional

import cv2
import numpy as np

# Methods that do not need an ML model.
_OPENCV_INPAINT = {"telea": cv2.INPAINT_TELEA, "ns": cv2.INPAINT_NS}
_VALID_METHODS = {"fill", "telea", "ns", "flux"}


def _decode_mask(mask_b64: str, shape: tuple) -> Optional[np.ndarray]:
    """Decode a base64 PNG mask to a full-page uint8 0/255 array sized to `shape`."""
    if not mask_b64:
        return None
    raw = base64.b64decode(mask_b64)
    arr = np.frombuffer(raw, dtype=np.uint8)
    m = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if m is None:
        return None
    h, w = shape[:2]
    if m.shape[:2] != (h, w):
        m = cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST)
    return np.where(m > 127, 255, 0).astype(np.uint8)


def _pad_box(box, w, h, pad):
    x1, y1, x2, y2 = [int(round(v)) for v in box]
    x1 = max(0, min(w - 1, x1 - pad))
    y1 = max(0, min(h - 1, y1 - pad))
    x2 = max(x1 + 1, min(w, x2 + pad))
    y2 = max(y1 + 1, min(h, y2 + pad))
    return x1, y1, x2, y2


def _encode_patch(patch_bgr: np.ndarray) -> Optional[str]:
    ok, buf = cv2.imencode(".png", patch_bgr)
    return base64.b64encode(buf.tobytes()).decode("ascii") if ok else None


def clean_region(
    img_bgr: np.ndarray,
    mask: np.ndarray,
    box,
    *,
    default_inpaint: str = "telea",
    force_method: Optional[str] = None,
    uniform_threshold: float = 12.0,
    flux: bool = False,
    flux_inpainter=None,
) -> Optional[dict]:
    """Clean one text region and return an editable patch layer.

    Returns a dict::

        { box: [x, y, w, h],          # patch placement in image coords
          method: "fill"|"telea"|"ns"|"flux",
          requested: <method asked for>,
          fell_back: bool,            # FLUX requested but unavailable
          uniform: bool, ring_std: float,
          patch_png: <base64 PNG> }

    or None if the region has no text pixels to clean.
    """
    H, W = img_bgr.shape[:2]
    bw, bh = int(box[2] - box[0]), int(box[3] - box[1])
    pad = max(6, int(round(0.06 * max(bw, bh))))
    x1, y1, x2, y2 = _pad_box(box, W, H, pad)

    roi = img_bgr[y1:y2, x1:x2]
    m = mask[y1:y2, x1:x2]
    if not np.any(m):
        return None

    # Dilate slightly so anti-aliased text edges are fully covered.
    edge_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    m_dil = cv2.dilate(m, edge_k, iterations=1)

    # Ring just outside the text: a few px wide annulus around the glyphs.
    ring_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    ring = cv2.subtract(cv2.dilate(m_dil, ring_k, iterations=1), m_dil)
    ring_px = roi[ring > 0]

    # Uniformity = worst-channel std of the surrounding ring. Empty ring (region
    # flush to an edge) is treated as uniform.
    if ring_px.size == 0:
        ring_std = 0.0
        fill_color = (255, 255, 255)
    else:
        ring_std = float(ring_px.reshape(-1, roi.shape[2]).std(axis=0).max())
        fill_color = tuple(int(v) for v in np.median(ring_px.reshape(-1, roi.shape[2]), axis=0))
    uniform = ring_std <= uniform_threshold

    # Decide method: explicit override wins, else uniform->fill / textured->inpaint.
    requested = (force_method or "").lower() or None
    if requested and requested not in _VALID_METHODS:
        requested = None
    if requested:
        method = requested
    elif flux:
        method = "flux"
    elif uniform:
        method = "fill"
    else:
        method = default_inpaint if default_inpaint in _OPENCV_INPAINT else "telea"

    fell_back = False

    if method == "flux":
        patch = _run_flux(roi, m_dil, flux_inpainter)
        if patch is None:  # FLUX unavailable -> graceful OpenCV fallback
            fell_back = True
            method = "telea"

    if method == "fill":
        patch = roi.copy()
        patch[m_dil > 0] = fill_color
    elif method in _OPENCV_INPAINT:
        patch = cv2.inpaint(roi, m_dil, inpaintRadius=3, flags=_OPENCV_INPAINT[method])

    return {
        "box": [x1, y1, x2 - x1, y2 - y1],
        "method": method,
        "requested": requested or ("flux" if flux else ("fill" if uniform else default_inpaint)),
        "fell_back": fell_back,
        "uniform": bool(uniform),
        "ring_std": round(ring_std, 2),
        "patch_png": _encode_patch(patch),
    }


def _run_flux(roi_bgr, mask_dil, flux_inpainter):
    """Run the opt-in FLUX inpainter on a region crop. Returns BGR patch or None."""
    if flux_inpainter is None:
        return None
    try:
        from PIL import Image

        pil = Image.fromarray(cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2RGB))
        out = flux_inpainter.inpaint_mask(pil, mask_dil.astype(bool), verbose=False)
        return cv2.cvtColor(np.array(out.convert("RGB")), cv2.COLOR_RGB2BGR)
    except Exception:
        return None


def clean_regions(
    img_bgr: np.ndarray,
    mask: np.ndarray,
    regions: list,
    *,
    default_inpaint: str = "telea",
    uniform_threshold: float = 12.0,
    flux: bool = False,
) -> list:
    """Clean every region. `regions` = [{n, box, method?}]. Returns layer dicts."""
    flux_inpainter = _load_flux_inpainter() if flux else None

    layers = []
    for r in regions:
        box = r.get("box")
        if not box or len(box) != 4:
            continue
        layer = clean_region(
            img_bgr,
            mask,
            box,
            default_inpaint=default_inpaint,
            force_method=r.get("method"),
            uniform_threshold=uniform_threshold,
            flux=flux,
            flux_inpainter=flux_inpainter,
        )
        if layer is None:
            continue
        layer["n"] = r.get("n")
        layers.append(layer)
    return layers


def _load_flux_inpainter():
    """Best-effort load of the opt-in FLUX inpainter (see flux.py)."""
    try:
        from . import flux

        return flux.load_inpainter()
    except Exception:
        return None
