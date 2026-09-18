import asyncio
import logging

import pytest

from app.services import lap_time_store
from app.services.lap_time_store import app_data, add_or_update_lap_time
from app.models.data_models import LapTimeInput


@pytest.fixture
def reset_state(monkeypatch):
    """Reset in-memory driver/track state and stub out save_lap_record so no
    files are written. Restores everything afterwards."""
    monkeypatch.setattr(app_data, "drivers", {})
    monkeypatch.setattr(app_data, "track_name", None)

    calls = []

    def fake_save_lap_record(track, driver_name, *args, **kwargs):
        calls.append((track, driver_name, args, kwargs))
        return True

    monkeypatch.setattr(lap_time_store, "save_lap_record", fake_save_lap_record)
    monkeypatch.setattr(lap_time_store, "websocket_manager", None)

    yield calls


def test_no_track_set_keeps_lap_in_memory_and_warns(reset_state, caplog):
    """With no track set, the lap is kept in app_data.drivers but never saved
    to disk, and a warning is logged."""
    calls = reset_state
    lap_input = LapTimeInput(name="Hamilton", team="Mercedes", time="1:23.456")

    with caplog.at_level(logging.WARNING, logger="app.services.lap_time_store"):
        result = asyncio.run(add_or_update_lap_time(lap_input))

    assert calls == []
    assert "Hamilton" in result
    assert app_data.drivers["Hamilton"].lap_times[0].time == "1:23.456"

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "kept in memory only" in warnings[0].getMessage()
    assert "Hamilton" in warnings[0].getMessage()
    assert warnings[0].name == "app.services.lap_time_store"


def test_track_set_saves_lap_and_logs_no_warning(reset_state, caplog):
    """With a track set, save_lap_record is called once with the track and
    driver name, and no 'kept in memory only' warning is logged."""
    calls = reset_state
    app_data.track_name = "Silverstone"
    lap_input = LapTimeInput(name="Verstappen", team="RedBull", time="1:22.123")

    with caplog.at_level(logging.WARNING, logger="app.services.lap_time_store"):
        asyncio.run(add_or_update_lap_time(lap_input))

    assert len(calls) == 1
    track, driver_name, args, kwargs = calls[0]
    assert track == "Silverstone"
    assert driver_name == "Verstappen"

    assert not any(
        "kept in memory only" in r.getMessage()
        for r in caplog.records
        if r.levelno == logging.WARNING
    )
