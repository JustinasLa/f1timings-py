import asyncio
import logging
import socket
import threading
import time
from types import SimpleNamespace

import pytest

from app.api import udp_telemetry_routes as routes
from app.services import lap_time_store

SENDER = "10.0.0.2"


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    monkeypatch.setattr(routes, "raw_capture_enabled", False)
    monkeypatch.setattr(routes, "_main_event_loop", None)
    monkeypatch.setattr(
        routes, "TelemetryListener", lambda port, host: SimpleNamespace(socket=None)
    )
    routes._clear_listener_state()
    yield
    routes._clear_listener_state()


@pytest.fixture
def saved_laps(monkeypatch):
    """Capture auto-saved laps instead of touching the real lap store."""
    saved = []

    async def fake_add(lap_input, track_name=None):
        saved.append((lap_input, track_name))
        return {}

    def fake_submit(coro, what):
        asyncio.run(coro)
        return object()

    monkeypatch.setattr(lap_time_store, "add_or_update_lap_time", fake_add)
    monkeypatch.setattr(routes, "_submit_to_main_loop", fake_submit)
    monkeypatch.setattr(routes, "_main_event_loop", object())
    return saved


def run_worker(monkeypatch, items, sender_ip=SENDER):
    """Feed items to the worker. An item may be a packet, an exception to raise,
    or a callable taking the stop event (invoked instead of returning a packet)."""
    stop_event = threading.Event()
    queue = list(items)

    def fake_parse(listener_instance):
        if not queue:
            stop_event.set()
            raise socket.timeout()
        item = queue.pop(0)
        if isinstance(item, BaseException):
            raise item
        if callable(item):
            return item(stop_event)
        return item, (sender_ip, 20777)

    monkeypatch.setattr(routes, "_parse_packet_with_sender", fake_parse)
    routes.telemetry_listener_worker("0.0.0.0", 20777, stop_event)
    return queue


def state():
    return routes.telemetry_sources[SENDER]


def participants(*names, count=None, **extra):
    return SimpleNamespace(
        header=SimpleNamespace(packet_id=4),
        num_active_cars=len(names) if count is None else count,
        participants=[
            SimpleNamespace(name=n.encode(), team_id=0, ai_controlled=0, **extra)
            for n in names
        ],
    )


def lap(last_ms=0, s1=0, s2=0, invalid=0, **extra):
    return SimpleNamespace(
        header=SimpleNamespace(packet_id=2),
        lap_data=[
            SimpleNamespace(
                last_lap_time_in_ms=last_ms,
                sector_1_time_in_ms=s1,
                sector_2_time_in_ms=s2,
                current_lap_invalid=invalid,
                **extra,
            )
        ],
    )


# -------------------------------------------------------- lifecycle / errors


def test_worker_sets_socket_timeout_and_closes_socket(monkeypatch, capsys):
    events = []
    sock = SimpleNamespace(
        settimeout=lambda v: events.append(("timeout", v)),
        close=lambda: events.append(("close",)),
    )
    created = []

    def fake_listener(port, host):
        created.append((host, port))
        return SimpleNamespace(socket=sock)

    monkeypatch.setattr(routes, "TelemetryListener", fake_listener)

    run_worker(monkeypatch, [])

    assert created == [("0.0.0.0", 20777)]
    assert events == [("timeout", 1.0), ("close",)]
    assert "Closing telemetry listener socket." in capsys.readouterr().out
    assert routes.listener_error is None


def test_worker_records_error_when_listener_cannot_start(monkeypatch):
    def broken_listener(port, host):
        raise OSError("address in use")

    monkeypatch.setattr(routes, "TelemetryListener", broken_listener)

    run_worker(monkeypatch, [])

    assert routes.listener_error == (
        "Failed to start/run telemetry listener: OSError: address in use"
    )


def test_worker_reinitializes_wrong_sized_global_stores(monkeypatch):
    monkeypatch.setattr(routes, "latest_car_positions", [])
    monkeypatch.setattr(routes, "participant_data_store", [{}] * 3)
    monkeypatch.setattr(routes, "lap_data_store", [{}])
    monkeypatch.setattr(routes, "session_data_store", {"trackId": 5})

    run_worker(monkeypatch, [])

    assert len(routes.latest_car_positions) == 22
    assert len(routes.participant_data_store) == 22
    assert len(routes.lap_data_store) == 22
    assert routes.session_data_store == {"trackId": 5}


