import os

import pytest

os.environ.setdefault("ALLOWED_HOSTS", "testserver")


@pytest.fixture(autouse=True)
def _isolated_driver_aliases_file(tmp_path, monkeypatch):
    from app.api import udp_telemetry_routes as routes

    monkeypatch.setattr(
        routes, "DRIVER_ALIASES_FILE", str(tmp_path / "driver_aliases.json")
    )
