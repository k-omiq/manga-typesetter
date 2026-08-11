"""Entry point: `python -m sidecar` (and the PyInstaller binary target)."""

from __future__ import annotations

import os
import threading
import time

import uvicorn

from . import config


def _parent_alive(ppid: int) -> bool:
    """True while the host app that spawned us is still running.

    On POSIX, when the parent dies the child is reparented so ``getppid()`` no
    longer matches; ``kill(pid, 0)`` also then fails. Either signal means the
    app is gone. Errs on the side of "alive" for anything ambiguous.
    """
    if os.getppid() != ppid:
        return False
    try:
        os.kill(ppid, 0)  # signal 0 = existence check, sends nothing
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, just not ours to signal
    except OSError:
        return True


def _watch_parent(ppid: int) -> None:
    while True:
        time.sleep(2)
        if not _parent_alive(ppid):
            # Host app crashed / was killed without a graceful shutdown — exit so
            # we don't linger as an orphan holding the loopback port (which would
            # make the next launch's health poll spin then fail).
            os._exit(0)


def _watch_parent_windows(ppid: int) -> None:
    """Windows equivalent of :func:`_watch_parent`.

    ``getppid()`` isn't meaningful on Windows, so instead we open a handle to the
    parent by PID *once* and block on it with ``WaitForSingleObject``. Holding the
    handle pins the underlying process object, so PID reuse after the parent exits
    can't fool us — the wait is signalled exactly when *that* process ends, at
    which point we exit so we don't orphan (same rationale as the POSIX path).

    (A Job Object with ``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`` assigned from the
    Rust side is the more robust mechanism — the OS tears the child down with the
    job even on a hard app crash — but it needs a Windows-only dependency and
    unsafe FFI on the spawn side; this self-contained watchdog is the lighter
    choice and mirrors the existing thread.)
    """
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
        # Couldn't open the parent (already gone, or not permitted). Degrade to
        # "no watchdog" and err on the side of staying alive, matching the POSIX
        # path's treatment of ambiguous cases — Rust still kills us on a graceful
        # app exit; only a hard crash can then orphan us.
        return
    try:
        if kernel32.WaitForSingleObject(handle, INFINITE) == WAIT_OBJECT_0:
            os._exit(0)
    finally:
        kernel32.CloseHandle(handle)


def main() -> None:
    # Parent-death watchdog: exit the sidecar if the host app that spawned us
    # goes away, so a hard app crash can't orphan us holding the loopback port.
    # POSIX watches getppid()/kill(0); Windows waits on a handle to the parent
    # (getppid semantics don't carry over). See each watcher for details.
    if config.PARENT_PID > 1:
        watcher = _watch_parent if os.name == "posix" else (
            _watch_parent_windows if os.name == "nt" else None
        )
        if watcher is not None:
            threading.Thread(
                target=watcher, args=(config.PARENT_PID,), daemon=True
            ).start()

    uvicorn.run(
        "sidecar.main:app",
        host=config.HOST,
        port=config.PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
