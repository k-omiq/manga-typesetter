"""Entry point: ``python -m flux_sidecar`` (run under the external FLUX venv)."""

from __future__ import annotations

import os
import sys

import uvicorn

from . import config
from ._util import stabilize_model_cwd, start_parent_watchdog


def main() -> None:
    # Make MangaTranslator's relative ``./models`` weight cache land somewhere
    # writable (must run before any inpainter/model-manager import).
    stabilize_model_cwd(config.MODEL_DIR)

    # Bound the MPS allocator on Apple Silicon (must be set before torch loads —
    # torch reads it once when the MPS allocator initialises; torch itself is
    # only imported lazily on the first /inpaint, well after this line). The
    # default high-watermark ratio is 1.7× the GPU's recommended working-set
    # size (~22 GB on a 32 GB machine → ~37 GB!), which lets the diffusion
    # allocator overcommit far past physical RAM and drive the whole machine
    # into compressor/swap thrash — the observed "~20 GB and stuck" failure.
    # 1.0 caps allocations at the recommended working-set size instead: a
    # runaway now fails fast with an MPS OOM (→ the cleaner's classical
    # fallback) rather than freezing the Mac. The LOW watermark (where the
    # allocator starts releasing cached blocks) must be ≤ the high one — its
    # default is 1.4, and torch hard-errors on low > high — so set both.
    # Users can still override via their own env.
    if config.LOW_MEM and sys.platform == "darwin":
        os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "1.0")
        os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.8")

    # Exit if the base sidecar that spawned us dies, so a crash can't orphan this
    # heavy process holding its port.
    start_parent_watchdog(config.PARENT_PID)

    # ws="none": mt-flux serves only HTTP POST /inpaint — it has no websocket
    # endpoints. The default ws="auto" makes uvicorn import its websockets
    # autodetect at startup, which crashes the whole child if a *partial*
    # websockets package leaks onto its path (e.g. the frozen base app's bundled
    # copy contaminating the spawned external-venv interpreter): `import
    # websockets` succeeds but `websockets.exceptions` is missing → uncaught
    # ModuleNotFoundError → the child never comes up → every FLUX region silently
    # falls back to classical inpaint. Disabling ws entirely removes that failure
    # mode — the child can't depend on a package it never uses.
    uvicorn.run(
        "flux_sidecar.app:create_app",
        factory=True,
        host=config.HOST,
        port=config.PORT,
        log_level="info",
        ws="none",
    )


if __name__ == "__main__":
    main()
