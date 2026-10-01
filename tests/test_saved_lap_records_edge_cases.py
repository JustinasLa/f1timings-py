import json
import os

from app.services import saved_lap_records as slr


def test_make_safe_file_name_falls_back_to_unknown():
    assert slr.make_safe_file_name(" ?!* ") == "unknown.json"


def test_make_safe_file_name_keeps_only_safe_characters():
    assert slr.make_safe_file_name(" Abu Dhabi-2/24 ") == "abu_dhabi-224.json"


def test_write_track_records_creates_missing_directory(tmp_path, monkeypatch):
    target_dir = tmp_path / "nested" / "track_times"
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(target_dir))

    assert slr.write_track_records("Monza", []) is True

    on_disk = json.loads((target_dir / "monza.json").read_text(encoding="utf-8"))
    assert on_disk == {"track": "Monza", "lap_times": []}


def test_write_json_atomic_ignores_failure_to_remove_temp_file(tmp_path, monkeypatch):
    target = tmp_path / "monza.json"
    removed = []

    def failing_replace(src, dst):
        raise OSError("replace failed")

    def failing_remove(path):
        removed.append(path)
        raise OSError("remove failed")

    monkeypatch.setattr(slr.os, "replace", failing_replace)
    monkeypatch.setattr(slr.os, "remove", failing_remove)

    try:
        slr.write_json_atomic(str(target), {"lap_times": []})
    except OSError as error:
        assert str(error) == "replace failed"
    else:
        raise AssertionError("expected OSError")

    assert len(removed) == 1
    assert os.path.dirname(removed[0]) == str(tmp_path)
    assert not target.exists()


def test_save_lap_record_returns_false_when_write_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    monkeypatch.setattr(slr, "write_track_records", lambda track, laps: False)

    assert slr.save_lap_record("Monza", "Max", "Red Bull", "1:20.000", True, 330) is False
    assert not (tmp_path / "monza.json").exists()
