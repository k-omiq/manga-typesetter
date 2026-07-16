"""Entry point: ``python -m flux_sidecar`` (run under the external FLUX venv)."""

from __future__ import annotations

import uvicorn

from . import config
from ._util import stabilize_model_cwd, start_parent_watchdog


def main() -> None:
    # Make MangaTranslator's relative ``./models`` weight cache land somewhere
    # writable (must run before any inpainter/model-manager import).
    stabilize_model_cwd(config.MODEL_DIR)

    # Exit if the base sidecar that spawned us dies, so a crash can't orphan this
    # heavy process holding its port.
    start_parent_watchdog(config.PARENT_PID)

    uvicorn.run(
        "flux_sidecar.app:create_app",
        factory=True,
        host=config.HOST,
        port=config.PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
