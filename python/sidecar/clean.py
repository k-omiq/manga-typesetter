"""Smart cleaning engine.

Cleans each detected text region by classifying its surroundings:

- Sample the pixel ring just OUTSIDE the text mask and measure its colour
  uniformity.
- **Uniform surround** (flat tone: speech bubbles, boxes, one-colour
  backgrounds) -> a cheap OpenCV colour fill: paint the text pixels with the
  surrounding mean colour. No model.
- **Textured surround** (art, screentone, gradients) -> **AI redraw** via the
  FLUX inpainter (see `flux.py`). When FLUX isn't installed it falls back to
  OpenCV Telea / Navier-Stokes (`default_inpaint`), flagged as `fell_back`.

FLUX is loaded lazily and only when at least one region actually resolves to it,
so an all-bubbles page never pays the model-load cost.

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


def _classify_region(
    img_bgr: np.ndarray,
    mask: np.ndarray,
    box,
    *,
    default_inpaint: str = "telea",
    force_method: Optional[str] = None,
    uniform_threshold: float = 12.0,
    force_ai: bool = False,
) -> Optional[dict]:
    """Cheap first pass: crop the region, measure surround uniformity, and RESOLVE
    the method (fill / telea / ns / flux) without running the (expensive) clean.

    Split out from `_apply_region` so `clean_regions` can decide up front whether
    any region needs FLUX and load the model only then. Returns None if the region
    has no text pixels.
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
    chans = roi.shape[2]
    ring_px = roi[ring > 0]

    # Uniformity = worst-channel std of the surrounding ring. An empty ring (region
    # flush to an image edge) is treated as uniform; sample the ROI's own non-text
    # pixels for the fill colour rather than hardcoding white (which would paint a
    # white block inside a dark bubble).
    if ring_px.size == 0:
        ring_std = 0.0
        interior = roi[m_dil == 0]
        if interior.size:
            fill_color = tuple(int(v) for v in np.median(interior.reshape(-1, chans), axis=0))
        else:
            fill_color = (255, 255, 255)
    else:
        ring_std = float(ring_px.reshape(-1, chans).std(axis=0).max())
        fill_color = tuple(int(v) for v in np.median(ring_px.reshape(-1, chans), axis=0))
    uniform = ring_std <= uniform_threshold

    # Policy: explicit per-region override wins; otherwise a uniform (solid-colour)
    # surround -> cheap fill, anything textured -> AI redraw (FLUX). `force_ai`
    # pushes even uniform regions through FLUX. `requested` records the ask
    # ("auto" when not forced) so the response never misreports the resolved
    # method. `default_inpaint` is only the classical fallback if FLUX is absent.
    forced = (force_method or "").lower() or None
    if forced and forced not in _VALID_METHODS:
        forced = None
    if forced:
        requested = forced
        method = forced
    else:
        requested = "auto"
        method = "fill" if (uniform and not force_ai) else "flux"

    fallback = default_inpaint if default_inpaint in _OPENCV_INPAINT else "telea"
    return {
        "roi": roi,
        "m_dil": m_dil,
        "fill_color": fill_color,
        "box": [x1, y1, x2 - x1, y2 - y1],
        "method": method,
        "requested": requested,
        "fallback": fallback,
        "uniform": bool(uniform),
        "ring_std": round(ring_std, 2),
    }


def _apply_region(cls: dict, *, flux_inpainter=None) -> dict:
    """Second pass: run the resolved method and return the editable patch layer::

        { box: [x, y, w, h], method, requested, fell_back, uniform, ring_std,
          patch_png }

    FLUX regions fall back to the classical inpainter (`cls['fallback']`) when the
    inpainter is unavailable, flagged as `fell_back`.
    """
    roi = cls["roi"]
    m_dil = cls["m_dil"]
    method = cls["method"]
    fell_back = False
    patch = None

    if method == "flux":
        patch = _run_flux(roi, m_dil, flux_inpainter)
        if patch is None:  # FLUX unavailable -> graceful OpenCV fallback
            fell_back = True
            method = cls["fallback"]

    if method == "fill":
        patch = roi.copy()
        patch[m_dil > 0] = cls["fill_color"]
    elif method in _OPENCV_INPAINT:
        patch = cv2.inpaint(roi, m_dil, inpaintRadius=3, flags=_OPENCV_INPAINT[method])

    return {
        "box": cls["box"],
        "method": method,
        "requested": cls["requested"],
        "fell_back": fell_back,
        "uniform": cls["uniform"],
        "ring_std": cls["ring_std"],
        "patch_png": _encode_patch(patch),
    }


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
    """Classify + clean one region (eager: uses the passed `flux_inpainter`).

    Kept for direct callers; `clean_regions` uses the classify/apply split so it
    only loads FLUX when a region actually needs it. `flux` forces AI even for
    uniform regions.
    """
    cls = _classify_region(
        img_bgr,
        mask,
        box,
        default_inpaint=default_inpaint,
        force_method=force_method,
        uniform_threshold=uniform_threshold,
        force_ai=flux,
    )
    if cls is None:
        return None
    return _apply_region(cls, flux_inpainter=flux_inpainter)


