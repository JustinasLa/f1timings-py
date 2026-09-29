import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app.main as main_module

client = TestClient(main_module.app)


def _stop(**headers):
    return client.post("/api/telemetry/stop", headers=headers)


def test_cross_origin_post_is_forbidden():
    resp = _stop(Origin="http://evil.example")
    assert resp.status_code == 403


def test_null_origin_post_is_forbidden():
    assert _stop(Origin="null").status_code == 403


def test_same_origin_post_reaches_handler():
    resp = _stop(Origin="http://testserver")
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Telemetry listener is not running."


def test_post_without_origin_reaches_handler():
    assert _stop().status_code == 400


def test_configured_cors_origin_may_post(monkeypatch):
    monkeypatch.setattr(main_module, "cors_origins", ["http://ok.example"])
    assert _stop(Origin="http://ok.example").status_code == 400


def test_cross_origin_get_is_unaffected():
    resp = client.get("/api/track", headers={"Origin": "http://evil.example"})
    assert resp.status_code == 200


def test_unknown_host_is_rejected():
    resp = client.get("/api/track", headers={"Host": "attacker.example"})
    assert resp.status_code == 400


@pytest.mark.parametrize(
    "host",
    ["localhost", "localhost:8000", "127.0.0.1:8000", "192.168.1.20", "[::1]:8000"],
)
def test_localhost_and_ip_literal_hosts_are_allowed(host):
    resp = client.get("/api/track", headers={"Host": host})
    assert resp.status_code == 200


def test_machine_hostname_is_allowed():
    name = main_module.socket.gethostname()
    for host in (name.upper(), f"{name}.local:8000"):
        resp = client.get("/api/track", headers={"Host": host})
        assert resp.status_code == 200


def test_allowed_hosts_entry_is_allowed(monkeypatch):
    monkeypatch.setattr(
        main_module, "allowed_hosts", main_module.allowed_hosts | {"f1.lan"}
    )
    resp = client.get("/api/track", headers={"Host": "F1.lan:8000"})
    assert resp.status_code == 200


def test_same_origin_post_from_lan_ip_is_allowed():
    resp = _stop(Host="192.168.1.20:8000", Origin="http://192.168.1.20:8000")
    assert resp.status_code == 400


def test_websocket_with_foreign_origin_is_rejected():
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"Origin": "http://evil.example"}):
            pass


def test_websocket_with_bad_host_is_rejected():
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"Host": "attacker.example"}):
            pass


def test_websocket_same_origin_connects():
    with client.websocket_connect("/ws", headers={"Origin": "http://testserver"}):
        assert len(main_module.manager.active_connections) == 1
