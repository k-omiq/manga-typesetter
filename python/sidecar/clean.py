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

# Fill-vs-FLUX classification (see `_classify_region`). The raw per-channel std of
# the surround ring is NOT a reliable uniformity signal: a dense text block's ring
# catches neighbouring glyphs'/linework ink, so genuinely flat white-paper dialogue
# measures std ≈ 30-57 and would wrongly route to FLUX (which then hallucinates grey
# clouds). These drive a robust test instead:
#   _TONE_DELTA     — per-channel |Δ| from the ring median above which a pixel counts
#                     as a genuinely different TONE (screentone/art), not stray ink.
#   _TONE_FRAC_MAX  — max share of such off-tone pixels for a near-extreme surround to
#                     still count as flat (white paper w/ a few intruding ink pixels).
#   _TRIM_FRAC      — fraction trimmed from each luminance tail before measuring spread,
#                     so outlier ink can't spike it.
#   _NEAR_WHITE/_NEAR_BLACK — median at/near an extreme = flat paper / solid bubble.
# Tuned on real detector output (AisazuNihaIrarenai-003): flat dialogue tops out at
# tone_frac 0.068 / trimmed-std 3.3, an order of magnitude below real screentone.
_TONE_DELTA = 40.0
_TONE_FRAC_MAX = 0.15
_TRIM_FRAC = 0.15
_NEAR_WHITE = 235
_NEAR_BLACK = 20

# FLUX compositing: clip the redrawn pixels to the exact (dilated) text mask so a
# FLUX patch differs from the raw page ONLY under the glyphs — the same invariant
# the fill/telea/ns paths already honour. MangaTranslator's inpaint_mask exposes
# `strict_mask_clipping` for exactly this: it multiplies the feathered composite
# mask by the original text mask, dropping the outside-the-glyph blend ring. That
# removes any bleed of freshly-generated pixels onto good surrounding art and, by
# construction, leaves the padded-bbox patch border identical to the raw page
# (zero seam). Without it, Klein's feather ramps new content a few px past the
# mask, which can smear texture near the glyph edges. See `_run_flux`.
_STRICT_MASK_CLIPPING = True

# FLUX glyph-mask dilation. The mask handed to the FLUX redraw is dilated WIDER
# than the 1px classification/fill mask (`m_dil`). Manga display text — titles,
# credits, SFX — carries a light anti-alias/outline halo so it reads over art;
# `comic_text_detector` masks only the black strokes, so a 1px dilation leaves that
# halo sitting just OUTSIDE the mask. Because FLUX composites strictly under the
# mask (`_STRICT_MASK_CLIPPING`), the halo is preserved from the raw page and
# survives as white ghost streaks over screentone/gradients (the exact artefact
# seen on 118-01). A wider dilation swallows the halo so FLUX redraws over it.
# Kept FLUX-only: the fill/telea classification and ring sampling deliberately key
# off the tight `m_dil`, so widening here doesn't perturb method selection. ~6px of
# growth (ELLIPSE(5,5)×3) — measured to clear the streaks without eating into the
# adjacent art; the fill path is unaffected because its halo ≈ the flat surround.
_FLUX_DILATE_KERNEL = (5, 5)
_FLUX_DILATE_ITERS = 3


