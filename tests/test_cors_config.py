import importlib
import logging

import pytest
from fastapi.testclient import TestClient

import app.main as main_module


@pytest.fixture
def reload_main(monkeypatch):
    """Reload app.main with CORS_ORIGINS set (or unset), then restore it."""

    def _reload(value):
        if value is None:
            monkeypatch.delenv("CORS_ORIGINS", raising=False)
        else:
            monkeypatch.setenv("CORS_ORIGINS", value)
        importlib.reload(main_module)
        return main_module

    yield _reload

    # Teardown: reload once more with the env var removed so later test
    # modules import app.main in its default (no-CORS) state.
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    importlib.reload(main_module)


def test_no_env_var_means_no_cors_headers(reload_main):
    mod = reload_main(None)
    client = TestClient(mod.app)

    resp = client.get("/api/drivers", headers={"Origin": "http://evil.example"})

    assert "access-control-allow-origin" not in resp.headers


def test_allowed_origin_gets_acao_and_credentials(reload_main):
    mod = reload_main("http://a.example, http://b.example,")
    client = TestClient(mod.app)

    resp = client.get("/api/drivers", headers={"Origin": "http://a.example"})

    assert resp.headers.get("access-control-allow-origin") == "http://a.example"
    assert resp.headers.get("access-control-allow-credentials") == "true"


def test_disallowed_origin_gets_no_acao_header(reload_main):
    mod = reload_main("http://a.example, http://b.example,")
    client = TestClient(mod.app)

    resp = client.get("/api/drivers", headers={"Origin": "http://evil.example"})

    assert "access-control-allow-origin" not in resp.headers


def test_wildcard_origin_disables_credentials_and_warns(reload_main, caplog):
    with caplog.at_level(logging.WARNING, logger="app.main"):
        mod = reload_main("*")

    client = TestClient(mod.app)
    resp = client.get("/api/drivers", headers={"Origin": "http://evil.example"})

    assert resp.headers.get("access-control-allow-origin") == "*"
    assert "access-control-allow-credentials" not in resp.headers
    assert any(
        "wildcard" in record.message.lower() for record in caplog.records
    )
