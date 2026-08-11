"""Lightweight smoke tests for the sidecar — the CI import/TestClient gate.

Deliberately import-only: these run with just the base ``requirements.txt`` (plus
``httpx`` for the TestClient) and must NOT pull in the heavy ML stack
(torch/opencv/manga-ocr) or the ``external/`` vendor trees, which CI does not
install. That works because ``sidecar.main`` imports ``detect``/``models``
*lazily inside the route handlers*, so building the app and hitting the metadata
routes touches none of them.
"""

from __future__ import annotations

from starlette.testclient import TestClient

from sidecar import config, main


def test_import_and_create_app():
    """`import sidecar.main` works and the app builds with base deps only."""
    app = main.create_app()
    assert app.title == "Manga Typesetter Sidecar"


def test_health_ok():
    """/health returns the status/version/device/model_dir payload."""
    client = TestClient(main.create_app())
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "device" in body and "model_dir" in body


def test_token_gate(monkeypatch):
    """With a token set, /health stays open but other routes require the header.

    The 401 fires in the auth middleware *before* the handler runs, so it needs
    none of the lazy ML imports — which is exactly why it's safe in the light CI
    job.
    """
    monkeypatch.setattr(config, "TOKEN", "secret-token")
    client = TestClient(main.create_app(), raise_server_exceptions=False)

    assert client.get("/health").status_code == 200  # health is exempt
    # A protected route without the header is rejected by the middleware.
    assert client.get("/models/cache").status_code == 401
    # ...and accepted past the gate with the right header.
    assert client.get("/models/cache", headers={"x-mt-token": "secret-token"}).status_code == 200
