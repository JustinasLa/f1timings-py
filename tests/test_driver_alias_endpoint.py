import pytest
from fastapi.testclient import TestClient

from app.api import udp_telemetry_routes as routes
from app.main import app


client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_aliases():
    """driver_name_aliases is an in-memory module-level dict; isolate tests."""
    routes.driver_name_aliases.clear()
    yield
    routes.driver_name_aliases.clear()


def _set_alias(telemetry_name, display_name):
    return client.post(
        "/api/telemetry/driver_alias",
        json={"telemetry_name": telemetry_name, "display_name": display_name},
    )


def test_display_name_60_chars_is_rejected():
    resp = _set_alias("car1", "A" * 60)
    assert resp.status_code == 400


def test_display_name_exactly_48_chars_is_accepted():
    resp = _set_alias("car1", "A" * 48)
    assert resp.status_code == 200


def test_display_name_49_chars_is_rejected():
    resp = _set_alias("car1", "A" * 49)
    assert resp.status_code == 400


@pytest.mark.parametrize(
    "bad_name",
    ["bad\x01name", "bad\x7fname", "bad\nname"],
)
def test_display_name_with_control_characters_is_rejected(bad_name):
    resp = _set_alias("car1", bad_name)
    assert resp.status_code == 400


def test_display_name_is_stripped_of_surrounding_whitespace():
    resp = _set_alias("car1", "  Lewis Hamilton  ")
    assert resp.status_code == 200

    aliases = client.get("/api/telemetry/driver_aliases").json()
    assert aliases.get(routes._normalize_driver_name("car1")) == "Lewis Hamilton"


def test_normal_display_name_is_accepted():
    resp = _set_alias("car1", "Lewis Hamilton")
    assert resp.status_code == 200
    assert resp.json().get(routes._normalize_driver_name("car1")) == "Lewis Hamilton"