def inpaint_brush(
    img_bgr: np.ndarray,
    mask: np.ndarray,
    *,
    method: str = "telea",
    flux: bool = False,
    flux_inpainter=None,
) -> Optional[dict]:
    """Content-aware fill over a user-painted brush mask.

    Unlike `clean_region`, the region + method here are chosen by the user (the
    painted mask *is* the selection), so there's no ring sampling / auto method
    choice — we just inpaint the mask's bounding box. `mask` is a full-page uint8
    0/255 array (the painted alpha). Returns a patch dict shaped like
    `clean_region`'s (minus the auto-classification fields) or None if empty.
    """
    H, W = img_bgr.shape[:2]
    ys, xs = np.where(mask > 0)
    if xs.size == 0:
        return None

    # Pad the painted bbox so inpaint has surrounding context to sample from.
    bw, bh = int(xs.max() - xs.min()), int(ys.max() - ys.min())
    pad = max(8, int(round(0.08 * max(bw, bh))))
    x1 = max(0, int(xs.min()) - pad)
    y1 = max(0, int(ys.min()) - pad)
    x2 = min(W, int(xs.max()) + 1 + pad)
    y2 = min(H, int(ys.max()) + 1 + pad)

    roi = img_bgr[y1:y2, x1:x2]
    m = mask[y1:y2, x1:x2]
    # Dilate a touch so soft brush edges are fully covered by the fill.
    edge_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    m_dil = cv2.dilate(np.where(m > 0, 255, 0).astype(np.uint8), edge_k, iterations=1)

    requested = (method or "telea").lower()
    if requested == "flux" or flux:
        requested = "flux"
    method = requested
    fell_back = False

    patch = None
    if method == "flux":
        patch = _run_flux(roi, m_dil, flux_inpainter)
        if patch is None:  # FLUX unavailable -> graceful OpenCV fallback
            fell_back = True
            method = "telea"
    if method not in _OPENCV_INPAINT:
        method = "telea"
    if patch is None:
        patch = cv2.inpaint(roi, m_dil, inpaintRadius=3, flags=_OPENCV_INPAINT[method])

    return {
        "box": [x1, y1, x2 - x1, y2 - y1],
        "method": method,
        "requested": requested,
        "fell_back": fell_back,
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
    """Clean every region. `regions` = [{n, box, method?}]. Returns layer dicts.

    Policy: solid-colour surround -> fill, textured -> AI (FLUX) with OpenCV
    fallback. `flux=True` forces AI even for uniform regions. FLUX is loaded
    lazily and only if at least one region actually resolves to it.
    """
    # Pass 1 — classify every region (cheap: ring sampling only, no cleaning).
    classifications = []
    for r in regions:
        box = r.get("box")
        if not box or len(box) != 4:
            continue
        # Skip degenerate boxes (non-positive width/height) so they don't become
        # bogus 1px patches.
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        cls = _classify_region(
            img_bgr,
            mask,
            box,
            default_inpaint=default_inpaint,
            force_method=r.get("method"),
            uniform_threshold=uniform_threshold,
            force_ai=flux,
        )
        if cls is None:
            continue
        cls["n"] = r.get("n")
        classifications.append(cls)

    # Load FLUX once, only if a textured (or forced-flux) region needs it — an
    # all-bubbles page never pays the multi-GB model-load cost.
    needs_flux = any(c["method"] == "flux" for c in classifications)
    flux_inpainter = _load_flux_inpainter() if needs_flux else None

    # Pass 2 — apply.
    layers = []
    for cls in classifications:
        layer = _apply_region(cls, flux_inpainter=flux_inpainter)
        layer["n"] = cls["n"]
        layers.append(layer)
    return layers


def _load_flux_inpainter():
    """Best-effort load of the opt-in FLUX inpainter (see flux.py)."""
    try:
        from . import flux

        return flux.load_inpainter()
    except Exception:
        return None