def test_worker_continues_after_packet_error(monkeypatch):
    run_worker(monkeypatch, [RuntimeError("bad packet"), participants("Hamilton")])

    assert routes.listener_error == "Error in telemetry worker: RuntimeError: bad packet"
    assert state()["participants"][0]["name"] == "Hamilton"


def test_worker_skips_wrong_format_packet_without_worker_error(monkeypatch, capsys):
    run_worker(monkeypatch, [routes.UnsupportedPacketFormat(2023), participants("Hamilton")])

    assert routes.listener_error is None
    assert "ERROR IN TELEMETRY WORKER" not in capsys.readouterr().out
    assert state()["participants"][0]["name"] == "Hamilton"


def test_worker_exits_quietly_on_error_during_stop(monkeypatch, capsys):
    def stop_then_fail(stop_event):
        stop_event.set()
        raise OSError("socket closed")

    remaining = run_worker(monkeypatch, [stop_then_fail, participants("Hamilton")])

    assert routes.listener_error is None
    assert len(remaining) == 1  # loop broke out before the next packet
    assert "likely normal" in capsys.readouterr().out


def test_worker_skips_null_and_headerless_packets(monkeypatch, caplog):
    def null_packet(stop_event):
        return None, (SENDER, 20777)

    with caplog.at_level(logging.WARNING, logger=routes.logger.name):
        run_worker(monkeypatch, [null_packet, SimpleNamespace(foo=1)])

    messages = [r.getMessage() for r in caplog.records]
    assert any("null/falsey packet" in m for m in messages)
    assert any("no 'header' attribute" in m for m in messages)
    assert SENDER in routes.telemetry_sources


def test_worker_filters_non_essential_packets(monkeypatch, caplog):
    with caplog.at_level(logging.DEBUG, logger=routes.logger.name):
        run_worker(monkeypatch, [SimpleNamespace(header=SimpleNamespace(packet_id=3))])

    assert "Packet ID 3 filtered out" in caplog.text


def test_unhandled_packet_ignored_when_filtering_disabled(monkeypatch, caplog):
    monkeypatch.setattr(routes, "ENABLE_PACKET_FILTERING", False)

    with caplog.at_level(logging.DEBUG, logger=routes.logger.name):
        run_worker(monkeypatch, [SimpleNamespace(header=SimpleNamespace(packet_id=3))])

    assert "filtered out" not in caplog.text
    assert routes.listener_error is None
    assert state()["participants"] == [{}] * 22


# ------------------------------------------------------------- raw capture


def test_raw_capture_stores_converted_real_packet(monkeypatch):
    from f1_24_telemetry.packets import HEADER_FIELD_TO_PACKET_TYPE

    packet = HEADER_FIELD_TO_PACKET_TYPE[(2024, 1, 4)]()
    packet.header.packet_format = 2024
    packet.header.packet_id = 4
    packet.num_active_cars = 2
    packet.participants[0].name = b"Hamilton"
    packet.participants[0].team_id = 0
    packet.participants[0].race_number = 44
    packet.participants[1].race_number = 0
    monkeypatch.setattr(routes, "raw_capture_enabled", True)
    before = time.time()

    run_worker(monkeypatch, [packet])

    raw = state()["raw_packets"][4]
    assert raw["packet_id"] == 4
    assert raw["received_at"] >= before
    assert raw["data"]["header"]["packet_id"] == 4
    assert raw["data"]["num_active_cars"] == 2
    assert raw["data"]["participants"][0]["name"] == "Hamilton"
    assert len(raw["data"]["participants"]) == 22
    # real packet header has player_car_index -> all 22 slots processed
    stored = state()["participants"]
    assert stored[0]["name"] == "Hamilton"
    assert stored[0]["raw_name_bytes"] == b"Hamilton".hex()
    assert stored[1]["name"] == "Driver 2"
    assert all(p.get("name") for p in stored)


def test_raw_capture_disabled_stores_nothing(monkeypatch):
    run_worker(monkeypatch, [lap()])
    assert state()["raw_packets"] == {}


# ---------------------------------------------------------------- motion


