import io
import json

import pytest
import segno
from fastapi.testclient import TestClient

from app.api import display_data_routes
from app.main import app
from app.models.data_models import Driver, LapTime
from app.services import lap_time_store, saved_lap_records
from app.services import track_map_loader
from app.services.lap_time_store import app_data


client = TestClient(app)


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    monkeypatch.setattr(app_data, "drivers", {})
    monkeypatch.setattr(app_data, "track_name", None)
    monkeypatch.setattr(lap_time_store, "websocket_manager", None)
    monkeypatch.setattr(saved_lap_records, "TRACK_TIMES_DIR", str(tmp_path))
    monkeypatch.setattr(display_data_routes.track_service, "track_cache", {})
    return tmp_path


def _write_records(tmp_path, track, records):
    path = tmp_path / saved_lap_records.make_safe_file_name(track)
    path.write_text(json.dumps({"track": track, "lap_times": records}), encoding="utf-8")
    return path


def test_get_live_drivers_uses_live_data(monkeypatch):
    async def fake_live():
        return {"Car 1": {"name": "Car 1", "team": "Ferrari", "world_x": 1.5}}

    monkeypatch.setattr(display_data_routes, "get_live_driver_data_for_api", fake_live)

    resp = client.get("/api/drivers/live")

    assert resp.status_code == 200
    assert resp.json()["Car 1"]["world_x"] == 1.5


def test_get_track_without_track_returns_empty_name():
    assert client.get("/api/track").json() == {"name": ""}


def test_get_track_returns_matched_track_name():
    app_data.track_name = "Italian"

    assert client.get("/api/track").json() == {"name": "monza"}


def test_get_track_returns_stored_name_when_unmatched():
    app_data.track_name = "Nowhere"

    assert client.get("/api/track").json() == {"name": "Nowhere"}


def test_set_track_stores_matched_name():
    resp = client.post("/api/track", json={"name": "British"})

    assert resp.json() == {"name": "great_britain"}
    assert app_data.track_name == "great_britain"


def test_set_track_stores_raw_name_when_unmatched():
    resp = client.post("/api/track", json={"name": " Nowhere "})

    assert resp.json() == {"name": "Nowhere"}
    assert app_data.track_name == "Nowhere"


def test_set_track_to_blank_returns_empty_name():
    app_data.track_name = "monza"

    assert client.post("/api/track", json={"name": ""}).json() == {"name": ""}
    assert app_data.track_name is None


def test_get_track_data_for_explicit_track():
    resp = client.get("/api/track/data", params={"track": "monaco"})

    assert resp.status_code == 200
    assert resp.json()["name"] == "monaco"
    assert resp.json()["points"]


def test_get_track_data_falls_back_to_current_track():
    app_data.track_name = "monaco"

    assert client.get("/api/track/data").json()["name"] == "monaco"


def test_get_track_data_without_track_is_404():
    resp = client.get("/api/track/data")

    assert resp.status_code == 404
    assert resp.json() == {"detail": "No track name set or specified"}


def test_get_track_data_unknown_track_is_404():
    resp = client.get("/api/track/data", params={"track": "Nowhere"})

    assert resp.status_code == 404
    assert resp.json() == {"detail": "Track data not found for 'Nowhere'"}


def test_get_track_records_for_current_track(isolated_state):
    app_data.track_name = "monza"
    records = [{"driver": "Max", "time": "1:20.000"}]
    _write_records(isolated_state, "monza", records)

    assert client.get("/api/track/records").json() == {"track": "monza", "lap_times": records}


def test_get_track_records_for_explicit_track_without_file():
    assert client.get("/api/track/records", params={"track": "spa"}).json() == {
        "track": "spa",
        "lap_times": [],
    }


def test_get_track_records_without_track_is_404():
    assert client.get("/api/track/records").status_code == 404


def test_get_track_records_with_corrupt_file_returns_empty(isolated_state):
    (isolated_state / "monza.json").write_text("[]", encoding="utf-8")

    resp = client.get("/api/track/records", params={"track": "monza"})

    assert resp.json() == {"track": "monza", "lap_times": []}


