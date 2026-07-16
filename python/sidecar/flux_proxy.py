"""Manage the out-of-process ``mt-flux`` sidecar and proxy inpaint calls to it.

FLUX runs in a *separate* process under an external, uv-provisioned venv (see
``flux.py``), because the heavy diffusers/sdnq stack can't be installed into the
frozen base app. This module owns that process's lifecycle — spawn it lazily on
the first FLUX region, health-check it, reuse it, and restart it when the model
selection changes — and hands the cleaner a small proxy object that looks exactly
like MangaTranslator's in-process inpainter (``.inpaint_mask``) but forwards each
region crop over loopback.

The child inherits our stdout/stderr (the base sidecar's, which Rust already
pipes to the app log), so its startup/import errors are visible and there's no
pipe-drain deadlock. Its own parent-death watchdog exits it if we die.
"""

from __future__ import annotations

import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import config, flux, flux_models

# First /inpaint on a fresh model also fetches multi-GB weights, so allow a long
# ceiling; on timeout the cleaner just falls back to classical inpaint for that
# region (see clean._run_flux). Health/startup is quick (no model load).
_INPAINT_TIMEOUT = 3600
_HEALTH_TIMEOUT = 60

_lock = threading.Lock()
_proc: subprocess.Popen | None = None
_port: int | None = None
_token: str | None = None
_sig: tuple | None = None  # selection signature the current child was spawned for
_shutting_down = False  # set by shutdown() so an in-flight spawn aborts promptly


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _selection_sig(sel: dict) -> tuple:
    """Identity of a spawn: model choice + whether an HF token is in play.

    A change here means the running child is for the wrong model and must restart.
    """
    return (
        sel["family"],
        sel["variant"],
        sel["backend"],
        sel["quant"],
        sel["text_encoder_quant"],
        sel["steps"],
        sel["upscale"],
        bool(flux.hf_token()),
    )


def _base_url(port: int) -> str:
    return f"http://127.0.0.1:{port}"


def _get_health(port: int, token: str) -> dict | None:
    req = urllib.request.Request(_base_url(port) + "/health")
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.loads(r.read())
    except (urllib.error.URLError, OSError, ValueError):
        return None


def _child_alive() -> bool:
    return _proc is not None and _proc.poll() is None


def _shutdown_locked() -> None:
    global _proc, _port, _token, _sig
    if _proc is not None:
        try:
            _proc.terminate()
            try:
                _proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _proc.kill()
                try:
                    _proc.wait(timeout=5)  # reap after the hard kill, no zombie
                except subprocess.TimeoutExpired:
                    pass
        except OSError:
            pass
    _proc = _port = _token = _sig = None


def _spawn_locked(sel: dict) -> bool:
    """Spawn mt-flux for `sel` and wait until /health is up. Returns success."""
    global _proc, _port, _token, _sig

    py = flux.venv_python()
    if py is None:
        return False

    port = _free_port()
    token = os.urandom(24).hex()

    env = os.environ.copy()
    # The child is a DIFFERENT interpreter (the external uv venv). Scrub venv/
    # interpreter vars inherited from the base process so they can't shadow the
    # external venv's packages (PYTHONPATH), point it at the wrong site-packages
    # (VIRTUAL_ENV), or break it outright (PYTHONHOME).
    for var in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"):
        env.pop(var, None)
    env.update(
        {
            "MT_FLUX_HOST": "127.0.0.1",
            "MT_FLUX_PORT": str(port),
            "MT_FLUX_TOKEN": token,
            # The child's watchdog exits it if we (the base sidecar) go away.
            "MT_FLUX_PARENT_PID": str(os.getpid()),
            "MT_FLUX_MT_DIR": str(flux._MT_DIR),
            "MT_MODEL_DIR": str(config.MODEL_DIR),
        }
    )
    env.update(flux_models.spawn_env(sel, hf_token=flux.hf_token()))
    # `python -m flux_sidecar` must resolve the package: PYTHONPATH is exactly its
    # source dir (scrubbed above, so nothing from the base process leaks in).
    env["PYTHONPATH"] = str(flux.flux_src_dir())

    try:
        proc = subprocess.Popen([str(py), "-m", "flux_sidecar"], env=env)
    except OSError:
        return False

    # Poll /health until the uvicorn app is serving (or the child dies / times out).
    deadline = time.monotonic() + _HEALTH_TIMEOUT
    while time.monotonic() < deadline:
        if _shutting_down:  # app is exiting — abort the spawn and free the lock
            break
        if proc.poll() is not None:  # child exited during startup (poll reaps it)
            return False
        health = _get_health(port, token)
        # Defense-in-depth: only accept a /health that reports OUR model. The port
        # is ephemeral so a foreign squatter is unlikely, but this closes the
        # free_port()→bind TOCTOU window rather than trusting any responder.
        if health is not None and _health_matches(health, sel):
            _proc, _port, _token, _sig = proc, port, token, _selection_sig(sel)
            return True
        time.sleep(0.25)

    # Timed out coming up — don't leak the process; terminate and reap it.
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return False