def test_motion_packet_updates_positions(monkeypatch):
    def car(x):
        return SimpleNamespace(
            world_position_x=x,
            world_position_y=2.0,
            world_position_z=3.0,
            g_force_lateral=0.1,
            g_force_longitudinal=0.2,
            g_force_vertical=0.3,
            yaw=1.0,
            pitch=0.5,
            roll=0.25,
        )

    packet = SimpleNamespace(
        header=SimpleNamespace(packet_id=0),
        car_motion_data=[car(float(i)) for i in range(23)],
    )

    run_worker(monkeypatch, [packet])

    positions = state()["positions"]
    assert len(positions) == 22
    assert positions[0] == {
        "worldPositionX": 0.0,
        "worldPositionY": 2.0,
        "worldPositionZ": 3.0,
        "gForceLateral": 0.1,
        "gForceLongitudinal": 0.2,
        "gForceVertical": 0.3,
        "yaw": 1.0,
        "pitch": 0.5,
        "roll": 0.25,
    }
    assert positions[21]["worldPositionX"] == 21.0


# ---------------------------------------------------------- participants


def test_participants_packet_with_legacy_active_cars_field(monkeypatch):
    packet = SimpleNamespace(
        header=SimpleNamespace(packet_id=4),
        m_numActiveCars=1,
        participants=[
            SimpleNamespace(name=b"Hamilton", team_id=8),
            SimpleNamespace(name=b"Russell", team_id=0),
        ],
    )

    run_worker(monkeypatch, [packet])

    assert state()["active_drivers_count"] == 1
    stored = state()["participants"]
    assert stored[0]["name"] == "Hamilton"
    assert stored[0]["teamId"] == 8
    assert stored[1] == {}  # beyond m_numActiveCars -> not processed, cleared


def test_participants_packet_without_count_or_list_is_handled(monkeypatch, caplog):
    # No num_active_cars / m_numActiveCars and no participants list: the
    # worker warns, keeps the previous count and carries on without error.
    packet = SimpleNamespace(header=SimpleNamespace(packet_id=4))

    with caplog.at_level(logging.WARNING, logger=routes.logger.name):
        run_worker(monkeypatch, [participants("Hamilton"), packet])

    assert any(
        "NEITHER 'num_active_cars' NOR 'm_numActiveCars'" in r.getMessage()
        for r in caplog.records
    )
    assert routes.listener_error is None
    assert state()["active_drivers_count"] == 1
    assert state()["participants"][0]["name"] == "Hamilton"


def test_participants_store_of_wrong_size_is_reinitialized(monkeypatch):
    seeded = routes._get_source_state(SENDER)
    seeded["participants"] = [{"name": "old"}] * 3

    run_worker(monkeypatch, [participants("Hamilton")])

    stored = state()["participants"]
    assert len(stored) == 22
    assert stored[0]["name"] == "Hamilton"
    assert stored[1:] == [{}] * 21


def test_participant_name_fallbacks(monkeypatch):
    names = [b"", b"???????????????", b"Player", "not-bytes", b"Bad\x01Name", b"Alonso\x00x"]
    race_numbers = [44, 0, 7, 0, 0, 14]
    packet = SimpleNamespace(
        header=SimpleNamespace(packet_id=4),
        num_active_cars=6,
        participants=[
            SimpleNamespace(
                name=n, race_number=r, team_id=1, network_id=5 if i == 5 else 0,
                driver_id=255,
            )
            for i, (n, r) in enumerate(zip(names, race_numbers))
        ],
    )

    run_worker(monkeypatch, [packet])

    stored = state()["participants"]
    assert [p["name"] for p in stored[:6]] == [
        "Driver 44",
        "Driver 2",
        "Driver 7",
        "Driver 4",  # decode error path
        "Driver 5",  # control character rejected
        "Alonso",
    ]
    assert stored[3]["raw_name_bytes"] == ""
    assert stored[5]["is_online_player"] is True
    assert stored[0]["is_online_player"] is False
    assert stored[6:] == [{}] * 16
    assert state()["active_drivers_count"] == 6


