import datetime
import importlib.util
import json
import math
import os
import runpy
import sys
import types

import pytest

from app.services.track_map_loader import track_service


SCRIPT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "scripts",
    "fetch_fastf1_tracks.py",
)
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(SCRIPT_PATH)))


def _seconds(value):
    return datetime.timedelta(seconds=value)


class FakeSeries:
    def __init__(self, values):
        self.values = list(values)

    def __ge__(self, other):
        return FakeSeries(value >= other for value in self.values)

    def __le__(self, other):
        return FakeSeries(value <= other for value in self.values)

    def __and__(self, other):
        return FakeSeries(a and b for a, b in zip(self.values, other.values))


class FakeFrame:
    def __init__(self, rows):
        self.rows = [dict(row) for row in rows]

    def iterrows(self):
        for index, row in enumerate(self.rows):
            yield index, dict(row)

    def __getitem__(self, key):
        if isinstance(key, FakeSeries):
            return FakeFrame(
                row for row, keep in zip(self.rows, key.values) if keep
            )
        return FakeSeries(row[key] for row in self.rows)

    @property
    def iloc(self):
        return self.rows


class FakeLap(dict):
    def __init__(self, values, pos_data):
        super().__init__(values)
        self._pos_data = pos_data

    def get_pos_data(self):
        return self._pos_data


class FakeLaps(FakeFrame):
    def __init__(self, rows, fastest=None):
        super().__init__(rows)
        self._fastest = fastest

    def pick_fastest(self):
        return self._fastest


class FakeSession:
    def __init__(self, laps=None, pos_data=None, rotation=0.0):
        self.laps = laps
        self.pos_data = pos_data or {}
        self.rotation = rotation
        self.loaded = False

    def load(self):
        self.loaded = True

    def get_circuit_info(self):
        return types.SimpleNamespace(rotation=self.rotation)


def _make_fake_fastf1(session=None):
    fake = types.ModuleType("fastf1")
    fake.calls = {"get_session": [], "enable_cache": []}

    def get_session(season, event, session_name):
        fake.calls["get_session"].append((season, event, session_name))
        return session

    def enable_cache(path):
        fake.calls["enable_cache"].append(path)

    fake.get_session = get_session
    fake.Cache = types.SimpleNamespace(enable_cache=enable_cache)
    return fake


def _make_fake_pandas():
    fake = types.ModuleType("pandas")
    fake.Timedelta = datetime.timedelta
    fake.isnull = lambda value: value is None
    return fake


def _install_fakes(monkeypatch, fastf1_module=None):
    fastf1_module = fastf1_module or _make_fake_fastf1()
    monkeypatch.setitem(sys.modules, "fastf1", fastf1_module)
    monkeypatch.setitem(sys.modules, "pandas", _make_fake_pandas())
    return fastf1_module


