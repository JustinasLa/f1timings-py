import runpy
import sys
from pathlib import Path

import pytest
import uvicorn
from fastapi.testclient import TestClient

import app.main as main_module


REPO_ROOT = Path(__file__).resolve().parent.parent


def test_websocket_broadcast_with_no_clients_is_a_noop():
    import asyncio

    from app.services.websocket_manager import ConnectionManager

    manager = ConnectionManager()

    assert asyncio.run(manager.broadcast({"type": "ping"})) is None
    assert manager.active_connections == []


def test_validation_errors_return_422_with_details():
    client = TestClient(main_module.app)

    resp = client.post("/api/track", json={})

    assert resp.status_code == 422
    assert resp.json()["detail"][0]["loc"] == ["body", "name"]


def test_unhandled_exceptions_return_generic_500(monkeypatch):
    from app.api import display_data_routes

    def boom():
        raise RuntimeError("kaboom")

    monkeypatch.setattr(display_data_routes.track_service, "get_available_tracks", boom)
    client = TestClient(main_module.app, raise_server_exceptions=False)

    resp = client.get("/api/tracks")

    assert resp.status_code == 500
    assert resp.json() == {"detail": "An internal server error occurred."}


@pytest.mark.filterwarnings("ignore:'app.main' found in sys.modules:RuntimeWarning")
def test_running_main_module_starts_uvicorn(monkeypatch):
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setenv("HOST", "127.0.0.1")
    monkeypatch.setenv("PORT", "9001")

    runpy.run_module("app.main", run_name="__main__")

    assert calls == [(("app.main:app",), {"host": "127.0.0.1", "port": 9001, "reload": True})]


def test_running_app_py_starts_uvicorn_with_app(monkeypatch):
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.delenv("HOST", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    for name in [m for m in sys.modules if m == "app" or m.startswith("app.")]:
        monkeypatch.setitem(sys.modules, name, sys.modules[name])

    runpy.run_path(str(REPO_ROOT / "app.py"), run_name="__main__")

    [(args, kwargs)] = calls
    assert type(args[0]).__name__ == "FastAPI"
    assert kwargs == {"host": "0.0.0.0", "port": 8000}
    assert sys.modules["app"].__path__ == [str(REPO_ROOT / "app")]


def test_importing_app_py_does_not_start_server(monkeypatch):
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append(args))

    runpy.run_path(str(REPO_ROOT / "app.py"), run_name="not_main")

    assert calls == []