def test_participants_packet_with_no_cars_clears_store(monkeypatch, caplog):
    with caplog.at_level(logging.DEBUG, logger=routes.logger.name):
        run_worker(monkeypatch, [participants("Hamilton"), participants(count=0)])

    assert state()["participants"] == [{}] * 22
    assert state()["active_drivers_count"] == 0
    assert any(
        "first element is empty" in r.getMessage() for r in caplog.records
    )


# ---------------------------------------------------------------- lap data


def test_lap_data_ignores_extra_cars_and_inactive_slots(monkeypatch, saved_laps):
    packet = SimpleNamespace(
        header=SimpleNamespace(packet_id=2),
        lap_data=[SimpleNamespace(last_lap_time_in_ms=70000 + i) for i in range(23)],
    )

    run_worker(monkeypatch, [participants("Hamilton"), packet, packet])

    laps = state()["laps"]
    assert len(laps) == 22
    assert laps[1]["lastLapTimeInMS"] == 70001
    assert laps[1]["currentLapTimeInMS"] == 0  # missing attrs default
    assert laps[1]["sector1TimeMS"] == 0
    # only slot 0 is active; it is tracked but its first-seen lap is not saved
    assert state()["lap_tracking_started"] == [True] + [False] * 21
    assert saved_laps == []


def test_lap_data_without_main_loop_does_not_track(monkeypatch):
    run_worker(monkeypatch, [participants("Hamilton"), lap(70000), lap(71000)])

    assert state()["laps"][0]["lastLapTimeInMS"] == 71000
    assert state()["lap_tracking_started"][0] is False
    assert state()["last_lap_times"][0] == 0


def test_display_owner_change_resets_sector_progress(monkeypatch, saved_laps):
    run_worker(
        monkeypatch,
        [participants("Hamilton"), lap(s1=20000)],
    )
    assert state()["last_sector_progress_time"][0] > 0

    run_worker(monkeypatch, [participants("Russell"), lap(s1=20000)])

    assert state()["live_display_owner"][0] == "Russell"
    assert state()["last_sector_progress_time"][0] == 0.0


def test_lap_saved_under_current_name_when_owner_unknown(monkeypatch, saved_laps):
    seeded = routes._get_source_state(SENDER)
    seeded["lap_tracking_started"][0] = True
    seeded["lap_owner_names"][0] = None

    run_worker(monkeypatch, [participants("Hamilton"), lap(75000, speed_trap_fastest_speed=312.4)])

    assert len(saved_laps) == 1
    lap_input, track = saved_laps[0]
    assert lap_input.name == "Hamilton"
    assert lap_input.time == "1:15.000"
    assert lap_input.fastest_speed_kph == 312  # from speed trap
    assert (lap_input.sector_1_ms, lap_input.sector_2_ms, lap_input.sector_3_ms) == (
        None,
        None,
        None,
    )
    assert track is None


def test_lap_saved_with_visual_tyre_compound(monkeypatch, saved_laps):
    status = SimpleNamespace(
        header=SimpleNamespace(packet_id=7),
        car_status_data=[SimpleNamespace(visual_tyre_compound=16)],
    )
    run_worker(monkeypatch, [participants("Hamilton"), lap(0), status, lap(75000)])

    assert saved_laps[0][0].tyre == "Soft"


def test_lap_keeps_tyre_from_lap_start_when_changed_mid_lap(monkeypatch, saved_laps):
    def status(compound):
        return SimpleNamespace(
            header=SimpleNamespace(packet_id=7),
            car_status_data=[SimpleNamespace(visual_tyre_compound=compound)],
        )

    run_worker(
        monkeypatch,
        [participants("Hamilton"), status(16), lap(0), lap(s1=25000), status(17), lap(75000)],
    )

    assert saved_laps[0][0].tyre == "Soft"


def test_lap_saved_without_tyre_when_compound_unknown(monkeypatch, saved_laps):
    run_worker(monkeypatch, [participants("Hamilton"), lap(0), lap(75000)])

    assert saved_laps[0][0].tyre is None


def test_personal_best_ghost_lap_is_not_saved(monkeypatch, saved_laps):
    run_worker(monkeypatch, [participants("Personal Best"), lap(0), lap(75000)])

    assert saved_laps == []
    assert state()["last_lap_times"][0] == 75000