def _load_script(monkeypatch, fastf1_module=None):
    _install_fakes(monkeypatch, fastf1_module)
    spec = importlib.util.spec_from_file_location(
        "fetch_fastf1_tracks_under_test", SCRIPT_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def script(monkeypatch):
    return _load_script(monkeypatch)


def _approx_point(point, abs_tol=1e-6):
    return pytest.approx(point, abs=abs_tol)


# --- module import -----------------------------------------------------------


def test_import_adds_repo_root_to_sys_path_when_missing(monkeypatch):
    monkeypatch.setattr(sys, "path", [p for p in sys.path if p != REPO_ROOT])

    module = _load_script(monkeypatch)

    assert module.REPO_ROOT == REPO_ROOT
    assert sys.path[0] == REPO_ROOT
    assert sys.path.count(REPO_ROOT) == 1


def test_import_does_not_duplicate_repo_root_in_sys_path(monkeypatch):
    monkeypatch.setattr(sys, "path", [REPO_ROOT] + [p for p in sys.path if p != REPO_ROOT])
    before = list(sys.path)

    _load_script(monkeypatch)

    assert sys.path == before


# --- geometry helpers --------------------------------------------------------


def test_rotate_point_and_to_local_coordinates(script):
    assert script.rotate_point(1.0, 0.0, 90) == _approx_point((0.0, 1.0))
    assert script.rotate_point(1.0, 2.0, 0) == _approx_point((1.0, 2.0))
    # rotated (0, 1) -> pos_x = -rotated_y, pos_z = rotated_x
    assert script.to_local_coordinates(1.0, 0.0, 90) == _approx_point((-1.0, 0.0))
    assert script.to_local_coordinates(3.0, 4.0, 0) == _approx_point((-4.0, 3.0))


def test_find_position_at_session_time_picks_nearest_row(script):
    pos_data = FakeFrame(
        [
            {"SessionTime": _seconds(10), "X": 1.0, "Y": 10.0},
            {"SessionTime": _seconds(11), "X": 2.0, "Y": 20.0},
            {"SessionTime": _seconds(12), "X": 3.0, "Y": 30.0},
            {"SessionTime": _seconds(13), "X": 4.0, "Y": 40.0},
        ]
    )

    assert script.find_position_at_session_time(pos_data, _seconds(11.4)) == (2.0, 20.0)
    assert script.find_position_at_session_time(pos_data, _seconds(5)) == (1.0, 10.0)
    assert script.find_position_at_session_time(pos_data, _seconds(99)) == (4.0, 40.0)


def test_loop_and_path_length(script):
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert script.loop_length(square) == pytest.approx(40.0)
    assert script.path_length(square) == pytest.approx(30.0)
    assert script.path_length([(5.0, 5.0)]) == 0.0


def test_resample_closed_loop_evenly_spaces_samples(script):
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]

    samples = script.resample_closed_loop(square, 8)

    expected = [
        (0, 0), (5, 0), (10, 0), (10, 5), (10, 10), (5, 10), (0, 10), (0, 5)
    ]
    assert len(samples) == 8
    for actual, wanted in zip(samples, expected):
        assert actual == _approx_point(wanted)


def test_resample_closed_loop_handles_duplicate_points(script):
    points = [(0.0, 0.0), (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]

    samples = script.resample_closed_loop(points, 4)

    expected = [(0, 0), (10, 0), (10, 10), (0, 10)]
    for actual, wanted in zip(samples, expected):
        assert actual == _approx_point(wanted)


def test_resample_closed_loop_zero_length_returns_copy(script):
    points = [(1.0, 1.0), (1.0, 1.0)]

    result = script.resample_closed_loop(points, 10)

    assert result == points
    assert result is not points


def test_centroid_center_points_and_rms_radius(script):
    points = [(1.0, 1.0), (3.0, 1.0), (3.0, 3.0), (1.0, 3.0)]

    center = script.centroid(points)
    centered = script.center_points(points, center)

    assert center == _approx_point((2.0, 2.0))
    assert centered == [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)]
    assert script.rms_radius(centered) == pytest.approx(math.sqrt(2.0))


def _asymmetric_loop(count):
    points = []
    for i in range(count):
        theta = 2 * math.pi * i / count
        x = 1000 * math.cos(theta) + 250 * math.cos(2 * theta)
        z = 600 * math.sin(theta) + 100 * math.sin(3 * theta)
        points.append((x, z))
    return points


def _similarity(points, scale, rotation_degrees, offset):
    angle = math.radians(rotation_degrees)
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    result = []
    for x, z in points:
        sx = x * scale
        sz = z * scale
        result.append(
            (sx * cos_a - sz * sin_a + offset[0], sx * sin_a + sz * cos_a + offset[1])
        )
    return result


def test_best_alignment_recovers_similarity_transform(script):
    source = _asymmetric_loop(40)
    target = _similarity(source, 0.05, 40.0, (12.0, -7.0))

    transform = script.best_alignment(source, target)

    assert transform["scale"] == pytest.approx(0.05)
    assert math.degrees(transform["rotation"]) == pytest.approx(40.0)
    for raw, wanted in zip(source, target):
        assert script.apply_transform(raw[0], raw[1], transform) == _approx_point(wanted)


