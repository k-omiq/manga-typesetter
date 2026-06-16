"""Runtime configuration for the sidecar.

The host app passes settings via environment variables when it spawns the
process. All values have sane local-dev defaults so the sidecar can also be run
standalone.
"""

from __future__ import annotations

import os
from pathlib import Path

# Loopback only — the sidecar must never be reachable off-machine.
HOST = os.environ.get("MT_SIDECAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("MT_SIDECAR_PORT", "8765"))

# Shared secret the app injects so other local processes can't drive the sidecar.
# Empty in dev; enforced when set (checked in main.py).
TOKEN = os.environ.get("MT_SIDECAR_TOKEN", "")

# Where downloaded models are cached (manga-ocr, detector, optional FLUX).
MODEL_DIR = Path(os.environ.get("MT_MODEL_DIR", Path.home() / ".mangatypesetter" / "models"))


def ensure_dirs() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
