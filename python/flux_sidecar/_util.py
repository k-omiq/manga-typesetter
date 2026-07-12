"""Process hygiene: parent-death watchdog + writable model-cache CWD.

Self-contained (stdlib only) copies of the mechanisms in ``sidecar/__main__.py``.
This process runs under a *different* interpreter/venv than the base sidecar and
ships as an independent unit, so it carries its own copies rather than importing
the base package.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path


def stabilize_model_cwd(model_dir: Path) -> None:
    """Pin the CWD so MangaTranslator's relative ``./models`` cache is writable.

    MangaTranslator caches FLUX weights at ``Path("./models")`` — relative to the
    process CWD. This process is spawned by the base sidecar without a controlled
    CWD, so ``./models`` could resolve somewhere unwritable (e.g. ``/`` on macOS).
    chdir into ``model_dir``'s parent so ``./models`` coincides with ``model_dir``
    (``~/.mangatypesetter/models`` by default) — the same location the base
    sidecar's cache size/clear already manages. See docs/FLUX_PACKAGING.md.
    """
    target = model_dir.resolve().parent
    try:
        target.mkdir(parents=True, exist_ok=True)
        os.chdir(target)
    except OSError:
        pass  # best-effort; a failed chdir just leaves the inherited CWD


def _parent_alive_posix(ppid: int) -> bool:
    if os.getppid() != ppid:
        return False
    try:
        os.kill(ppid, 0)  # signal 0 = existence check
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True


def _watch_parent_posix(ppid: int) -> None:
    while True:
        time.sleep(2)
        if not _parent_alive_posix(ppid):
            os._exit(0)


def _watch_parent_windows(ppid: int) -> None:
    import ctypes
    from ctypes import wintypes

    SYNCHRONIZE = 0x00100000
    WAIT_OBJECT_0 = 0x00000000
    INFINITE = 0xFFFFFFFF

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)

    handle = kernel32.OpenProcess(SYNCHRONIZE, False, ppid)
    if not handle:
        return  # couldn't open parent → degrade to no-watchdog (stay alive)
    try:
        if kernel32.WaitForSingleObject(handle, INFINITE) == WAIT_OBJECT_0:
            os._exit(0)
    finally:
        kernel32.CloseHandle(handle)


def start_parent_watchdog(ppid: int) -> None:
    """Exit this process if the spawning parent (the base sidecar) dies.

    Prevents a hard app/base-sidecar crash from orphaning the heavy FLUX process
    holding its loopback port. No-op for ppid <= 1 (hand-run).
    """
    if ppid <= 1:
        return
    watcher = _watch_parent_posix if os.name == "posix" else (
        _watch_parent_windows if os.name == "nt" else None
    )
    if watcher is not None:
        threading.Thread(target=watcher, args=(ppid,), daemon=True).start()


def ensure_mt_on_path(mt_dir: Path) -> None:
    """Put the vendored MangaTranslator tree on sys.path (idempotent)."""
    s = str(mt_dir)
    if s not in sys.path:
        sys.path.insert(0, s)
