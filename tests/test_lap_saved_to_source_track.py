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
    # A packet may be given as (ip, packet) to override sender_ip for that packet.
    stop_event = threading.Event()
    queue = list(packets)

    def fake_parse(listener_instance):
        if not queue:
            stop_event.set()
            raise socket.timeout()
        item = queue.pop(0)
        ip, packet = item if isinstance(item, tuple) else (sender_ip, item)
        return packet, (ip, 20777)

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


def test_each_sender_lap_saved_to_its_own_session_track(worker_env, monkeypatch):
    saves, ws = worker_env
    app_data.track_name = "spain"
    a, b = "10.0.0.2", "10.0.0.3"

    # Both sessions are announced before either lap, so the displayed track
    # has already moved on to the last-announced one (monza) when A's lap lands.
    _run_worker(
        monkeypatch,
        [
            (a, _session_packet(5)),
            (a, _participants_packet("Hamilton")),
            (a, _lap_packet(0)),
            (b, _session_packet(11)),
            (b, _participants_packet("Verstappen")),
            (b, _lap_packet(0)),
            (a, _lap_packet(75123)),
            (b, _lap_packet(80456)),
        ],
    )

    assert sorted(saves) == [("monaco", "Hamilton"), ("monza", "Verstappen")]
    # Displayed track auto-follows the most recent Session packet; save target does not.
    assert app_data.track_name == "monza"
    tracks = {
        m["data"]["name"]: m["data"]["track"]
        for m in ws.messages
        if m["type"] == "laptime_update"
    }
    assert tracks == {"Hamilton": "monaco", "Verstappen": "monza"}


@pytest.mark.parametrize("unmapped_track_id", [255, -1])
def test_lap_falls_back_to_displayed_track_when_source_track_id_unmapped(
    worker_env, monkeypatch, unmapped_track_id
):
    saves, ws = worker_env
    app_data.track_name = "spain"

    _run_worker(
        monkeypatch,
        [
            _session_packet(unmapped_track_id),
            _participants_packet("Hamilton"),
            _lap_packet(0),
            _lap_packet(75123),
        ],
    )

    assert saves == [("spain", "Hamilton")]
    assert app_data.track_name == "spain"
    lap_messages = [m for m in ws.messages if m["type"] == "laptime_update"]
    assert len(lap_messages) == 1
    assert lap_messages[0]["data"]["track"] == "spain"


@pytest.mark.parametrize("short_track_id", [21, 22, 23, 24])
def test_short_layout_lap_not_saved_and_display_track_unchanged(
    worker_env, monkeypatch, caplog, short_track_id
):
    saves, ws = worker_env
    app_data.track_name = "spain"

    with caplog.at_level("WARNING", logger=udp_telemetry_routes.logger.name):
        _run_worker(
            monkeypatch,
            [
                _session_packet(short_track_id),
                _session_packet(short_track_id),
                _participants_packet("Hamilton"),
                _lap_packet(0),
                _lap_packet(60123),
                _lap_packet(61456),
            ],
        )

    assert saves == []
    assert app_data.track_name == "spain"
    assert [m for m in ws.messages if m["type"] == "laptime_update"] == []
    assert len([r for r in caplog.records if r.levelname == "WARNING"]) == 1


def test_full_circuit_lap_still_saved_after_short_layout_id_removed(worker_env, monkeypatch):
    saves, ws = worker_env
    app_data.track_name = "spain"

    _run_worker(
        monkeypatch,
        [
            _session_packet(3),
            _participants_packet("Hamilton"),
            _lap_packet(0),
            _lap_packet(95123),
        ],
    )

    assert saves == [("bahrain", "Hamilton")]
    assert app_data.track_name == "bahrain"
