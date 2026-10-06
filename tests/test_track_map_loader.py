import asyncio
import json
import math

import pytest

from app.services import track_map_loader as tml
from app.services.track_map_loader import TrackService


@pytest.fixture
def track_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(tml, "TRACK_DATA_DIR", tmp_path)
    return tmp_path


def _write_track(track_dir, name, **extra):
    data = {
        "name": name,
        "track_info": f"Track: {name}",
        "points": [{"dist": 0.0, "pos_x": 1.0, "pos_y": 0.0, "pos_z": 2.0, "drs": 0}],
        **extra,
    }
    (track_dir / f"{name}.json").write_text(json.dumps(data), encoding="utf-8")


def _write_geojson(path, coordinates, geometry_type="LineString", properties=None, **overrides):
    data = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": properties if properties is not None else {},
                "geometry": {"type": geometry_type, "coordinates": coordinates},
            }
        ],
        **overrides,
    }
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_lat_lng_to_local_coordinates_without_rotation():
    x, z = TrackService.lat_lng_to_local_coordinates(0.0, 1.0, 0.0, 0.0)

    assert x == pytest.approx(math.radians(1) * 6371000)
    assert z == pytest.approx(0.0)


def test_lat_lng_to_local_coordinates_rotates_by_90_degrees():
    x, z = TrackService.lat_lng_to_local_coordinates(0.0, 1.0, 0.0, 0.0, rotation_degrees=90)

    assert x == pytest.approx(0.0, abs=1e-6)
    assert z == pytest.approx(math.radians(1) * 6371000)


def test_get_available_tracks_lists_json_stems_sorted(track_dir):
    _write_track(track_dir, "monaco")
    _write_track(track_dir, "bahrain")
    (track_dir / "notes.txt").write_text("ignored", encoding="utf-8")

    assert TrackService().get_available_tracks() == ["bahrain", "monaco"]


def test_get_available_tracks_is_empty_when_dir_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(tml, "TRACK_DATA_DIR", tmp_path / "missing")

    assert TrackService().get_available_tracks() == []


def test_find_matching_track_name_empty_input_returns_none():
    assert TrackService().find_matching_track_name("") is None


@pytest.mark.parametrize(
    "input_name, expected",
    [
        ("Italian", "monza"),
        ("Saudi Arabia", "saudi_arabia"),
        ("saudiarabia", "saudi_arabia"),
    ],
)
def test_find_matching_track_name_uses_aliases(track_dir, input_name, expected):
    _write_track(track_dir, "monza")
    _write_track(track_dir, "saudi_arabia")

    assert TrackService().find_matching_track_name(input_name) == expected


def test_alias_target_missing_falls_through_to_exact_match(track_dir):
    _write_track(track_dir, "zzz")
    _write_track(track_dir, "british")

    # "british" aliases to great_britain, which is not available here.
    assert TrackService().find_matching_track_name("British") == "british"


def test_find_matching_track_name_partial_match(track_dir):
    _write_track(track_dir, "aaa")
    _write_track(track_dir, "zandvoort_old")

    assert TrackService().find_matching_track_name("Zandvoort") == "zandvoort_old"


def test_find_matching_track_name_cleaned_match(track_dir):
    _write_track(track_dir, "aaa")
    _write_track(track_dir, "foo_track")

    assert TrackService().find_matching_track_name("circuit_foo") == "foo_track"


def test_find_matching_track_name_returns_none_when_nothing_matches(track_dir, caplog):
    _write_track(track_dir, "monaco")

    assert TrackService().find_matching_track_name("Nowhere") is None
    assert "No matching track found for 'Nowhere'" in caplog.text


def test_parse_geojson_file_builds_rotated_track_with_distances(tmp_path):
    path = _write_geojson(
        tmp_path / "testring.geojson",
        [[0.0, 0.0], [0.001, 0.0], [0.001, 0.001]],
        properties={"Name": "Test Ring", "Location": "Nowhere", "length": 250},
    )

    track = TrackService().parse_geojson_file(path)

    assert track.name == "testring"
    assert track.track_info == "Track: Test Ring, Location: Nowhere, Length: 250m"
    assert len(track.points) == 3
    assert track.points[0].dist == 0.0
    assert track.points[2].dist > track.points[1].dist > 0.0
    # 90 degree rotation: the eastward first segment lands on the z axis.
    dx = track.points[1].pos_x - track.points[0].pos_x
    dz = track.points[1].pos_z - track.points[0].pos_z
    assert dx == pytest.approx(0.0, abs=1e-6)
    assert dz > 0


