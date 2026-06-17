"""PyInstaller entry point for the bundled `mt-sidecar` binary.

A top-level script (rather than `python -m sidecar`) so PyInstaller has a
concrete entry to analyze. We import the FastAPI app object and hand it to
uvicorn directly — the "sidecar.main:app" import-string form makes uvicorn
re-import the module, which is unreliable in a frozen bundle.

Built with PyInstaller --onedir (not --onefile): the one-file bootloader
extracts to a temp dir and re-execs, which deadlocks on this macOS/arm64 +
CPython 3.9 setup (uninterruptible processes that survive SIGKILL). The onedir
layout runs the embedded interpreter directly and is reliable.

Deliberately avoids importing `multiprocessing`: the sidecar runs a single
asyncio uvicorn worker and doesn't need it, and importing it inside a frozen
bundle can trigger a 'spawn' re-exec of the executable.
"""

from __future__ import annotations

import uvicorn

from sidecar import config
from sidecar.main import app


def main() -> None:
    # Force uvicorn's pure-Python event loop + HTTP parser. The optional C
    # extensions from uvicorn[standard] (uvloop, httptools) are excluded from
    # the bundle; asyncio + h11 are plenty for a localhost sidecar.
    uvicorn.run(
        app,
        host=config.HOST,
        port=config.PORT,
        log_level="info",
        loop="asyncio",
        http="h11",
    )


if __name__ == "__main__":
    main()
