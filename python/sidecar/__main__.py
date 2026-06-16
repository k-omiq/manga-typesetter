"""Entry point: `python -m sidecar` (and the PyInstaller binary target)."""

from __future__ import annotations

import uvicorn

from . import config


def main() -> None:
    uvicorn.run(
        "sidecar.main:app",
        host=config.HOST,
        port=config.PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