def test_best_alignment_handles_reversed_target_direction(script):
    source = _asymmetric_loop(40)
    forward = _similarity(source, 2.0, -75.0, (-3.0, 8.0))
    reversed_target = [forward[0]] + list(reversed(forward[1:]))

    transform = script.best_alignment(source, reversed_target)

    assert transform["scale"] == pytest.approx(2.0)
    assert math.degrees(transform["rotation"]) == pytest.approx(-75.0)
    for raw, wanted in zip(source, forward):
        assert script.apply_transform(raw[0], raw[1], transform) == _approx_point(wanted)


def test_apply_transform(script):
    transform = {
        "source_center": (1.0, 1.0),
        "target_center": (10.0, 10.0),
        "scale": 2.0,
        "rotation": math.pi / 2,
    }

    assert script.apply_transform(2.0, 1.0, transform) == _approx_point((10.0, 12.0))
    assert script.apply_transform(1.0, 1.0, transform) == _approx_point((10.0, 10.0))


def test_load_geojson_outline_returns_pos_x_pos_z(script, monkeypatch):
    seen = []

    def fake_parse(path):
        seen.append(path)
        return types.SimpleNamespace(
            points=[
                types.SimpleNamespace(pos_x=1.0, pos_z=2.0),
                types.SimpleNamespace(pos_x=3.0, pos_z=4.0),
            ]
        )

    monkeypatch.setattr(track_service, "parse_geojson_file", fake_parse)

    outline = script.load_geojson_outline(os.path.join("geojson", "monaco.geojson"))

    assert outline == [(1.0, 2.0), (3.0, 4.0)]
    assert str(seen[0]) == os.path.join("geojson", "monaco.geojson")


def test_load_geojson_outline_against_real_parser(script, tmp_path):
    geojson_file = tmp_path / "custom.geojson"
    geojson_file.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "properties": {},
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[0.0, 0.0], [0.001, 0.0], [0.001, 0.001]],
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    outline = script.load_geojson_outline(str(geojson_file))

    assert len(outline) == 3
    assert all(len(point) == 2 for point in outline)


def test_load_geojson_outline_raises_when_unparseable(script, monkeypatch):
    monkeypatch.setattr(track_service, "parse_geojson_file", lambda path: None)

    with pytest.raises(RuntimeError, match="Could not parse missing.geojson"):
        script.load_geojson_outline("missing.geojson")


def test_remove_close_points(script):
    assert script.remove_close_points([], 5.0) == []

    points = [(0.0, 0.0), (1.0, 0.0), (5.0, 0.0), (6.0, 0.0), (6.0, 6.0)]
    assert script.remove_close_points(points, 5.0) == [
        (0.0, 0.0),
        (5.0, 0.0),
        (6.0, 6.0),
    ]


def test_collect_pit_points_filters_window_and_converts(script):
    session = FakeSession(
        pos_data={
            "44": FakeFrame(
                [
                    {"SessionTime": _seconds(1), "X": 100.0, "Y": 100.0},
                    {"SessionTime": _seconds(5), "X": 1.0, "Y": 2.0},
                    {"SessionTime": _seconds(6), "X": 3.0, "Y": 4.0},
                    {"SessionTime": _seconds(7), "X": 5.0, "Y": 6.0},
                    {"SessionTime": _seconds(9), "X": 100.0, "Y": 100.0},
                ]
            )
        }
    )

    points = script.collect_pit_points(session, "44", _seconds(5), _seconds(7), 0)

    assert points == [(-2.0, 1.0), (-4.0, 3.0), (-6.0, 5.0)]


