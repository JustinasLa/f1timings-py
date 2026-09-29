import asyncio
import socket
import threading
from types import SimpleNamespace

import pytest

from app.api import udp_telemetry_routes
from app.services import lap_time_store
from app.services.lap_time_store import app_data

MONACO_TRACK_ID = 5


def _session_packet(track_id):
    return SimpleNamespace(
        header=SimpleNamespace(packet_id=1),
        track_id=track_id,
        network_game=0,
        game_paused=0,
        session_type=13,
        session_link_identifier=0,
        session_time_left=0,
        session_duration=0,
        pit_speed_limit=80,
        weather=0,
        track_temperature=30,
        air_temperature=25,
        time_of_day=0,
    )


def _participants_packet(name):
    return SimpleNamespace(
        header=SimpleNamespace(packet_id=4),
        num_active_cars=1,
        participants=[SimpleNamespace(name=name.encode(), team_id=0)],
    )


def _lap_packet(last_lap_ms):
    return SimpleNamespace(
        header=SimpleNamespace(packet_id=2),
        lap_data=[SimpleNamespace(last_lap_time_in_ms=last_lap_ms, current_lap_invalid=0)],
    )


class FakeWebsocketManager:
    def __init__(self):
        self.messages = []

    async def broadcast(self, message):
        self.messages.append(message)


@pytest.fixture
def worker_env(monkeypatch):
    monkeypatch.setattr(app_data, "drivers", {})
    monkeypatch.setattr(app_data, "track_name", None)

    saves = []

    def fake_save_lap_record(track, driver_name, *args, **kwargs):
        saves.append((track, driver_name))
        return True

    ws = FakeWebsocketManager()
    monkeypatch.setattr(lap_time_store, "save_lap_record", fake_save_lap_record)
    monkeypatch.setattr(lap_time_store, "websocket_manager", ws)

    def fake_submit(coro, what):
        asyncio.run(coro)
        return object()

    monkeypatch.setattr(udp_telemetry_routes, "_submit_to_main_loop", fake_submit)
    monkeypatch.setattr(
        udp_telemetry_routes,
        "TelemetryListener",
        lambda port, host: SimpleNamespace(socket=None),
    )
    udp_telemetry_routes._clear_listener_state()
    udp_telemetry_routes.set_main_event_loop(object())

    yield saves, ws

    udp_telemetry_routes.set_main_event_loop(None)
    udp_telemetry_routes._clear_listener_state()


def _run_worker(monkeypatch, packets, sender_ip="10.0.0.2"):
    stop_event = threading.Event()
    queue = list(packets)

    def fake_parse(listener_instance):
        if not queue:
            stop_event.set()
            raise socket.timeout()
        return queue.pop(0), (sender_ip, 20777)

    monkeypatch.setattr(udp_telemetry_routes, "_parse_packet_with_sender", fake_parse)
    udp_telemetry_routes.telemetry_listener_worker("0.0.0.0", 20777, stop_event)


def test_lap_saved_to_source_session_track_not_displayed_track(worker_env, monkeypatch):
    saves, ws = worker_env
    udp_telemetry_routes._last_auto_set_track_id = MONACO_TRACK_ID
    app_data.track_name = "monza"

    _run_worker(
        monkeypatch,
        [
            _session_packet(MONACO_TRACK_ID),
            _participants_packet("Hamilton"),
            _lap_packet(0),
            _lap_packet(75123),
        ],
    )

    assert saves == [("monaco", "Hamilton")]
    assert app_data.track_name == "monza"
    lap_messages = [m for m in ws.messages if m["type"] == "laptime_update"]
    assert len(lap_messages) == 1
    assert lap_messages[0]["data"]["track"] == "monaco"


def test_lap_falls_back_to_displayed_track_without_known_source_track(worker_env, monkeypatch):
    saves, ws = worker_env
    app_data.track_name = "monza"

    _run_worker(
        monkeypatch,
        [
            _participants_packet("Hamilton"),
            _lap_packet(0),
            _lap_packet(75123),
        ],
    )

    assert saves == [("monza", "Hamilton")]
    lap_messages = [m for m in ws.messages if m["type"] == "laptime_update"]
    assert lap_messages[0]["data"]["track"] == "monza"
