"""Model cache inspection + clearing for the Settings panel.

Reports the on-disk footprint of the downloaded model weights and can free them.
Two cache roots are known to the sidecar:

- The MangaTranslator model manager writes FLUX weights (and any bubble/YOLO
  models it fetches) to ``./models`` resolved against the process CWD — for the
  sidecar spawned by the app that's ``python/models`` (multi-GB, gitignored).
  Mirrors ``core/ml/model_manager.py``'s ``Path("./models").resolve()``.
- The detector / OCR / panel models cache under ``config.MODEL_DIR``
  (``~/.mangatypesetter/models`` by default).

"Clear cache" deletes the *downloaded weights* in these roots; it does NOT
uninstall the optional FLUX python deps (that's the Settings "Download & Install"
path). Weights re-download lazily on next use. Note: clearing while a FLUX
inpainter is loaded only frees disk — the in-memory model stays until the sidecar
restarts; an in-flight clean that still needs to stream weights could fail, so it
is a user-initiated action surfaced behind an explicit button.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from . import config


def _cache_dirs() -> list[Path]:
    """The model-cache roots the sidecar knows about, de-duplicated.

    ``./models`` and ``config.MODEL_DIR`` can coincide (e.g. when the sidecar is
    launched from ``python/`` with ``MT_MODEL_DIR`` pointing there), so collapse
    to unique resolved paths to avoid double-counting sizes.
    """
    candidates = [Path("./models").resolve(), config.MODEL_DIR.resolve()]
    seen: set[Path] = set()
    uniq: list[Path] = []
    for d in candidates:
        if d not in seen:
            seen.add(d)
            uniq.append(d)
    return uniq


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
    invariants hold for the next detect/clean.
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