def test_turn_angle(script):
    assert script.turn_angle((0, 0), (1, 0), (2, 0)) == pytest.approx(0.0)
    assert script.turn_angle((0, 0), (1, 0), (1, 1)) == pytest.approx(90.0)
    assert script.turn_angle((0, 0), (1, 0), (0, 0)) == pytest.approx(180.0)
    assert script.turn_angle((0, 0), (0, 0), (1, 1)) == 0.0
    assert script.turn_angle((0, 0), (1, 1), (1, 1)) == 0.0


def test_turn_angle_clamps_floating_point_cosine(script):
    a = (0.0, 0.0)
    b = (6.550770429955353, 7.908361176241581)
    forward = (13.292888268474906, 16.047724863293766)
    backward = (3.1797115106955767, 3.838679332715488)

    assert script.turn_angle(a, b, forward) == 0.0
    assert script.turn_angle(a, b, backward) == 180.0


def test_remove_sharp_turns(script):
    first_point_spike = [(0.0, 0.0), (10.0, 0.0), (0.0, 1.0), (20.0, 0.0), (30.0, 0.0)]
    assert script.remove_sharp_turns(first_point_spike, 90.0) == [
        (0.0, 0.0),
        (20.0, 0.0),
        (30.0, 0.0),
    ]

    later_spike = [(0.0, 0.0), (10.0, 0.0), (20.0, 0.0), (10.0, 1.0), (30.0, 0.0), (40.0, 0.0)]
    result = script.remove_sharp_turns(later_spike, 90.0)
    assert result == [(0.0, 0.0), (10.0, 0.0), (30.0, 0.0), (40.0, 0.0)]
    assert later_spike[3] == (10.0, 1.0)


def test_smooth_path(script):
    points = [(0.0, 0.0), (3.0, 3.0), (0.0, 0.0), (3.0, 3.0), (0.0, 0.0)]

    assert script.smooth_path(points, 2) is points
    assert script.smooth_path(points[:3], 3) == points[:3]
    assert script.smooth_path(points, 3) == [
        (0.0, 0.0),
        (1.0, 1.0),
        (2.0, 2.0),
        (1.0, 1.0),
        (0.0, 0.0),
    ]


def _line_outline(start=-200, stop=1000, step=2):
    return [(0.0, float(z)) for z in range(start, stop + 1, step)]


def test_nearest_outline_point_and_distance(script):
    outline = [(0.0, 0.0), (10.0, 0.0), (20.0, 0.0)]

    assert script.nearest_outline_point((11.0, 3.0), outline) == (10.0, 0.0)
    assert script.nearest_outline_distance((11.0, 3.0), outline) == pytest.approx(
        math.sqrt(10.0)
    )


def test_trim_pitlane_ends(script):
    outline = _line_outline(-100, 100, 1)

    assert script.trim_pitlane_ends([], outline, 10.0) == []

    points = [(0.0, 0.0), (5.0, 10.0), (20.0, 20.0), (20.0, 30.0), (5.0, 40.0), (0.0, 50.0)]
    assert script.trim_pitlane_ends(points, outline, 10.0) == points[1:5]

    on_track = [(0.0, 0.0), (0.0, 10.0), (0.0, 20.0)]
    assert script.trim_pitlane_ends(on_track, outline, 10.0) == on_track


def test_straighten_start_end_too_short_is_unchanged(script):
    points = [(0.0, float(z)) for z in range(5)]
    assert script.straighten_start_end(points, [(0.0, 0.0)]) is points


def test_straighten_start_end_stops_at_first_shallow_anchor(script):
    points = [(10.0, float(10 * k)) for k in range(10)]

    result = script.straighten_start_end(points, [(0.0, 0.0), (0.0, 50.0)])

    assert result[0] == (0.0, 0.0)
    assert result[2] == _approx_point((5.0, 20.0))
    assert result[4] == _approx_point((10.0, 40.0))
    assert result[5:] == points[5:]


