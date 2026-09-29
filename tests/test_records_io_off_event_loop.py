import asyncio

import pytest
from fastapi.testclient import TestClient

from app.api import display_data_routes as routes
from app.main import app
from app.models.data_models import LapTimeInput
from app.services import lap_time_store
from app.services import saved_lap_records as slr


TRACK = "Monaco"
client = TestClient(app)


def _assert_off_loop():
    with pytest.raises(RuntimeError):
        asyncio.get_running_loop()


@pytest.fixture
def records_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    return tmp_path


def test_records_route_reads_file_off_event_loop(records_dir, monkeypatch):
    record = {"driver": "Max", "time": "1:12.000", "recorded_at": "2024-01-01T00:00:00"}
    slr.write_track_records(TRACK, [record])

    def spy(track_name):
        _assert_off_loop()
        return slr.load_track_records(track_name)

    monkeypatch.setattr(routes, "load_track_records", spy)

    resp = client.get("/api/track/records", params={"track": TRACK})

    assert resp.status_code == 200
    assert resp.json() == {"track": TRACK, "lap_times": [record]}


def test_delete_route_writes_file_off_event_loop(records_dir, monkeypatch):
    record = {"driver": "Max", "time": "1:12.000", "recorded_at": "2024-01-01T00:00:00"}
    slr.write_track_records(TRACK, [record])

    def spy(*args):
        _assert_off_loop()
        return slr.delete_lap_record(*args)

    monkeypatch.setattr(routes, "delete_lap_record", spy)

    resp = client.post(
        "/api/track/records/delete",
        json={"track": TRACK, "driver": "Max", "time": "1:12.000", "recorded_at": "2024-01-01T00:00:00"},
    )

    assert resp.status_code == 200
    assert slr.load_track_records(TRACK) == []


def test_lap_save_waits_for_records_lock_without_blocking_event_loop(records_dir, monkeypatch):
    monkeypatch.setattr(lap_time_store.app_data, "drivers", {})
    monkeypatch.setattr(lap_time_store.app_data, "track_name", TRACK)
    monkeypatch.setattr(lap_time_store, "websocket_manager", None)

    async def scenario():
        slr._records_lock.acquire()
        try:
            task = asyncio.create_task(
                lap_time_store.add_or_update_lap_time(
                    LapTimeInput(name="Lando", team="McLaren", time="1:11.500")
                )
            )
            await asyncio.sleep(0.2)
            assert not task.done()
            assert not (records_dir / slr.make_safe_file_name(TRACK)).exists()
        finally:
            slr._records_lock.release()
        await task

    asyncio.run(scenario())

    records = slr.load_track_records(TRACK)
    assert [(r["driver"], r["time"]) for r in records] == [("Lando", "1:11.500")]
