"""FLUX.2 Klein 4B redraw via ``mflux`` (Apple-Silicon native Metal).

This is the MLX backend's inpainter. It presents the SAME duck-typed contract the
base cleaner already drives on the diffusers inpainter —

    load_models()                                  # idempotent; builds the model
    inpaint_mask(image_pil, mask, *,               # full page in, full page out
                 strict_mask_clipping=..., verbose=...)

— so ``flux_sidecar/app.py`` and ``sidecar/clean.py::_run_flux`` need no special
casing. It deliberately exposes **no** ``pipeline`` attribute, so
``inpainter.apply_low_mem`` (which looks for a diffusers VAE) is a safe no-op.

Why "edit", not a masked fill: mflux ships FLUX.2 Klein only as in-context *edit*
(there is no Klein fill checkpoint — ``mflux-generate-fill`` is FLUX.1-Fill-dev).
So we mirror what MangaTranslator's ``inpaint_mask`` does with the diffusers model:
crop the masked region + surrounding context, run an edit that removes text, then
composite the result back **only under the mask** (keeping every other pixel of the
raw page identical — the same patch invariant the fill/telea paths honour). Small
crops are optionally upscaled to a working resolution before editing (the MLX
analogue of ``upscale_small_crops``), then downscaled back.

Apple-Silicon only; the diffusers/SDNQ path is untouched and stays the backend for
CUDA/Windows/Linux (see ``sidecar/flux_models.py``).
"""

from __future__ import annotations

import os
import tempfile

# Instruction handed to the edit model. Describes what to KEEP as strongly as what
# to remove, to hold drift down (the edit regenerates the whole crop; we only keep
# the pixels under the mask, but a faithful crop reduces boundary mismatch).
_EDIT_PROMPT = (
    "remove all Japanese text, letters, furigana and captions; "
    "keep the artwork, line art, screentone and background exactly unchanged"
)

# Long-side working resolution a small crop is upscaled to before editing when
# `upscale` is on. FLUX.2 edit resolves poorly on tiny inputs; ~768px gives it
# enough to reconstruct screentone without paying full-page cost. Snapped to /16.
_UPSCALE_LONG = 768


def _snap16(v: int) -> int:
    v = int(v)
    return max(16, v - (v % 16))


class MfluxInpainter:
    """Lazily-built FLUX.2 Klein (MLX) editor with the ``inpaint_mask`` contract."""

    def __init__(self, repo: str, *, steps: int = 4, upscale: bool = True,
                 seed: int = 1, guidance: float = 1.0):
        self.repo = repo
        self.steps = int(steps)
        self.upscale = bool(upscale)
        self.seed = int(seed)
        self.guidance = float(guidance)
        self.model = None  # built lazily by load_models()
        # No `pipeline` attribute on purpose — see module docstring.

    # -- model lifecycle -----------------------------------------------------
    def load_models(self) -> None:
        """Build the mflux model if needed (idempotent). Imports mflux lazily so
        this module stays importable in a non-mlx interpreter."""
        if self.model is not None:
            return
        from mflux.models.common.config import ModelConfig
        from mflux.models.flux2.variants import Flux2KleinEdit

        self.model = Flux2KleinEdit(model_config=ModelConfig.from_name(model_name=self.repo))

    # -- one edit on a crop --------------------------------------------------
    def _edit(self, crop_rgb):
        import cv2
        import numpy as np

        ch, cw = crop_rgb.shape[:2]
        long = max(ch, cw)
        scale = max(1.0, _UPSCALE_LONG / long) if self.upscale else 1.0
        gw, gh = _snap16(cw * scale), _snap16(ch * scale)
        work = (
            cv2.resize(crop_rgb, (gw, gh), interpolation=cv2.INTER_CUBIC)
            if (gw, gh) != (cw, ch)
            else crop_rgb
        )
        # mflux takes image *paths*, so stage the crop to a temp PNG.
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            cv2.imwrite(tmp, cv2.cvtColor(work, cv2.COLOR_RGB2BGR))
            out = self.model.generate_image(
                seed=self.seed,
                prompt=_EDIT_PROMPT,
                num_inference_steps=self.steps,
                height=gh,
                width=gw,
                guidance=self.guidance,
                image_paths=[tmp],
            )
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        res = np.array(out.image.convert("RGB"))
        if res.shape[:2] != (ch, cw):
            res = cv2.resize(res, (cw, ch), interpolation=cv2.INTER_AREA)
        return res  # RGB, crop-sized

    # -- the contract --------------------------------------------------------
    def inpaint_mask(self, image_pil, mask, *, verbose: bool = False,
                     strict_mask_clipping: bool = True, **_kw):
        """Redraw the masked region and return the full page with ONLY masked
        pixels changed. ``mask`` is a full-page boolean/0-255 array nonzero under
        the (dilated) glyphs; matches ``sidecar/clean.py::_run_flux``'s call."""
        import cv2
        import numpy as np
        from PIL import Image

        self.load_models()
        page = np.array(image_pil.convert("RGB"))
        H, W = page.shape[:2]
        m = np.asarray(mask).astype(bool)
        ys, xs = np.where(m)
        if xs.size == 0:
            return image_pil

        x0, x1 = int(xs.min()), int(xs.max()) + 1
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        bw, bh = x1 - x0, y1 - y0
        # Context padding around the glyphs (mirrors MangaTranslator's 50%/80px).
        pad = max(24, min(80, int(0.5 * max(bw, bh))))
        cx0, cy0 = max(0, x0 - pad), max(0, y0 - pad)
        cw = _snap16(min(W, x1 + pad) - cx0)
        ch = _snap16(min(H, y1 + pad) - cy0)
        if cw < 16 or ch < 16:
            return image_pil
        cx1, cy1 = cx0 + cw, cy0 + ch

        edited = self._edit(page[cy0:cy1, cx0:cx1])

        # Composite ONLY under the mask (strict): every other pixel stays the raw
        # page, so the patch differs from the original solely under the glyphs.
        result = page.copy()
        crop_mask = m[cy0:cy1, cx0:cx1]
        region = result[cy0:cy1, cx0:cx1]
        region[crop_mask] = edited[crop_mask]
        result[cy0:cy1, cx0:cx1] = region
        if verbose:
            print(f"[mflux] bbox=({cx0},{cy0}) {cw}x{ch} steps={self.steps} upscale={self.upscale}")
        return Image.fromarray(result)
