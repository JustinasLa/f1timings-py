import json
import logging
import os

import pytest
from fastapi.testclient import TestClient

from app.api import udp_telemetry_routes as routes
from app.main import app


client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_aliases():
    routes.driver_name_aliases.clear()
    yield
    routes.driver_name_aliases.clear()


def _set_alias(telemetry_name, display_name):
    return client.post(
        "/api/telemetry/driver_alias",
        json={"telemetry_name": telemetry_name, "display_name": display_name},
    )


def _file_data():
    with open(routes.DRIVER_ALIASES_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def test_set_alias_writes_file():
    assert _set_alias("Driver 1", "Lewis Hamilton").status_code == 200

    assert _file_data() == {"driver 1": "Lewis Hamilton"}
    assert os.listdir(os.path.dirname(routes.DRIVER_ALIASES_FILE)) == [
        "driver_aliases.json"
    ]


def test_aliases_are_restored_from_file():
    _set_alias("Driver 1", "Lewis Hamilton")
    routes.driver_name_aliases.clear()

    assert routes._load_driver_aliases() == {"driver 1": "Lewis Hamilton"}


def test_deleting_alias_is_persisted():
    _set_alias("Driver 1", "Lewis Hamilton")
    _set_alias("Driver 2", "Max Verstappen")
    assert _set_alias("Driver 1", "").status_code == 200

    assert _file_data() == {"driver 2": "Max Verstappen"}
    assert routes._load_driver_aliases() == {"driver 2": "Max Verstappen"}


def test_missing_file_loads_empty():
    assert routes._load_driver_aliases() == {}


def test_corrupt_file_loads_empty_with_warning_and_is_not_clobbered(caplog):
    with open(routes.DRIVER_ALIASES_FILE, "w", encoding="utf-8") as f:
        f.write("{not json")

    with caplog.at_level(logging.WARNING, logger=routes.logger.name):
        assert routes._load_driver_aliases() == {}

    assert any("driver_aliases.json" in r.getMessage() for r in caplog.records)
    with open(routes.DRIVER_ALIASES_FILE, "r", encoding="utf-8") as f:
        assert f.read() == "{not json"

    assert _set_alias("Driver 1", "Lewis Hamilton").status_code == 200
    assert _file_data() == {"driver 1": "Lewis Hamilton"}


def test_wrong_shape_file_loads_empty_with_warning(caplog):
    with open(routes.DRIVER_ALIASES_FILE, "w", encoding="utf-8") as f:
        json.dump({"driver 1": 5}, f)

    with caplog.at_level(logging.WARNING, logger=routes.logger.name):
        assert routes._load_driver_aliases() == {}

    assert caplog.records


def test_write_failure_returns_500_and_leaves_memory_unchanged(monkeypatch):
    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(routes, "write_json_atomic", boom)

    assert _set_alias("Driver 1", "Lewis Hamilton").status_code == 500
    assert routes.driver_name_aliases == {}