def test_delete_record_removes_matching_lap(isolated_state):
    path = _write_records(
        isolated_state,
        "monza",
        [
            {"driver": "Max", "time": "1:20.000", "recorded_at": "2026-01-01T00:00:00"},
            {"driver": "Lewis", "time": "1:21.000", "recorded_at": "2026-01-01T00:01:00"},
        ],
    )

    resp = client.post(
        "/api/track/records/delete",
        json={"driver": "Max", "time": "1:20.000", "recorded_at": "2026-01-01T00:00:00", "track": "monza"},
    )

    assert resp.json() == {"deleted": True, "track": "monza"}
    remaining = json.loads(path.read_text(encoding="utf-8"))["lap_times"]
    assert [r["driver"] for r in remaining] == ["Lewis"]


def test_delete_record_uses_current_track_and_404s_when_no_match(isolated_state):
    app_data.track_name = "monza"
    _write_records(isolated_state, "monza", [])

    resp = client.post("/api/track/records/delete", json={"driver": "Max", "time": "1:20.000"})

    assert resp.status_code == 404
    assert resp.json() == {"detail": "No matching lap to delete"}


def test_delete_record_without_track_is_404():
    resp = client.post("/api/track/records/delete", json={"driver": "Max", "time": "1:20.000"})

    assert resp.status_code == 404
    assert resp.json() == {"detail": "No track name set or specified"}


def test_delete_record_with_corrupt_file_is_500(isolated_state):
    (isolated_state / "monza.json").write_text("{}", encoding="utf-8")

    resp = client.post(
        "/api/track/records/delete",
        json={"driver": "Max", "time": "1:20.000", "track": "monza"},
    )

    assert resp.status_code == 500
    assert resp.json() == {"detail": "Could not update lap records for track 'monza'"}


def test_export_csv_without_track_is_404():
    assert client.get("/api/track/records/export.csv").status_code == 404


def test_export_csv_returns_laps_and_neutralises_formulas(isolated_state):
    app_data.track_name = "Monza"
    _write_records(isolated_state, "Monza", [
        {"driver": '=HYPERLINK("x")', "team": "+Ferrari", "time": "1:21.000",
         "is_valid": True, "fastest_speed_kph": 340, "sector_1_ms": None},
        {"driver": "Max", "team": "Red Bull", "time": "1:20.500", "is_valid": False},
    ])

    resp = client.get("/api/track/records/export.csv")

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert resp.headers["content-disposition"] == 'attachment; filename="monza_laps.csv"'
    rows = resp.text.splitlines()
    assert rows[0] == (
        "driver,team,time,is_valid,fastest_speed_kph,"
        "sector_1_ms,sector_2_ms,sector_3_ms,recorded_at"
    )
    assert rows[1] == "\"'=HYPERLINK(\"\"x\"\")\",'+Ferrari,1:21.000,True,340,,,,"
    assert rows[2] == "Max,Red Bull,1:20.500,False,,,,,"


def test_export_csv_with_corrupt_file_is_500(isolated_state):
    (isolated_state / "monza.json").write_text("{}", encoding="utf-8")

    resp = client.get("/api/track/records/export.csv?track=monza")

    assert resp.status_code == 500
    assert resp.json() == {"detail": "Could not read lap records for track 'monza'"}


@pytest.mark.parametrize(
    "base_url, expected",
    [
        ("http://testserver:8000", "http://192.168.1.50:8000/"),
        ("http://testserver", "http://192.168.1.50/"),
    ],
)
def test_qr_svg_encodes_lan_url(monkeypatch, base_url, expected):
    monkeypatch.setattr(display_data_routes, "get_local_ip", lambda: "192.168.1.50")
    expected_svg = io.BytesIO()
    segno.make(expected).save(expected_svg, kind="svg", scale=4, border=2, xmldecl=False)

    resp = TestClient(app, base_url=base_url).get("/api/qr.svg")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/svg+xml"
    assert resp.content == expected_svg.getvalue()
    assert "script-src 'self'" in resp.headers["content-security-policy"]
