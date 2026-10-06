import asyncio

import pytest

from app.models.data_models import LapTimeInput
from app.services import lap_time_store
from app.services.lap_time_store import (
    AppData,
    add_or_update_lap_time,
    app_data,
    get_fastest_lap_sectors_by_name,
    get_track,
    set_track,
    set_websocket_manager,
)


class FakeManager:
    def __init__(self):
        self.messages = []

    async def broadcast(self, message):
        self.messages.append(message)


@pytest.fixture
def ws(monkeypatch):
    monkeypatch.setattr(app_data, "drivers", {})
    monkeypatch.setattr(app_data, "track_name", None)
    monkeypatch.setattr(lap_time_store, "save_lap_record", lambda *args: True)
    manager = FakeManager()
    monkeypatch.setattr(lap_time_store, "websocket_manager", manager)
    return manager


def _lap(time, name="Max", team="Red Bull", **kwargs):
    return LapTimeInput(name=name, team=team, time=time, **kwargs)


def test_app_data_starts_empty():
    data = AppData()

    assert data.drivers == {}
    assert data.track_name is None


def test_set_websocket_manager_replaces_module_manager(monkeypatch, capsys):
    monkeypatch.setattr(lap_time_store, "websocket_manager", None)
    manager = FakeManager()

    set_websocket_manager(manager)

    assert lap_time_store.websocket_manager is manager
    assert "WebSocket manager set" in capsys.readouterr().out


def test_new_driver_lap_is_broadcast_as_add(ws):
    drivers = asyncio.run(add_or_update_lap_time(_lap("1:12.000"), track_name="monza"))

    assert list(drivers) == ["Max"]
    assert drivers["Max"] is not app_data.drivers["Max"]
    [message] = ws.messages
    assert message["type"] == "laptime_update"
    assert message["action"] == "add"
    assert message["data"]["is_faster"] is True
    assert message["data"]["is_overall_fastest"] is True
    assert message["data"]["track"] == "monza"


def test_existing_driver_team_change_and_faster_lap(ws):
    asyncio.run(add_or_update_lap_time(_lap("1:12.000")))
    asyncio.run(add_or_update_lap_time(_lap("1:11.000", team="Ferrari")))

    driver = app_data.drivers["Max"]
    assert driver.team == "Ferrari"
    assert [lap.time for lap in driver.lap_times] == ["1:12.000", "1:11.000"]
    assert ws.messages[-1]["action"] == "update"
    assert ws.messages[-1]["data"]["is_faster"] is True


def test_existing_driver_slower_lap_is_not_faster(ws):
    asyncio.run(add_or_update_lap_time(_lap("1:12.000")))
    asyncio.run(add_or_update_lap_time(_lap("1:13.000")))

    assert ws.messages[-1]["data"]["is_faster"] is False
    assert app_data.drivers["Max"].fastest_valid_lap.time == "1:12.000"


def test_first_valid_lap_after_invalid_laps_is_faster(ws):
    asyncio.run(add_or_update_lap_time(_lap("1:10.000", is_valid=False)))
    assert ws.messages[-1]["data"]["is_faster"] is False

    asyncio.run(add_or_update_lap_time(_lap("1:20.000")))
    assert ws.messages[-1]["data"]["is_faster"] is True


def test_invalid_lap_construction_raises_value_error(ws):
    bad_input = LapTimeInput.model_construct(
        name="Max", team="Red Bull", time=None, is_valid=True,
        fastest_speed_kph=None, sector_1_ms=None, sector_2_ms=None, sector_3_ms=None,
    )

    with pytest.raises(ValueError, match="Invalid time format"):
        asyncio.run(add_or_update_lap_time(bad_input))
    assert app_data.drivers == {}
    assert ws.messages == []


def test_lap_without_manager_is_not_broadcast(ws, monkeypatch):
    monkeypatch.setattr(lap_time_store, "websocket_manager", None)

    drivers = asyncio.run(add_or_update_lap_time(_lap("1:12.000")))

    assert "Max" in drivers
    assert ws.messages == []


def test_fastest_lap_sectors_by_name(ws):
    asyncio.run(add_or_update_lap_time(_lap("1:12.000", sector_1_ms=20000, sector_2_ms=None, sector_3_ms=30000)))
    asyncio.run(add_or_update_lap_time(_lap("1:10.000", name="Lewis", is_valid=False)))

    assert asyncio.run(get_fastest_lap_sectors_by_name()) == {"Max": (20000, 0, 30000)}


def test_set_track_strips_and_broadcasts(ws):
    assert asyncio.run(set_track("  monza ")) == "monza"

    assert asyncio.run(get_track()) == "monza"
    assert ws.messages == [{"type": "track_update", "data": {"name": "monza"}}]


def test_set_track_to_empty_clears_without_broadcast(ws):
    app_data.track_name = "monza"

    assert asyncio.run(set_track("")) is None

    assert app_data.track_name is None
    assert ws.messages == []


def test_faster_invalid_lap_is_not_new_best_or_overall_fastest(ws):
    asyncio.run(add_or_update_lap_time(_lap("1:12.000")))
    asyncio.run(add_or_update_lap_time(_lap("1:05.000", is_valid=False)))

    data = ws.messages[-1]["data"]
    assert data["is_faster"] is False
    assert data["is_overall_fastest"] is False
    assert [lap.is_fastest for lap in app_data.drivers["Max"].lap_times] == [True, False]


def test_overall_fastest_flag_moves_to_new_fastest_lap(ws):
    asyncio.run(add_or_update_lap_time(_lap("1:12.000")))
    asyncio.run(add_or_update_lap_time(_lap("1:11.000", name="Lando", team="McLaren")))

    assert app_data.drivers["Max"].lap_times[0].is_fastest is False
    assert app_data.drivers["Lando"].lap_times[0].is_fastest is True
    assert ws.messages[-1]["data"]["is_overall_fastest"] is True