def test_straighten_start_end_uses_smallest_angle_when_none_shallow(script):
    points = [
        (0.0, 0.0), (0.0, 10.0), (0.0, 20.0), (0.0, 30.0), (0.0, 40.0),
        (10.0, 40.0), (20.0, 40.0), (20.0, 30.0), (20.0, 20.0), (20.0, 10.0),
    ]

    result = script.straighten_start_end(points, [(0.0, 0.0)])

    # Anchor 5 (76 degrees) beats anchor 4 (90) and later anchors (>130).
    assert result[1] == _approx_point((2.0, 8.0))
    assert result[5] == _approx_point((10.0, 40.0))
    assert result[6:] == points[6:]


def test_straighten_merge_ends_straightens_both_ends(script):
    points = [(10.0, float(10 * k)) for k in range(12)]
    outline = [(0.0, 0.0), (0.0, 110.0)]

    result = script.straighten_merge_ends(points, outline)

    assert result[0] == (0.0, 0.0)
    assert result[-1] == (0.0, 110.0)
    assert result[5] == points[5]


def test_median_value(script):
    assert script.median_value([]) == 0.0
    assert script.median_value([3.0, 1.0, 2.0]) == 2.0
    assert script.median_value([4.0, 1.0, 3.0, 2.0]) == 2.5


