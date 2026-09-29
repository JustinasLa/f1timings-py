from types import SimpleNamespace

from app.services.lap_time_store import app_data
from tests.test_lap_saved_to_source_track import (
    _participants_packet,
    _run_worker,
    worker_env,
)


def _lap(last_ms, current_ms, invalid=0, s1=0, s2=0):
    return SimpleNamespace(
        header=SimpleNamespace(packet_id=2),
        lap_data=[
            SimpleNamespace(
                last_lap_time_in_ms=last_ms,
                current_lap_time_in_ms=current_ms,
                current_lap_invalid=invalid,
                sector_1_time_in_ms=s1,
                sector_2_time_in_ms=s2,
            )
        ],
    )


def _speed(kph):
    return SimpleNamespace(
        header=SimpleNamespace(packet_id=6),
        car_telemetry_data=[SimpleNamespace(speed=kph)],
    )


def _saved_laps(ws):
    return [m["data"] for m in ws.messages if m["type"] == "laptime_update"]


def test_restart_after_invalidation_saves_next_clean_lap_valid(worker_env, monkeypatch):
    saves, ws = worker_env
    app_data.track_name = "monza"

    _run_worker(
        monkeypatch,
        [
            _participants_packet("Hamilton"),
            _lap(0, 1000),
            _speed(330),
            _lap(0, 30000, invalid=1, s1=25000),
            _lap(0, 45000, invalid=1, s1=25000, s2=20000),
            _lap(0, 0),
            _lap(0, 1000),
            _speed(300),
            _lap(0, 25000, s1=24000),
            _lap(0, 50000, s1=24000, s2=25000),
            _lap(75000, 100),
        ],
    )

    laps = _saved_laps(ws)
    assert len(laps) == 1
    assert laps[0]["is_valid"] is True
    assert laps[0]["sector_1_ms"] == 24000
    assert laps[0]["sector_2_ms"] == 25000
    assert app_data.drivers["Hamilton"].lap_times[0].fastest_speed_kph == 300


def test_flashback_before_invalidation_saves_lap_valid(worker_env, monkeypatch):
    saves, ws = worker_env
    app_data.track_name = "monza"

    _run_worker(
        monkeypatch,
        [
            _participants_packet("Hamilton"),
            _lap(0, 1000),
            _lap(0, 25000, s1=24000),
            _speed(310),
            _lap(0, 40000, invalid=1, s1=24000, s2=16000),
            _lap(0, 30000, s1=24000),
            _speed(280),
            _lap(0, 50000, s1=24000, s2=25000),
            _lap(75000, 100),
        ],
    )

    laps = _saved_laps(ws)
    assert len(laps) == 1
    assert laps[0]["is_valid"] is True
    assert laps[0]["sector_1_ms"] == 24000
    assert laps[0]["sector_2_ms"] == 25000
    assert app_data.drivers["Hamilton"].lap_times[0].fastest_speed_kph == 280


def test_invalidated_lap_without_restart_still_saved_invalid(worker_env, monkeypatch):
    saves, ws = worker_env
    app_data.track_name = "monza"

    _run_worker(
        monkeypatch,
        [
            _participants_packet("Hamilton"),
            _lap(0, 1000),
            _lap(0, 30000, invalid=1, s1=25000),
            _lap(0, 50000, invalid=1, s1=25000, s2=25000),
            _lap(76000, 100),
            _lap(76000, 20000),
        ],
    )

    laps = _saved_laps(ws)
    assert len(laps) == 1
    assert laps[0]["is_valid"] is False
    assert laps[0]["sector_1_ms"] == 25000
    assert laps[0]["sector_2_ms"] == 25000
