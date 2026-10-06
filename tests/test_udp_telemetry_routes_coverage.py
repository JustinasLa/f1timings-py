import asyncio
import concurrent.futures
import ctypes
import importlib.util
import logging
import sys
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api import udp_telemetry_routes as routes
from app.main import app
from app.services import lap_time_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    monkeypatch.setattr(routes, "raw_capture_enabled", False)
    monkeypatch.setattr(routes, "_main_event_loop", None)
    routes._clear_listener_state()
    yield
    routes._clear_listener_state()


# ---------------------------------------------------------------- helpers


def test_should_process_packet_accepts_everything_when_filtering_disabled(monkeypatch):
    assert routes.should_process_packet(3) is False
    monkeypatch.setattr(routes, "ENABLE_PACKET_FILTERING", False)
    assert routes.should_process_packet(3) is True
    assert routes.should_process_packet(99) is True


@pytest.mark.parametrize(
    "ms, expected",
    [
        (None, "0:00.000"),
        (0, "0:00.000"),
        (-5, "0:00.000"),
        (75123, "1:15.123"),
        # fractional part rounds up to 1000ms -> clamped to 999
        (59999.7, "0:59.999"),
    ],
)
def test_ms_to_laptime_str(ms, expected):
    assert routes.ms_to_laptime_str(ms) == expected