def test_resample_path(script):
    assert script.resample_path([(1.0, 1.0)], 5) == [(1.0, 1.0)]
    assert script.resample_path([(0.0, 0.0), (1.0, 0.0)], 1) == [(0.0, 0.0), (1.0, 0.0)]
    assert script.resample_path([(2.0, 2.0), (2.0, 2.0)], 5) == [(2.0, 2.0), (2.0, 2.0)]

    result = script.resample_path([(0.0, 0.0), (0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], 5)
    expected = [(0, 0), (5, 0), (10, 0), (10, 5), (10, 10)]
    assert len(result) == 5
    for actual, wanted in zip(result, expected):
        assert actual == _approx_point(wanted)


def _straight_trace(length, count=90):
    return [(length * i / (count - 1), 0.0) for i in range(count)]


def test_average_pit_traces_drops_length_outliers(script):
    short = _straight_trace(10.0)
    typical = [(x, 1.0) for x, _ in _straight_trace(11.0)]
    outlier = _straight_trace(30.0)

    averaged, used = script.average_pit_traces([short, typical, outlier])

    assert used == 2
    assert len(averaged) == script.PIT_RESAMPLE_POINTS
    assert averaged[0] == _approx_point((0.0, 0.5))
    assert averaged[-1] == _approx_point((10.5, 0.5))


def test_average_pit_traces_keeps_all_when_every_trace_is_an_outlier(script):
    averaged, used = script.average_pit_traces([_straight_trace(10.0), _straight_trace(30.0)])

    assert used == 2
    assert averaged[-1] == _approx_point((20.0, 0.0))


def test_average_pit_traces_with_zero_typical_length(script):
    still = [(0.0, 0.0)] * 90
    moving = [(3.0 * i, 0.0) for i in range(90)]

    averaged, used = script.average_pit_traces([still, list(still), moving])

    assert used == 3
    assert averaged[30] == _approx_point((30.0, 0.0))


# --- pit lane ----------------------------------------------------------------


def _pos_rows_for_game_points(game_points, start_seconds):
    rows = []
    for index, (pos_x, pos_z) in enumerate(game_points):
        # rotation 0: pos_x = -Y, pos_z = X
        rows.append(
            {"SessionTime": _seconds(start_seconds + index), "X": pos_z, "Y": -pos_x}
        )
    return rows


def _pit_path(offset):
    points = []
    for z in range(0, 781, 60):
        if z <= 120 or z >= 660:
            points.append((0.0, float(z)))
        else:
            points.append((float(offset), float(z)))
    return points


def _pit_driver_rows(game_points, pit_in_seconds):
    noise_before = {"SessionTime": _seconds(pit_in_seconds - 50), "X": 500.0, "Y": 500.0}
    noise_after = {"SessionTime": _seconds(pit_in_seconds + 200), "X": -500.0, "Y": 900.0}
    rows = _pos_rows_for_game_points(game_points, pit_in_seconds - 4)
    return [noise_before] + rows + [noise_after]


IDENTITY = {
    "source_center": (0.0, 0.0),
    "target_center": (0.0, 0.0),
    "scale": 1.0,
    "rotation": 0.0,
}


def _lap(driver, lap_number, pit_in=None, pit_out=None):
    return {
        "DriverNumber": driver,
        "LapNumber": lap_number,
        "PitInTime": pit_in,
        "PitOutTime": pit_out,
    }


def test_build_pitlane_averages_valid_pit_visits(script, capsys):
    trace_40 = _pit_path(40)
    trace_44 = _pit_path(44)
    trace_far = _pit_path(320)
    trimmed_away = [
        (0.0, 0.0), (0.0, 60.0), (0.0, 120.0), (0.0, 180.0), (40.0, 240.0),
        (40.0, 300.0), (0.0, 360.0), (0.0, 420.0), (0.0, 480.0), (0.0, 540.0),
    ]
    too_few = [(0.0, 0.0), (40.0, 100.0), (0.0, 200.0)]

    pos_data = {
        "1": FakeFrame(_pit_driver_rows(trace_40, 100)),
        "2": FakeFrame(_pit_driver_rows(trace_44, 300)),
        "3": FakeFrame(_pit_driver_rows(trace_far, 500)),
        "5": FakeFrame(_pit_driver_rows(trimmed_away, 700)),
        "6": FakeFrame(_pit_driver_rows(too_few, 900)),
    }

    def pit_window(start, points):
        return _seconds(start), _seconds(start + len(points) - 8)

    laps = FakeLaps(
        [
            _lap("1", 4),
            _lap("1", 5, pit_in=pit_window(100, trace_40)[0]),
            _lap("2", 9),
            _lap("1", 6),
            _lap("1", 6, pit_out=pit_window(100, trace_40)[1]),
            _lap("2", 10, pit_in=pit_window(300, trace_44)[0]),
            _lap("2", 11, pit_out=pit_window(300, trace_44)[1]),
            _lap("3", 2, pit_in=pit_window(500, trace_far)[0]),
            _lap("3", 3, pit_out=pit_window(500, trace_far)[1]),
            _lap("4", 7, pit_in=_seconds(50)),
            _lap("4", 8),
            _lap("5", 1, pit_in=pit_window(700, trimmed_away)[0]),
            _lap("5", 2, pit_out=pit_window(700, trimmed_away)[1]),
            _lap("6", 1, pit_in=pit_window(900, too_few)[0]),
            _lap("6", 2, pit_out=pit_window(900, too_few)[1]),
        ]
    )
    session = FakeSession(laps=laps, pos_data=pos_data)

    pitlane = script.build_pitlane(session, 0, IDENTITY, _line_outline())

    assert len(pitlane) == script.PIT_RESAMPLE_POINTS
    assert pitlane[0] == {"pos_x": 0.0, "pos_z": 60.0}
    assert pitlane[-1] == {"pos_x": 0.0, "pos_z": 720.0}
    assert pitlane[45]["pos_x"] == pytest.approx(42.0)
    assert all(-1.0 <= p["pos_x"] <= 45.0 for p in pitlane)
    assert all(55.0 <= p["pos_z"] <= 725.0 for p in pitlane)
    for point in pitlane:
        assert point["pos_x"] == round(point["pos_x"], 4)

    out = capsys.readouterr().out
    assert "Pit lane averaged from 2 of 3 driver pit visits: 90 points" in out


def test_build_one_pit_trace_rejects_short_traces(script):
    outline = _line_outline()
    trimmed_away = [
        (0.0, 0.0), (0.0, 60.0), (0.0, 120.0), (0.0, 180.0), (40.0, 240.0),
        (40.0, 300.0), (0.0, 360.0), (0.0, 420.0), (0.0, 480.0), (0.0, 540.0),
    ]
    dense = [(0.0, float(z)) for z in range(0, 200, 10)]
    session = FakeSession(
        pos_data={
            "5": FakeFrame(_pos_rows_for_game_points(trimmed_away, 0)),
            "6": FakeFrame(_pos_rows_for_game_points(dense, 0)),
        }
    )

    assert script.build_one_pit_trace(
        session, "5", _seconds(0), _seconds(9), 0, IDENTITY, outline
    ) is None
    assert script.build_one_pit_trace(
        session, "6", _seconds(0), _seconds(19), 0, IDENTITY, outline
    ) is None


def test_build_one_pit_trace_returns_trimmed_game_frame_points(script):
    trace = _pit_path(40)
    session = FakeSession(pos_data={"1": FakeFrame(_pos_rows_for_game_points(trace, 0))})

    result = script.build_one_pit_trace(
        session, "1", _seconds(5), _seconds(len(trace) - 6), 0, IDENTITY, _line_outline()
    )

    assert result is not None
    assert len(result) == len(trace) - 2
    assert result[0] == _approx_point((0.0, 60.0))
    assert result[-1] == _approx_point((0.0, 720.0))
    assert result[5] == _approx_point((40.0, 360.0))


def test_build_pitlane_without_pit_stops_returns_empty(script, capsys):
    laps = FakeLaps([_lap("1", 1), _lap("1", 2), _lap("2", 1, pit_in=_seconds(5))])

    pitlane = script.build_pitlane(FakeSession(laps=laps), 0, IDENTITY, _line_outline())

    assert pitlane == []
    assert "No usable pit stop found; pit lane will be empty." in capsys.readouterr().out


# --- build_one_track ---------------------------------------------------------


def _local_from_raw(x, y, rotation_degrees):
    angle = math.radians(rotation_degrees)
    rx = x * math.cos(angle) - y * math.sin(angle)
    ry = x * math.sin(angle) + y * math.cos(angle)
    return -ry, rx


def test_build_one_track_writes_calibrated_json(script, monkeypatch, tmp_path, capsys):
    rotation = 30.0
    raw = _asymmetric_loop(48)
    pos_rows = [
        {"SessionTime": _seconds(i), "X": x, "Y": y} for i, (x, y) in enumerate(raw)
    ]
    pos_data = FakeFrame(pos_rows)
    fastest = FakeLap(
        {"Sector1SessionTime": _seconds(10.3), "Sector2SessionTime": _seconds(30.6)},
        pos_data,
    )
    laps = FakeLaps([_lap("1", 1), _lap("1", 2)], fastest=fastest)
    session = FakeSession(laps=laps, rotation=rotation)
    fake_fastf1 = _make_fake_fastf1(session)
    monkeypatch.setattr(script, "fastf1", fake_fastf1)
    monkeypatch.setattr(script, "OUTPUT_DIR", str(tmp_path))

    local = [_local_from_raw(x, y, rotation) for x, y in raw]
    outline = _similarity(local, 0.05, 40.0, (12.0, -7.0))
    parsed_paths = []

    def fake_parse(path):
        parsed_paths.append(str(path))
        return types.SimpleNamespace(
            points=[types.SimpleNamespace(pos_x=x, pos_z=z) for x, z in outline]
        )

    monkeypatch.setattr(track_service, "parse_geojson_file", fake_parse)

    script.build_one_track("monaco", 2024, "Monaco", "Q")

    assert fake_fastf1.calls["get_session"] == [(2024, "Monaco", "Q")]
    assert session.loaded is True
    assert parsed_paths == [os.path.join("geojson", "monaco.geojson")]

    with open(tmp_path / "monaco.json", "r", encoding="utf-8") as handle:
        data = json.load(handle)

    assert data["name"] == "monaco"
    assert data["track_info"] == (
        "Track: Monaco (FastF1 2024 Q, game-frame calibrated)"
    )
    assert data["pitlane"] == []
    assert len(data["points"]) == 48
    expected_distance = 0.0
    for index, point in enumerate(data["points"]):
        if index > 0:
            expected_distance += math.dist(outline[index - 1], outline[index])
        assert (point["pos_x"], point["pos_z"]) == _approx_point(outline[index], 1e-6)
        assert point["pos_y"] == 0.0
        assert point["drs"] == 0
        assert point["dist"] == pytest.approx(expected_distance)
    assert data["points"][0]["dist"] == 0.0

    markers = {marker["label"]: marker for marker in data["markers"]}
    assert [marker["label"] for marker in data["markers"]] == ["S/F", "S1", "S2"]
    assert (markers["S/F"]["pos_x"], markers["S/F"]["pos_z"]) == _approx_point(outline[0])
    assert (markers["S1"]["pos_x"], markers["S1"]["pos_z"]) == _approx_point(outline[10])
    assert (markers["S2"]["pos_x"], markers["S2"]["pos_z"]) == _approx_point(outline[31])

    out = capsys.readouterr().out
    assert "Loading 2024 Monaco Q session from FastF1..." in out
    assert "Circuit rotation: 30.0 degrees" in out
    assert "Calibration: scale 0.05, rotation 40.0 degrees" in out
    assert "Wrote 48 points, 3 markers and 0 pit lane points to" in out


# --- main --------------------------------------------------------------------


def test_main_builds_only_requested_track_and_creates_dirs(script, monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    fake_fastf1 = _make_fake_fastf1()
    monkeypatch.setattr(script, "fastf1", fake_fastf1)
    monkeypatch.setattr(sys, "argv", ["fetch_fastf1_tracks.py", "MONACO"])
    built = []
    monkeypatch.setattr(script, "build_one_track", lambda *args: built.append(args))

    script.main()

    assert built == [("monaco", 2024, "Monaco", "Q")]
    assert (tmp_path / "fastf1_cache").is_dir()
    assert (tmp_path / "track_data").is_dir()
    assert fake_fastf1.calls["enable_cache"] == ["fastf1_cache"]
    out = capsys.readouterr().out
    assert "=== building monaco ===" in out
    assert "Finished: all requested tracks built." in out


def test_main_builds_all_tracks_and_reports_failures(script, monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "fastf1_cache").mkdir()
    (tmp_path / "track_data").mkdir()
    (tmp_path / "track_data" / "keep.json").write_text("{}", encoding="utf-8")
    fake_fastf1 = _make_fake_fastf1()
    monkeypatch.setattr(script, "fastf1", fake_fastf1)
    monkeypatch.setattr(sys, "argv", ["fetch_fastf1_tracks.py"])
    built = []

    def fake_build(track_name, season, event, session):
        built.append(track_name)
        if track_name in ("brazil", "portugal"):
            raise ValueError("boom " + str(season))

    monkeypatch.setattr(script, "build_one_track", fake_build)

    script.main()

    assert built == [name for name, _, _ in script.TRACKS]
    assert (tmp_path / "track_data" / "keep.json").read_text(encoding="utf-8") == "{}"
    out = capsys.readouterr().out
    assert "FAILED to build brazil: boom 2024" in out
    assert "FAILED to build portugal: boom 2021" in out
    assert "Finished with failures: brazil, portugal" in out
    assert "all requested tracks built" not in out


def test_running_as_script_invokes_main(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    fake_fastf1 = _install_fakes(monkeypatch)
    monkeypatch.setattr(sys, "argv", ["fetch_fastf1_tracks.py", "not_a_track"])

    runpy.run_path(SCRIPT_PATH, run_name="__main__")

    assert fake_fastf1.calls["enable_cache"] == ["fastf1_cache"]
    assert fake_fastf1.calls["get_session"] == []
    assert (tmp_path / "fastf1_cache").is_dir()
    assert (tmp_path / "track_data").is_dir()
    assert "Finished: all requested tracks built." in capsys.readouterr().out
