import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api import udp_telemetry_routes as routes
from app.main import app
from app.services import saved_lap_records as slr
from app.services.lap_time_store import app_data

from tests.test_udp_worker_coverage import (  # noqa: F401  (fixtures)
    SENDER,
    _clean_state,
    participants,
    run_worker,
    saved_laps,
    state,
)

TRACK = "monza"
TRACE = [[0, 0, 280, 1.0, 0.0], [25, 400, 285, 1.0, 0.0]]
client = TestClient(app)


@pytest.fixture(autouse=True)
def records_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    monkeypatch.setattr(app_data, "track_name", None)
    return tmp_path


def save(time, driver="Max", is_valid=True, trace=TRACE):
    return slr.save_lap_record(TRACK, driver, "Team", time, is_valid, 300, trace=trace)


def test_trace_kept_only_for_best_valid_lap(records_dir):
    save("1:21.000")
    assert slr.load_lap_traces(TRACK)["Max"] == {"time": "1:21.000", "samples": TRACE}

    save("1:22.000", trace=[[0, 0, 1, 0, 0]])
    save("1:19.000", is_valid=False, trace=[[0, 0, 2, 0, 0]])
    save("1:20.000", driver="Lewis", trace=None)
    assert slr.load_lap_traces(TRACK) == {"Max": {"time": "1:21.000", "samples": TRACE}}

    save("1:20.500", trace=[[0, 0, 3, 0, 0]])
    assert slr.load_lap_traces(TRACK)["Max"]["time"] == "1:20.500"
    # Records file stays lean: traces live in a separate file.
    records = json.loads((records_dir / "monza.json").read_text(encoding="utf-8"))
    assert all("trace" not in r and "samples" not in r for r in records["lap_times"])
    assert (records_dir / "monza.traces.json").exists()


def test_unreadable_or_odd_trace_file_is_ignored(records_dir, caplog):
    path = records_dir / "monza.traces.json"
    path.write_text("{oops", encoding="utf-8")
    assert slr.load_lap_traces(TRACK) == {}
    assert "Ignoring unreadable lap traces" in caplog.text

    path.write_text("[1, 2]", encoding="utf-8")
    assert slr.load_lap_traces(TRACK) == {}


def test_trace_write_failure_is_logged(monkeypatch, caplog):
    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(slr, "write_json_atomic", boom)
    slr.save_lap_trace(TRACK, "Max", "1:21.000", TRACE)
    assert "Could not write lap trace for 'Max'" in caplog.text


def test_trace_endpoint(monkeypatch):
    assert client.get("/api/track/trace?driver=Max").status_code == 404
    assert client.get(f"/api/track/trace?driver=Max&track={TRACK}").status_code == 404

    save("1:21.000")
    app_data.track_name = TRACK
    resp = client.get("/api/track/trace?driver=Max")
    assert resp.status_code == 200
    assert resp.json() == {
        "track": TRACK,
        "driver": "Max",
        "time": "1:21.000",
        "samples": TRACE,
    }


def lap(last_ms=0, current_ms=0, distance=0.0):
    return SimpleNamespace(
        header=SimpleNamespace(packet_id=2),
        lap_data=[
            SimpleNamespace(
                last_lap_time_in_ms=last_ms,
                current_lap_time_in_ms=current_ms,
                lap_distance=distance,
            )
        ],
    )


def inputs(speed, throttle, brake):
    return SimpleNamespace(
        header=SimpleNamespace(packet_id=6),
        car_telemetry_data=[SimpleNamespace(speed=speed, throttle=throttle, brake=brake)],
    )


def test_worker_samples_trace_every_25m_and_saves_it_with_the_lap(monkeypatch, saved_laps):
    run_worker(
        monkeypatch,
        [
            participants("Max"),
            lap(0, 0, -10.0),  # before the line: not sampled
            inputs(250, 1.0, 0.0),
            lap(0, 100, 3.0),
            lap(0, 300, 20.0),  # < 25 m since last sample
            inputs(200, 0.123, 0.456),
            lap(0, 500, 30.0),
            lap(0, 900, 60.0),
            lap(0, 600, 35.0),  # flashback: drops the 60 m sample
            lap(80000, 10, 1.0),  # lap complete
        ],
    )

    lap_input = saved_laps[0][0]
    assert lap_input.trace == [[3, 100, 250, 1.0, 0.0], [30, 500, 200, 0.12, 0.46]]
    assert state()["lap_traces"][0] == [[1, 10, 200, 0.12, 0.46]]


def test_worker_drops_trace_that_started_mid_lap(monkeypatch, saved_laps):
    run_worker(
        monkeypatch,
        [participants("Max"), lap(0, 0, 2000.0), lap(80000, 10, 1.0)],
    )

    assert saved_laps[0][0].trace is None