def test_duplicate_lap_signature_not_saved_twice(monkeypatch, saved_laps):
    run_worker(
        monkeypatch,
        [participants("Hamilton"), lap(0), lap(75000), lap(76000), lap(75000)],
    )

    assert [li.time for li, _ in saved_laps] == ["1:15.000", "1:16.000"]
    assert state()["saved_signatures"] == [
        ("hamilton", 75000, False),
        ("hamilton", 76000, False),
    ]


def test_saved_signatures_capped_at_1000(monkeypatch, saved_laps):
    seeded = routes._get_source_state(SENDER)
    seeded["saved_signatures"].extend(("ghost", n, False) for n in range(1000))

    run_worker(monkeypatch, [participants("Hamilton"), lap(0), lap(75000)])

    sigs = state()["saved_signatures"]
    assert len(sigs) == 1000
    assert sigs[0] == ("ghost", 1, False)
    assert sigs[-1] == ("hamilton", 75000, False)
    assert len(saved_laps) == 1


def test_short_per_car_lists_are_tolerated(monkeypatch, saved_laps):
    seeded = routes._get_source_state(SENDER)
    seeded["lap_top_speeds"] = []

    speed = SimpleNamespace(
        header=SimpleNamespace(packet_id=6),
        car_telemetry_data=[SimpleNamespace(speed=330)],
    )
    run_worker(
        monkeypatch,
        [participants("Hamilton"), lap(0), speed, lap(75000, speed_trap_fastest_speed=0)],
    )

    assert state()["lap_top_speeds"] == []
    assert len(saved_laps) == 1
    assert saved_laps[0][0].fastest_speed_kph is None


def test_short_last_lap_times_list_is_tolerated_without_completed_lap(monkeypatch, saved_laps):
    seeded = routes._get_source_state(SENDER)
    seeded["last_lap_times"] = []

    run_worker(monkeypatch, [participants("Hamilton"), lap(0), lap(0, s1=21000)])

    assert state()["last_lap_times"] == []
    assert state()["lap_tracking_started"][0] is True
    assert state()["live_sector1_ms"][0] == 21000
    assert saved_laps == []


# --------------------------------------------------------- car telemetry


def test_car_telemetry_tracks_max_speed_and_skips_missing_speed(monkeypatch):
    def telemetry(*cars):
        return SimpleNamespace(header=SimpleNamespace(packet_id=6), car_telemetry_data=list(cars))

    cars = [SimpleNamespace(speed=300), SimpleNamespace()] + [
        SimpleNamespace(speed=100) for _ in range(21)
    ]
    run_worker(monkeypatch, [telemetry(*cars), telemetry(SimpleNamespace(speed=250))])

    speeds = state()["lap_top_speeds"]
    assert len(speeds) == 22
    assert speeds[0] == 300.0
    assert speeds[1] == 0.0
    assert speeds[21] == 100.0


# -------------------------------------------------------------- car status


def test_car_status_updates_known_participants_only(monkeypatch):
    status = SimpleNamespace(
        fuel_mix=2,
        front_left_wing_damage=10,
        front_right_wing_damage=20,
        rear_wing_damage=5,
        drs_allowed=1,
        tyres_wear_rl=1.0,
        tyres_wear_rr=2.0,
        tyres_wear_fl=3.0,
        tyres_wear_fr=4.0,
        actual_tyre_compound=16,
        visual_tyre_compound=17,
        vehicle_fia_flags=3,
    )
    packet = SimpleNamespace(
        header=SimpleNamespace(packet_id=7),
        car_status_data=[status] + [SimpleNamespace() for _ in range(22)],
    )
    no_data = SimpleNamespace(header=SimpleNamespace(packet_id=7))

    run_worker(monkeypatch, [participants("Hamilton"), packet, no_data])

    first = state()["participants"][0]
    assert first["name"] == "Hamilton"
    assert first["fuelMix"] == 2
    assert first["frontLeftWingDamage"] == 10
    assert first["frontRightWingDamage"] == 20
    assert first["rearWingDamage"] == 5
    assert first["drsAllowed"] == 1
    assert first["tyresWear"] == [1.0, 2.0, 3.0, 4.0]
    assert first["tyreCompound"] == 16
    assert first["visualTyreCompound"] == 17
    assert first["vehicleFiaFlags"] == 3
    assert state()["participants"][1] == {}
    assert len(state()["participants"]) == 22
    assert routes.listener_error is None
