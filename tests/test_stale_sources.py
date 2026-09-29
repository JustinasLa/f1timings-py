import asyncio
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api import udp_telemetry_routes as routes
from app.main import app
from app.services import lap_time_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    async def no_fastest():
        return {}

    monkeypatch.setattr(lap_time_store, "get_fastest_lap_sectors_by_name", no_fastest)
    monkeypatch.setattr(routes, "listener_thread", SimpleNamespace(is_alive=lambda: True))
    monkeypatch.setattr(routes, "telemetry_sources", {})


def _add_rig(source_id, age_seconds):
    state = routes._get_source_state(source_id)
    state["participants"][0] = {"name": f"driver-{source_id}", "teamId": 0}
    state["active_drivers_count"] = 1
    state["last_seen"] = time.time() - age_seconds
    return state


def _live():
    return asyncio.run(routes.get_live_driver_data_for_api())


def _status_active():
    return client.get("/api/telemetry/status").json()["active_drivers"]


def test_stale_source_excluded_from_live_data_and_status():
    _add_rig("1.1.1.1", routes.SOURCE_STALE_SECONDS + 5)
    _add_rig("2.2.2.2", 0)

    assert set(_live()) == {"2.2.2.2:0"}
    assert _status_active() == 1


def test_fresh_source_included():
    _add_rig("1.1.1.1", 0)

    assert set(_live()) == {"1.1.1.1:0"}
    assert _status_active() == 1


def test_all_sources_stale_yields_nothing():
    _add_rig("1.1.1.1", routes.SOURCE_STALE_SECONDS + 5)

    assert _live() == {}
    assert _status_active() == 0


def test_stale_source_keeps_state_and_reappears_when_it_sends_again():
    state = _add_rig("1.1.1.1", routes.SOURCE_STALE_SECONDS + 5)
    state["last_lap_times"][0] = 90000
    assert _live() == {}

    assert routes._get_source_state("1.1.1.1") is state
    assert state["last_lap_times"][0] == 90000
    assert set(_live()) == {"1.1.1.1:0"}
    assert _status_active() == 1