def test_set_alias_rejects_blank_telemetry_name():
    resp = client.post(
        "/api/telemetry/driver_alias",
        json={"telemetry_name": "   ", "display_name": "Lewis"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Telemetry name cannot be empty"
    assert routes.driver_name_aliases == {}


# ------------------------------------------------------ _submit_to_main_loop


def test_submit_to_closed_loop_drops_and_closes_coroutine(monkeypatch, caplog):
    loop = asyncio.new_event_loop()
    loop.close()
    monkeypatch.setattr(routes, "_main_event_loop", loop)

    async def work():
        return 1

    coro = work()
    with caplog.at_level(logging.WARNING, logger=routes.logger.name):
        assert routes._submit_to_main_loop(coro, "Auto-save lap") is None

    assert coro.cr_frame is None  # closed, so no "never awaited" warning
    assert [r.getMessage() for r in caplog.records] == [
        "Auto-save lap dropped: main loop unavailable"
    ]


def test_submit_logs_warning_when_future_cancelled(monkeypatch, caplog):
    future = concurrent.futures.Future()
    submitted = []

    def fake_run_coroutine_threadsafe(coro, loop):
        submitted.append(loop)
        coro.close()
        return future

    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", fake_run_coroutine_threadsafe)
    loop_marker = object()
    monkeypatch.setattr(routes, "_main_event_loop", loop_marker)

    async def work():
        return 1

    with caplog.at_level(logging.WARNING, logger=routes.logger.name):
        assert routes._submit_to_main_loop(work(), "Auto track set") is future
        assert future.cancel() is True

    assert submitted == [loop_marker]
    messages = [r.getMessage() for r in caplog.records]
    assert messages == ["Auto track set was cancelled"]
    assert all(r.levelno == logging.WARNING for r in caplog.records)


# -------------------------------------------------- packet parsing / ctypes


def test_parse_packet_with_sender_unpacks_real_packet():
    cls = routes.HEADER_FIELD_TO_PACKET_TYPE[(2024, 1, 1)]
    packet = cls()
    packet.header.packet_format = 2024
    packet.header.packet_version = 1
    packet.header.packet_id = 1
    packet.track_id = 11
    raw = bytes(packet)
    # F1 24 spec: 753 bytes, 64 forecast samples, timeOfDay at offset 696
    assert len(raw) == 753
    raw = raw[:696] + (720).to_bytes(4, "little") + raw[700:]

    calls = []

    class FakeSocket:
        def recvfrom(self, size):
            calls.append(size)
            return raw, ("10.0.0.9", 5000)

    parsed, sender = routes._parse_packet_with_sender(SimpleNamespace(socket=FakeSocket()))

    assert calls == [2048]
    assert sender == ("10.0.0.9", 5000)
    assert isinstance(parsed, cls)
    assert parsed.header.packet_id == 1
    assert parsed.track_id == 11
    assert parsed.time_of_day == 720


class _Inner(ctypes.Structure):
    _fields_ = [("speed", ctypes.c_uint16), ("label", ctypes.c_char * 8)]


class _Outer(ctypes.Structure):
    _fields_ = [
        ("id", ctypes.c_uint8),
        ("values", ctypes.c_float * 3),
        ("cars", _Inner * 2),
        ("inner", _Inner),
    ]


def test_structure_to_dict_converts_nested_ctypes():
    outer = _Outer()
    outer.id = 7
    outer.values[0] = 1.5
    outer.values[2] = -2.0
    outer.cars[0].speed = 300
    outer.cars[0].label = b"Ham"
    outer.cars[1].label = b"Ver"
    outer.inner.speed = 12
    outer.inner.label = b"x"

    assert routes._structure_to_dict(outer) == {
        "id": 7,
        "values": [1.5, 0.0, -2.0],
        "cars": [
            {"speed": 300, "label": "Ham"},
            {"speed": 0, "label": "Ver"},
        ],
        "inner": {"speed": 12, "label": "x"},
    }


def test_convert_ctypes_value_handles_bytes_and_plain_values():
    assert routes._convert_ctypes_value(b"Lewis\x00junk") == "Lewis"
    assert routes._convert_ctypes_value(b"\xff\x00") == "�"
    assert routes._convert_ctypes_value(42) == 42
    arr = (ctypes.c_int * 3)(1, 2, 3)
    assert routes._convert_ctypes_value(arr) == [1, 2, 3]


# --------------------------------------------------------------- get_local_ip


class _FakeSocketModule:
    AF_INET = 2
    SOCK_DGRAM = 2

    class gaierror(Exception):
        pass

    def __init__(self, connect_error=None, hostname_ip=None, hostname_error=None):
        self.connect_error = connect_error
        self.hostname_ip = hostname_ip
        self.hostname_error = hostname_error
        self.sockets = []

    def socket(self, family, kind):
        fake = self

        class _Sock:
            def __init__(self):
                self.closed = False
                self.timeout = None
                self.connected_to = None

            def settimeout(self, value):
                self.timeout = value

            def connect(self, address):
                self.connected_to = address
                if fake.connect_error:
                    raise fake.connect_error

            def getsockname(self):
                return ("192.168.1.50", 54321)

            def close(self):
                self.closed = True

        sock = _Sock()
        self.sockets.append((family, kind, sock))
        return sock

    def gethostname(self):
        return "my-pc"

    def gethostbyname(self, name):
        assert name == "my-pc"
        if self.hostname_error:
            raise self.hostname_error
        return self.hostname_ip


def test_get_local_ip_uses_routed_socket_address(monkeypatch):
    fake = _FakeSocketModule()
    monkeypatch.setattr(routes, "socket", fake)

    assert routes.get_local_ip() == "192.168.1.50"
    family, kind, sock = fake.sockets[0]
    assert (family, kind) == (2, 2)
    assert sock.timeout == 0.1
    assert sock.connected_to == ("10.255.255.255", 1)
    assert sock.closed is True


def test_get_local_ip_falls_back_to_hostname_lookup(monkeypatch):
    fake = _FakeSocketModule(connect_error=OSError("no route"), hostname_ip="10.1.2.3")
    monkeypatch.setattr(routes, "socket", fake)

    assert routes.get_local_ip() == "10.1.2.3"
    assert fake.sockets[0][2].closed is True


def test_get_local_ip_falls_back_to_loopback(monkeypatch):
    fake = _FakeSocketModule(
        connect_error=OSError("no route"),
        hostname_error=_FakeSocketModule.gaierror("unknown host"),
    )
    monkeypatch.setattr(routes, "socket", fake)

    assert routes.get_local_ip() == "127.0.0.1"
    assert fake.sockets[0][2].closed is True


# --------------------------------------------- module without f1 library


def test_module_without_telemetry_library_reports_unavailable(monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "f1_24_telemetry.listener", None)
    monkeypatch.setitem(sys.modules, "f1_24_telemetry.packets", None)
    spec = importlib.util.spec_from_file_location(
        "_udp_routes_without_f1_lib", routes.__file__
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.F1_TELEMETRY_AVAILABLE is False
    assert module.TelemetryListener is None
    assert module.PacketHeader is None
    assert module.HEADER_FIELD_TO_PACKET_TYPE is None
    out = capsys.readouterr().out
    assert "WARNING: f1_24_telemetry library not found" in out
    assert "pip install" in out

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(module.start_telemetry(port=20777))
    assert exc_info.value.status_code == 500
    assert "not installed" in exc_info.value.detail
    assert module.listener_thread is None


# ----------------------------------------------------------- start / stop


class FakeThread:
    def __init__(self, on_start=None, alive_after_start=True, stops_on_join=True):
        self.on_start = on_start
        self.alive_after_start = alive_after_start
        self.stops_on_join = stops_on_join
        self.alive = False
        self.joins = []
        self.target = None
        self.args = None
        self.daemon = None

    def __call__(self, target, args, daemon):
        self.target, self.args, self.daemon = target, args, daemon
        return self

    def start(self):
        self.alive = self.alive_after_start
        if self.on_start:
            self.on_start(self)

    def is_alive(self):
        return self.alive

    def join(self, timeout=None):
        self.joins.append(timeout)
        if self.stops_on_join:
            self.alive = False


@pytest.fixture
def start_env(monkeypatch):
    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(routes, "asyncio", SimpleNamespace(sleep=fake_sleep))
    monkeypatch.setattr(routes, "F1_TELEMETRY_AVAILABLE", True)
    local_ip_calls = []

    def fake_local_ip():
        local_ip_calls.append(True)
        return "192.168.1.5"

    monkeypatch.setattr(routes, "get_local_ip", fake_local_ip)

    def install(thread):
        monkeypatch.setattr(
            routes, "threading", SimpleNamespace(Thread=thread, Event=threading.Event)
        )
        return thread

    return SimpleNamespace(sleeps=sleeps, local_ip_calls=local_ip_calls, install=install)


def test_start_and_stop_listener(start_env, monkeypatch):
    monkeypatch.setenv("F1_TELEMETRY_LISTENER_HOST", "127.0.0.1")
    thread = start_env.install(FakeThread())
    routes.telemetry_sources["stale"] = {"last_seen": 0}

    response = asyncio.run(routes.start_telemetry(port=20999))

    assert response.message == "UDP telemetry listener started on host 127.0.0.1, port 20999"
    assert (response.host, response.port) == ("127.0.0.1", 20999)
    assert thread.target is routes.telemetry_listener_worker
    assert thread.args == ("127.0.0.1", 20999, routes.listener_stop_event)
    assert thread.daemon is True
    assert start_env.sleeps == [0.5]
    assert start_env.local_ip_calls == [True]
    assert routes.listener_thread is thread
    assert routes.telemetry_sources == {}  # previous state cleared on start

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(routes.start_telemetry(port=21000))
    assert exc_info.value.status_code == 400
    assert "already running on host 127.0.0.1, port 20999" in exc_info.value.detail

    stop_event = routes.listener_stop_event
    result = asyncio.run(routes.stop_telemetry())

    assert result == {"message": "UDP telemetry listener stopped."}
    assert stop_event.is_set()
    assert thread.joins == [3.0]
    assert routes.listener_thread is None
    assert routes.listener_stop_event is None
    assert routes.listener_port is None


def test_start_defaults_host_and_reports_worker_error(start_env, monkeypatch):
    monkeypatch.delenv("F1_TELEMETRY_LISTENER_HOST", raising=False)

    def fail(thread):
        assert thread.args[0] == "0.0.0.0"
        routes.listener_error = "Failed to start/run telemetry listener: OSError: in use"

    start_env.install(FakeThread(on_start=fail))

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(routes.start_telemetry(port=20777))

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == (
        "Failed to start telemetry listener: "
        "Failed to start/run telemetry listener: OSError: in use"
    )
    assert routes.listener_error is None
    assert routes.listener_thread is None
    assert start_env.local_ip_calls == []


def test_start_reports_thread_that_died(start_env):
    start_env.install(FakeThread(alive_after_start=False))

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(routes.start_telemetry(port=20777))

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "Failed to start telemetry listener: Thread did not start."
    assert routes.listener_thread is None
    assert routes.listener_port is None


def _running_listener(monkeypatch, error, stops_on_join):
    thread = FakeThread(stops_on_join=stops_on_join)
    thread.alive = True
    stop_event = threading.Event()
    monkeypatch.setattr(routes, "listener_thread", thread)
    monkeypatch.setattr(routes, "listener_stop_event", stop_event)
    monkeypatch.setattr(routes, "listener_error", error)
    return thread, stop_event


def test_stop_reports_shutdown_error_and_hung_thread(monkeypatch, capsys):
    thread, stop_event = _running_listener(
        monkeypatch, "Failed to start/run telemetry listener: boom", stops_on_join=False
    )

    result = asyncio.run(routes.stop_telemetry())

    assert result["message"] == (
        "UDP telemetry listener stopped. Note: An error occurred during operation "
        "or shutdown: Failed to start/run telemetry listener: boom"
    )
    assert stop_event.is_set()
    assert "did not stop gracefully" in capsys.readouterr().out
    assert routes.listener_thread is None
    assert routes.listener_error is None


def test_stop_hides_transient_worker_errors(monkeypatch):
    _running_listener(monkeypatch, "Error in telemetry worker: ValueError: x", stops_on_join=True)

    result = asyncio.run(routes.stop_telemetry())

    assert result == {"message": "UDP telemetry listener stopped."}


# --------------------------------------------------------------- status


def test_status_hides_timed_out_error_when_not_running(monkeypatch):
    monkeypatch.setattr(routes, "listener_thread", None)
    monkeypatch.setattr(
        routes, "listener_error", "Failed to start/run telemetry listener: timed out"
    )

    body = client.get("/api/telemetry/status").json()

    assert body == {
        "running": False,
        "host": None,
        "port": None,
        "active_drivers": 0,
        "error": None,
    }


def test_status_keeps_other_errors_and_uses_global_count_without_sources(monkeypatch):
    monkeypatch.setattr(routes, "listener_thread", SimpleNamespace(is_alive=lambda: True))
    monkeypatch.setattr(routes, "listener_host", "0.0.0.0")
    monkeypatch.setattr(routes, "listener_port", 20777)
    monkeypatch.setattr(routes, "active_drivers_count", 3)
    monkeypatch.setattr(routes, "listener_error", "Error in telemetry worker: boom")

    body = client.get("/api/telemetry/status").json()

    assert body == {
        "running": True,
        "host": "0.0.0.0",
        "port": 20777,
        "active_drivers": 3,
        "error": "Error in telemetry worker: boom",
    }


# --------------------------------------------------------------- session


def test_session_conditions_unavailable_without_data():
    body = client.get("/api/telemetry/session").json()
    assert body == {
        "available": False,
        "weather": None,
        "weatherName": None,
        "trackTemperature": None,
        "airTemperature": None,
        "timeOfDay": None,
    }


def test_session_conditions_from_enhanced_session_data(monkeypatch):
    monkeypatch.setattr(
        routes,
        "enhanced_session_data_store",
        {"weather": 3, "trackTemperature": 31, "airTemperature": 22, "timeOfDay": 600},
    )

    body = client.get("/api/telemetry/session").json()

    assert body == {
        "available": True,
        "weather": 3,
        "weatherName": "Light Rain",
        "trackTemperature": 31,
        "airTemperature": 22,
        "timeOfDay": 600,
    }


def test_session_conditions_partial_data_not_available(monkeypatch):
    monkeypatch.setattr(routes, "enhanced_session_data_store", {"trackTemperature": 31})

    body = client.get("/api/telemetry/session").json()

    assert body["available"] is False
    assert body["weatherName"] is None
    assert body["trackTemperature"] == 31


# ------------------------------------------------------------------- raw


def test_raw_capture_toggle_and_raw_dump():
    resp = client.post("/api/telemetry/raw/capture", json={"enabled": True})
    assert resp.json() == {"raw_capture_enabled": True}
    assert routes.raw_capture_enabled is True

    state = routes._get_source_state("10.0.0.2")
    state["raw_packets"][1] = {"packet_id": 1, "received_at": 5.0, "data": {"a": 1}}
    routes._get_source_state("10.0.0.3")

    body = client.get("/api/telemetry/raw").json()

    assert body == {
        "raw_capture_enabled": True,
        "sources": {
            "10.0.0.2": {"1": {"packet_id": 1, "received_at": 5.0, "data": {"a": 1}}},
            "10.0.0.3": {},
        },
    }

    resp = client.post("/api/telemetry/raw/capture", json={"enabled": False})
    assert resp.json() == {"raw_capture_enabled": False}
    assert routes.raw_capture_enabled is False


def test_raw_dump_tolerates_source_without_raw_packets():
    routes.telemetry_sources["legacy"] = {"last_seen": time.time()}

    body = client.get("/api/telemetry/raw").json()

    assert body == {"raw_capture_enabled": False, "sources": {"legacy": {}}}


# ------------------------------------------------- live driver data for API


@pytest.fixture
def fastest_sectors(monkeypatch):
    data = {}

    async def fake_fastest():
        return data

    monkeypatch.setattr(lap_time_store, "get_fastest_lap_sectors_by_name", fake_fastest)
    return data


def _live():
    return asyncio.run(routes.get_live_driver_data_for_api())


def test_live_data_falls_back_to_local_stores_and_best_sectors(monkeypatch, fastest_sectors):
    fastest_sectors["Hamilton"] = (25000, 26000, 24000)
    monkeypatch.setattr(routes, "participant_data_store", [{"name": "Hamilton", "teamId": 8}])
    monkeypatch.setattr(
        routes,
        "latest_car_positions",
        [{"worldPositionX": 1.5, "worldPositionY": 2.5, "worldPositionZ": -3.0}],
    )
    monkeypatch.setattr(
        routes,
        "lap_data_store",
        [{"lastLapTimeInMS": 75123, "sector1TimeMS": 9, "currentLapInvalid": 1}],
    )
    monkeypatch.setattr(routes, "active_drivers_count", 1)

    drivers = _live()

    assert list(drivers) == ["local:0"]
    d = drivers["local:0"]
    assert d.name == "Hamilton"
    assert d.team == "McLaren F1 Team"
    assert [(lt.time, lt.is_fastest) for lt in d.lap_times] == [("1:15.123", True)]
    assert (d.world_x, d.world_y, d.world_z) == (1.5, 2.5, -3.0)
    assert d.source_id == "local"
    # not on a lap -> best sectors shown, invalid flag cleared
    assert (d.live_sector_1_ms, d.live_sector_2_ms, d.live_sector_3_ms) == (25000, 26000, 24000)
    assert d.live_lap_invalid is False
    assert d.live_lap_active is False


def _source(**overrides):
    state = {
        "participants": [{"name": "Hamilton", "teamId": 0}],
        "positions": [{}],
        "laps": [{}],
        "active_drivers_count": 1,
        "last_seen": time.time(),
    }
    state.update(overrides)
    return state


def test_live_data_shows_current_sectors_for_driver_on_a_lap(fastest_sectors):
    fastest_sectors["Hamilton"] = (1, 2, 3)
    routes.telemetry_sources["rig"] = _source(
        laps=[{"sector1TimeMS": 25000, "sector2TimeMS": None, "currentLapInvalid": 1,
               "lastLapTimeInMS": 0}],
        last_sector_progress_time=[time.time()],
    )

    d = _live()["rig:0"]

    assert (d.live_sector_1_ms, d.live_sector_2_ms, d.live_sector_3_ms) == (25000, 0, 0)
    assert d.live_lap_invalid is True
    assert d.live_lap_active is True
    assert d.lap_times == []
    assert (d.world_x, d.world_y, d.world_z) == (None, None, None)


def test_live_data_idle_driver_without_best_lap_shows_zero_sectors(fastest_sectors):
    routes.telemetry_sources["rig"] = _source(
        laps=[{"sector1TimeMS": 25000}],
        last_sector_progress_time=[time.time() - routes.SECTOR_PACE_IDLE_SECONDS - 5],
    )

    d = _live()["rig:0"]

    assert (d.live_sector_1_ms, d.live_sector_2_ms, d.live_sector_3_ms) == (0, 0, 0)
    assert d.live_lap_active is False


def test_live_data_tolerates_malformed_source_state(fastest_sectors):
    routes.telemetry_sources.update(
        {
            "no-drivers": _source(active_drivers_count=0),
            "bad-count": _source(active_drivers_count="1"),
            "bad-participants": _source(participants="oops"),
            "weird": _source(
                participants=[
                    {"name": "Verstappen", "teamId": 99},
                    None,
                    {"name": "N/A"},
                    "not-a-dict",
                    {"teamId": 1},
                    {"name": "Leclerc", "teamId": 1},
                ],
                active_drivers_count=6,
                laps=[None],  # lap entry not a dict, and too short for others
                positions="not-a-list",
                # no last_sector_progress_time key at all
            ),
            "short-laps": _source(laps="not-a-list", positions=[None]),
        }
    )

    drivers = _live()

    assert set(drivers) == {"weird:0", "weird:5", "short-laps:0"}
    v = drivers["weird:0"]
    assert v.team == "Unknown Team"
    assert v.lap_times == []
    assert (v.world_x, v.live_sector_1_ms, v.live_lap_invalid) == (None, 0, False)
    assert drivers["weird:5"].team == "Scuderia Ferrari"
    assert drivers["weird:5"].car_index == 5
    assert drivers["short-laps:0"].world_x is None
    assert drivers["short-laps:0"].instance_index == 4
