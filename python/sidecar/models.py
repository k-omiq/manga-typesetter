"""Model cache inspection + clearing for the Settings panel.

Reports the on-disk footprint of the downloaded detection/OCR weights and can
free them. Everything the sidecar downloads (comic-text-detector, manga-ocr, the
panel YOLO) caches under ``config.MODEL_DIR``
(``~/.mangatypesetter/models`` by default).

"Clear cache" deletes those weights; they re-download lazily on the next Detect.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from . import config


def _cache_dirs() -> list[Path]:
    """The model-cache roots the sidecar knows about."""
    return [config.MODEL_DIR.resolve()]


def _dir_size(path: Path) -> int:
    """Total bytes of a directory tree (best-effort; unreadable entries skipped)."""
    total = 0
    for root, _dirs, files in os.walk(path, onerror=lambda _e: None):
        for name in files:
            fp = os.path.join(root, name)
            try:
                # Don't follow symlinks — count the link, not its (possibly shared) target.
                total += os.lstat(fp).st_size
            except OSError:
                continue
    return total


def cache_info() -> dict:
    """Per-root and total on-disk size of the downloaded model caches."""
    entries = []
    total = 0
    for d in _cache_dirs():
        exists = d.is_dir()
        size = _dir_size(d) if exists else 0
        total += size
        entries.append({"path": str(d), "exists": exists, "bytes": size})
    return {"entries": entries, "total_bytes": total}


def clear_cache() -> dict:
    """Delete the downloaded weights in every known cache root. Best-effort.

    Returns which roots were cleared, the freed byte count, and any errors. The
    sidecar's own ``MODEL_DIR`` is recreated afterwards so ``ensure_dirs``
    invariants hold for the next detect.
    """
    freed = 0
    cleared: list[str] = []
    errors: list[str] = []
    for d in _cache_dirs():
        if not d.is_dir():
            continue
        size = _dir_size(d)
        try:
            shutil.rmtree(d)
            freed += size
            cleared.append(str(d))
        except Exception as e:  # noqa: BLE001 — surface, don't abort the other roots
            errors.append(f"{d}: {e}")
    config.ensure_dirs()
    return {"ok": not errors, "cleared": cleared, "freed_bytes": freed, "errors": errors}