def _health_matches(health: dict, sel: dict) -> bool:
    """True if a /health payload reports the model we asked this child to run."""
    m = health.get("model") or {}
    return (
        m.get("family") == sel["family"]
        and (m.get("variant") or "") == (sel["variant"] or "")
        and m.get("backend") == sel["backend"]
    )


def _ensure_running_locked() -> tuple[int, str] | None:
    sel = flux.saved_selection()
    sig = _selection_sig(sel)
    if _child_alive() and _sig == sig and _port is not None and _token is not None:
        return _port, _token
    _shutdown_locked()  # dead, or configured for a different model
    if _spawn_locked(sel):
        return _port, _token  # type: ignore[return-value]
    return None


def get_proxy_inpainter():
    """Return a proxy inpainter backed by mt-flux, or None if unavailable.

    None means the cleaner should try its in-process path / classical fallback:
    the external env isn't provisioned, or the child wouldn't come up.
    """
    if not flux.env_provisioned():
        return None
    with _lock:
        running = _ensure_running_locked()
    if running is None:
        return None
    port, token = running
    return _ProxyInpainter(_base_url(port), token)


def status() -> dict:
    """Whether the FLUX process is up, and for which model (Settings panel).

    Deliberately lock-free: a best-effort snapshot of the module globals (atomic
    reads under the GIL). Taking ``_lock`` here would block the Settings status
    poll for up to the full spawn timeout while the first FLUX region is bringing
    the child up.
    """
    proc, port, token = _proc, _port, _token
    alive = proc is not None and proc.poll() is None
    health = _get_health(port, token) if (alive and port and token) else None
    return {"running": bool(alive), "port": port if alive else None, "health": health}


def shutdown() -> None:
    """Terminate the FLUX process (call on base-sidecar shutdown).

    Signals any in-flight spawn to abort first (so its poll loop drops ``_lock``
    within a tick) — otherwise a shutdown racing the first spawn would block for
    the whole spawn timeout.
    """
    global _shutting_down
    _shutting_down = True
    with _lock:
        _shutdown_locked()


class _ProxyInpainter:
    """Drop-in for MangaTranslator's inpainter: forwards ``inpaint_mask`` to mt-flux.

    Matches the call the cleaner makes — ``inpaint_mask(pil, mask_bool,
    verbose=...)`` — encoding the crop + mask as PNG, POSTing to ``/inpaint``, and
    decoding the redrawn crop back to a PIL image.
    """

    def __init__(self, base_url: str, token: str):
        self._url = base_url + "/inpaint"
        self._token = token

    def inpaint_mask(self, image_pil, mask_np, seed: int = 1, verbose: bool = False, **_ignored):
        import base64

        import numpy as np
        from PIL import Image

        img_buf = io.BytesIO()
        image_pil.convert("RGB").save(img_buf, format="PNG")

        mask_arr = (np.asarray(mask_np) > 0).astype("uint8") * 255
        mask_buf = io.BytesIO()
        Image.fromarray(mask_arr, mode="L").save(mask_buf, format="PNG")

        payload = json.dumps(
            {
                "image_b64": base64.b64encode(img_buf.getvalue()).decode("ascii"),
                "mask_b64": base64.b64encode(mask_buf.getvalue()).decode("ascii"),
                "seed": seed,
            }
        ).encode("ascii")

        req = urllib.request.Request(
            self._url,
            data=payload,
            headers={"content-type": "application/json", "x-mt-token": self._token},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=_INPAINT_TIMEOUT) as r:
            out = json.loads(r.read())
        data = base64.b64decode(out["image_b64"])
        return Image.open(io.BytesIO(data)).convert("RGB")
