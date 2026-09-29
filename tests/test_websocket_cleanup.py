import asyncio
import contextlib
import logging
import threading

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocket as StarletteWebSocket

import app.main as main_module
from app.services.websocket_manager import ConnectionManager


def test_client_disconnect_removes_connection():
    client = TestClient(main_module.app)
    with client.websocket_connect("/ws") as ws:
        assert len(main_module.manager.active_connections) == 1
    assert len(main_module.manager.active_connections) == 0


def test_non_disconnect_exception_still_removes_connection(monkeypatch):

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


class _RecordingWebSocket:
    def __init__(self, send_behavior=None, close_behavior=None):
        self.client = ("127.0.0.1", 12345)
        self.sent = []
        self.closed = 0
        self._send_behavior = send_behavior
        self._close_behavior = close_behavior

    async def send_json(self, message):
        if self._send_behavior:
            await self._send_behavior()
        self.sent.append(message)

    async def close(self):
        self.closed += 1
        if self._close_behavior:
            await self._close_behavior()


async def _raise_send():
    raise RuntimeError("send exploded")


async def _hang():
    await asyncio.sleep(3600)


async def _raise_close():
    raise RuntimeError("close exploded")


@pytest.fixture
def fast_timeouts(monkeypatch):
    real_wait_for = asyncio.wait_for
    monkeypatch.setattr(
        asyncio,
        "wait_for",
        lambda aw, timeout: real_wait_for(aw, timeout=0.05),
    )


@pytest.mark.parametrize("send_behavior", [_raise_send, _hang])
def test_failed_send_closes_and_removes_connection_others_still_receive(
    send_behavior, fast_timeouts
):
    mgr = ConnectionManager()
    bad = _RecordingWebSocket(send_behavior=send_behavior)
    good = _RecordingWebSocket()
    mgr.active_connections.extend([bad, good])

    asyncio.run(mgr.broadcast({"x": 1}))

    assert bad.closed == 1
    assert bad not in mgr.active_connections
    assert good.closed == 0
    assert good.sent == [{"x": 1}]
    assert mgr.active_connections == [good]


@pytest.mark.parametrize("close_behavior", [_raise_close, _hang])
def test_failing_or_hanging_close_does_not_break_broadcast(close_behavior, fast_timeouts):
    mgr = ConnectionManager()
    bad = _RecordingWebSocket(send_behavior=_raise_send, close_behavior=close_behavior)
    good = _RecordingWebSocket()
    mgr.active_connections.extend([bad, good])

    async def run():
        async with asyncio.timeout(5):
            await mgr.broadcast({"x": 1})

    asyncio.run(run())

    assert bad.closed == 1
    assert bad not in mgr.active_connections
    assert good.sent == [{"x": 1}]


def test_server_side_close_ends_ws_endpoint_cleanly(monkeypatch):
    async def boom(self, message):
        raise RuntimeError("send exploded")

    with TestClient(main_module.app) as client, client.websocket_connect("/ws") as ws:
        monkeypatch.setattr(StarletteWebSocket, "send_json", boom)
        client.portal.call(main_module.manager.broadcast, {"x": 1})
        monkeypatch.undo()
        outcome = []

        def receive():
            try:
                ws.receive_text()
            except Exception as exc:
                outcome.append(exc)

        receiver = threading.Thread(target=receive, daemon=True)
        receiver.start()
        receiver.join(timeout=5)
        assert outcome and type(outcome[0]).__name__ == "WebSocketDisconnect"
    assert main_module.manager.active_connections == []
    main_module.manager.disconnect(object())