@pytest.mark.parametrize(
    "track_name, expected_rotation",
    [("portimao", 0), ("abu_dhabi", 15)],
)
def test_parse_geojson_file_uses_per_track_rotation(tmp_path, monkeypatch, track_name, expected_rotation):
    rotations = []
    original = TrackService.lat_lng_to_local_coordinates

    def _spy(lat, lng, center_lat, center_lng, scale=1000, rotation_degrees=0):
        rotations.append(rotation_degrees)
        return original(lat, lng, center_lat, center_lng, scale, rotation_degrees)

    monkeypatch.setattr(TrackService, "lat_lng_to_local_coordinates", staticmethod(_spy))
    path = _write_geojson(tmp_path / f"{track_name}.geojson", [[0.0, 0.0], [0.001, 0.0]])

    track = TrackService().parse_geojson_file(path)

    assert track.track_info == f"Track: {track_name}, Location: Unknown"
    assert set(rotations) == {expected_rotation}


def test_parse_geojson_file_rejects_non_feature_collection(tmp_path, caplog):
    path = _write_geojson(tmp_path / "x.geojson", [[0, 0]], type="Feature")

    assert TrackService().parse_geojson_file(path) is None
    assert "not a FeatureCollection" in caplog.text


def test_parse_geojson_file_rejects_empty_features(tmp_path, caplog):
    path = tmp_path / "x.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": []}), encoding="utf-8")

    assert TrackService().parse_geojson_file(path) is None
    assert "No features found" in caplog.text


def test_parse_geojson_file_rejects_non_linestring(tmp_path, caplog):
    path = _write_geojson(tmp_path / "x.geojson", [[0, 0]], geometry_type="Point")

    assert TrackService().parse_geojson_file(path) is None
    assert "not a LineString" in caplog.text


def test_parse_geojson_file_rejects_missing_coordinates(tmp_path, caplog):
    path = _write_geojson(tmp_path / "x.geojson", [])

    assert TrackService().parse_geojson_file(path) is None
    assert "No coordinates found" in caplog.text


def test_parse_geojson_file_returns_none_on_bad_json(tmp_path, caplog):
    path = tmp_path / "x.geojson"
    path.write_text("{not json", encoding="utf-8")

    assert TrackService().parse_geojson_file(path) is None
    assert "Error parsing GeoJSON file" in caplog.text


def test_load_baked_track_data_reads_json(track_dir):
    _write_track(track_dir, "las_vegas")

    track = TrackService().load_baked_track_data("Las Vegas")

    assert track.name == "las_vegas"
    assert track.points[0].pos_z == 2.0


def test_load_baked_track_data_missing_file_returns_none(track_dir):
    assert TrackService().load_baked_track_data("monaco") is None


def test_load_baked_track_data_invalid_content_returns_none(track_dir, caplog):
    (track_dir / "monaco.json").write_text(json.dumps({"name": "monaco"}), encoding="utf-8")

    assert TrackService().load_baked_track_data("monaco") is None
    assert "Error reading pre-built track file" in caplog.text


def test_load_track_data_caches_result(track_dir):
    _write_track(track_dir, "monaco")
    service = TrackService()

    first = asyncio.run(service.load_track_data("Monaco"))
    (track_dir / "monaco.json").write_text("{}", encoding="utf-8")
    second = asyncio.run(service.load_track_data("Monaco"))

    assert first is second
    assert service.track_cache == {"monaco": first}


def test_load_track_data_empty_name_returns_none():
    assert asyncio.run(TrackService().load_track_data("")) is None


def test_load_track_data_unknown_track_returns_none(track_dir):
    assert asyncio.run(TrackService().load_track_data("Nowhere")) is None


def test_load_track_data_unreadable_baked_file_returns_none(track_dir, caplog):
    (track_dir / "monaco.json").write_text("{}", encoding="utf-8")
    service = TrackService()

    assert asyncio.run(service.load_track_data("monaco")) is None
    assert service.track_cache == {}
    assert "No pre-built track data for 'monaco'" in caplog.text


def test_bundled_track_data_loads_for_every_available_track():
    service = TrackService()

    tracks = service.get_available_tracks()

    assert "monaco" in tracks
    for name in tracks:
        assert service.load_baked_track_data(name).points
