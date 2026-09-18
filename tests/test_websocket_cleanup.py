import asyncio
import contextlib
import logging

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocket as StarletteWebSocket

import app.main as main_module
from app.services.websocket_manager import ConnectionManager


# app.main can be importlib.reload()-ed by other test modules (see
# test_cors_config.py), which rebinds app.main.app/app.main.manager to new
# objects. Look them up at test-run time via main_module, not at import time,
# so this test stays correct regardless of module import/run order.


def test_client_disconnect_removes_connection():
    """Client-initiated close (WebSocketDisconnect path) drops the connection."""
    client = TestClient(main_module.app)
    with client.websocket_connect("/ws") as ws:
        assert len(main_module.manager.active_connections) == 1
    assert len(main_module.manager.active_connections) == 0


def test_non_disconnect_exception_still_removes_connection(monkeypatch):
    """A non-WebSocketDisconnect error on the server side still cleans up via finally."""

    async def boom(self, *args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(StarletteWebSocket, "receive_text", boom)

    client = TestClient(main_module.app)
    with contextlib.suppress(Exception):
        with client.websocket_connect("/ws") as ws:
            with contextlib.suppress(Exception):
                ws.send_text("hi")
            with contextlib.suppress(Exception):
                ws.receive_text()

    assert len(main_module.manager.active_connections) == 0


class _FakeWebSocket:
    def __init__(self):
        self.client = ("127.0.0.1", 12345)

    async def send_json(self, message):
        raise RuntimeError("send exploded")


def test_broadcast_drops_client_and_logs_warning_on_send_failure(caplog):
    mgr = ConnectionManager()
    fake = _FakeWebSocket()
    mgr.active_connections.append(fake)

    with caplog.at_level(logging.WARNING, logger="app.services.websocket_manager"):
        asyncio.run(mgr.broadcast({"x": 1}))

    assert fake not in mgr.active_connections
    assert any("send failed" in record.message for record in caplog.records)
