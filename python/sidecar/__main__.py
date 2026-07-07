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


def main() -> None:
    # Parent-death watchdog (POSIX only; getppid semantics differ on Windows,
    # where a job object on the app side is the right mechanism instead).
    if config.PARENT_PID > 1 and os.name == "posix":
        threading.Thread(
            target=_watch_parent, args=(config.PARENT_PID,), daemon=True
        ).start()

    uvicorn.run(
        "sidecar.main:app",
        host=config.HOST,
        port=config.PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