def _dilate_for_flux(m_uint8: np.ndarray) -> np.ndarray:
    """Widen a 0/255 glyph mask enough to cover the text's anti-alias/outline halo."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, _FLUX_DILATE_KERNEL)
    return cv2.dilate(m_uint8, k, iterations=_FLUX_DILATE_ITERS)


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

    # Classify the surround. `ring_std` is kept (worst-channel std of the ring) as a
    # diagnostic, but the uniform decision is ROBUST to neighbouring ink: a dense text
    # block's ring inevitably catches a few dark pixels from adjacent glyphs/linework,
    # which spike the raw std even on flat white paper (measured ≈30-57 on pure-paper
    # dialogue). An empty ring (region flush to an image edge) is treated as uniform;
    # sample the ROI's own non-text pixels for the fill colour rather than hardcoding
    # white (which would paint a white block inside a dark bubble).
    if ring_px.size == 0:
        ring_std = 0.0
        tone_frac = 0.0
        uniform = True
        interior = roi[m_dil == 0]
        if interior.size:
            fill_color = tuple(int(v) for v in np.median(interior.reshape(-1, chans), axis=0))
        else:
            fill_color = (255, 255, 255)
    else:
        rp = ring_px.reshape(-1, chans).astype(np.float32)
        ring_std = float(rp.std(axis=0).max())
        med = np.median(rp, axis=0)
        # Fill colour stays the surround's dominant (median) colour so a dark bubble
        # fills dark and white paper fills white.
        fill_color = tuple(int(v) for v in med)
        # Tone fraction: share of ring pixels whose colour differs strongly from the
        # ring's dominant colour — a genuinely different TONE (screentone/art), not a
        # stray ink stroke bleeding in from a neighbouring glyph.
        tone_frac = float((np.abs(rp - med).max(axis=1) > _TONE_DELTA).mean())
        # Robust spread: worst-channel std after trimming the darkest/lightest
        # `_TRIM_FRAC` of the ring by luminance, so a few intruding ink pixels can't
        # inflate it. This is what actually separates flat surrounds from real texture.
        if rp.shape[0] >= 8:
            lum = rp.mean(axis=1)
            lo, hi = np.percentile(lum, [_TRIM_FRAC * 100.0, 100.0 - _TRIM_FRAC * 100.0])
            keep = (lum >= lo) & (lum <= hi)
            trim_std = float(rp[keep].std(axis=0).max()) if int(keep.sum()) > 2 else ring_std
        else:
            trim_std = ring_std
        # Uniform (→ instant fill) when EITHER the surround sits at a near-extreme flat
        # tone (near-white paper / near-black bubble) with only a sparse scatter of
        # off-tone pixels, OR its robust (trimmed) spread is genuinely small. FLUX is
        # reserved for surrounds where a MEANINGFUL fraction is mid-tone/varied — real
        # screentone, gradients or detailed art filling much of the ring.
        near_extreme = bool(med.min() >= _NEAR_WHITE or med.max() <= _NEAR_BLACK)
        uniform = (near_extreme and tone_frac <= _TONE_FRAC_MAX) or (trim_std <= uniform_threshold)

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
        # Wider mask used ONLY if this region resolves to FLUX (see _apply_region /
        # _dilate_for_flux); covers the text halo the tight m_dil leaves behind.
        "m_dil_flux": _dilate_for_flux(m),
        "fill_color": fill_color,
        "box": [x1, y1, x2 - x1, y2 - y1],
        "method": method,
        "requested": requested,
        "fallback": fallback,
        "uniform": bool(uniform),
        "ring_std": round(ring_std, 2),
        "tone_frac": round(tone_frac, 4),
    }


def _apply_region(cls: dict, img_bgr: np.ndarray, *, flux_inpainter=None) -> dict:
    """Second pass: run the resolved method and return the editable patch layer::

        { box: [x, y, w, h], method, requested, fell_back, uniform, ring_std,
          patch_png }

    FLUX gets the FULL page + a full-page mask (see `_run_flux`) so the diffusion
    has real surrounding context; fill/telea/ns keep operating on the local crop
    exactly as before. FLUX regions fall back to the classical inpainter
    (`cls['fallback']`) when the inpainter is unavailable, flagged as `fell_back`.
    """
    roi = cls["roi"]
    m_dil = cls["m_dil"]
    method = cls["method"]
    fell_back = False
    patch = None

    if method == "flux":
        # Hand FLUX the WIDER mask so the redraw covers the text's outline halo;
        # falling back to the tight m_dil only if the wide one is somehow absent.
        patch = _run_flux(img_bgr, cls.get("m_dil_flux", m_dil), cls["box"], flux_inpainter)
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
    return _apply_region(cls, img_bgr, flux_inpainter=flux_inpainter)


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
        # Same full-page-context fix as clean_region's _run_flux: give FLUX the
        # whole page + a full-page mask (dilated painted alpha) so it has real
        # surrounding pixels, then slice the padded bbox back out. Restricting the
        # full-page dilated mask to this bbox matches _run_flux's contract; the
        # painted region lies entirely inside the bbox so nothing is lost.
        full_dil = cv2.dilate(np.where(mask > 0, 255, 0).astype(np.uint8), edge_k, iterations=1)
        patch = _run_flux(img_bgr, full_dil[y1:y2, x1:x2], [x1, y1, x2 - x1, y2 - y1], flux_inpainter)
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


def _run_flux(img_bgr, region_mask_dil, box, flux_inpainter):
    """Redraw one region with FLUX, handing the model the FULL page as context.

    `inpaint_mask` is built to receive the whole page + a full-page mask: it does
    its own context expansion (50%/80px, doubled for Klein), feathered
    compositing, and returns the full page with ONLY masked pixels redrawn.
    Pre-cropping to a tight bbox (what we used to do) clamps that context padding
    to the crop, so the diffusion sees almost no surrounding pixels -> ghosting /
    garbage. Instead we build a full-page mask that is nonzero only under this
    region's dilated glyphs, run inpaint_mask on the whole page (it still crops
    internally to bbox+context, so diffusion cost is ~unchanged), then slice the
    region's padded bbox back out as the patch.

    `region_mask_dil` is the dilated text mask for the crop `box` = [x, y, w, h]
    (full-page coords). Returns a BGR patch (padded-bbox sized) or None if FLUX is
    unavailable / errored — the caller then falls back to classical on the local
    crop.
    """
    if flux_inpainter is None:
        return None
    try:
        from PIL import Image

        H, W = img_bgr.shape[:2]
        x, y, w, h = box
        full_mask = np.zeros((H, W), dtype=bool)
        full_mask[y:y + h, x:x + w] = region_mask_dil.astype(bool)
        if not full_mask.any():
            return None

        pil = Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))
        out = flux_inpainter.inpaint_mask(
            pil, full_mask, verbose=False, strict_mask_clipping=_STRICT_MASK_CLIPPING
        )
        page = cv2.cvtColor(np.array(out.convert("RGB")), cv2.COLOR_RGB2BGR)
        return page[y:y + h, x:x + w].copy()
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
        layer = _apply_region(cls, img_bgr, flux_inpainter=flux_inpainter)
        layer["n"] = cls["n"]
        layers.append(layer)
    return layers


def _load_flux_inpainter():
    """Best-effort load of the opt-in FLUX inpainter.

    Prefers the out-of-process ``mt-flux`` sidecar (the packaged-capable path via
    an external uv-provisioned env). Falls back to the in-process inpainter when
    the FLUX deps live in this interpreter (the dev fast path). Either object
    exposes ``.inpaint_mask``; ``None`` means classical Telea/NS fallback.
    """
    try:
        from . import flux_proxy

        proxy = flux_proxy.get_proxy_inpainter()
        if proxy is not None:
            return proxy
    except Exception:
        pass
    try:
        from . import flux

        return flux.load_inpainter()
    except Exception:
        return None
