import json
import logging
import os

import pytest

from app.services import saved_lap_records as slr


TRACK = "Monaco"


def _track_file(tmp_path):
    return tmp_path / slr.make_safe_file_name(TRACK)


def _other_files(tmp_path, target_name):
    return [p.name for p in tmp_path.iterdir() if p.name != target_name]


def test_write_track_records_writes_expected_json(tmp_path, monkeypatch):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))

    records = [{"driver": "Max", "time": "1:12.345"}]
    result = slr.write_track_records(TRACK, records)

    assert result is True

    file_path = _track_file(tmp_path)
    assert file_path.exists()

    with open(file_path, "r", encoding="utf-8") as f:
        on_disk = json.load(f)
    expected = json.loads(json.dumps({"track": TRACK, "lap_times": records}, indent=2))
    assert on_disk == expected

    assert _other_files(tmp_path, file_path.name) == []


def test_write_track_records_creates_file_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))

    file_path = _track_file(tmp_path)
    assert not file_path.exists()

    records = [{"driver": "Lewis", "time": "1:13.000"}]
    result = slr.write_track_records(TRACK, records)

    assert result is True
    assert file_path.exists()
    with open(file_path, "r", encoding="utf-8") as f:
        on_disk = json.load(f)
    assert on_disk == {"track": TRACK, "lap_times": records}


def test_write_track_records_non_serialisable_record_leaves_original_untouched(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))

    good_records = [{"driver": "Charles", "time": "1:11.000"}]
    assert slr.write_track_records(TRACK, good_records) is True

    file_path = _track_file(tmp_path)
    original_bytes = file_path.read_bytes()

    bad_records = [object()]
    result = slr.write_track_records(TRACK, bad_records)

    assert result is False
    assert file_path.read_bytes() == original_bytes
    assert _other_files(tmp_path, file_path.name) == []


def test_write_track_records_os_replace_failure_leaves_original_untouched(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))

    good_records = [{"driver": "Sergio", "time": "1:14.500"}]
    assert slr.write_track_records(TRACK, good_records) is True

    file_path = _track_file(tmp_path)
    original_bytes = file_path.read_bytes()

    def _boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(slr.os, "replace", _boom)

    result = slr.write_track_records(TRACK, [{"driver": "New", "time": "1:15.000"}])

    assert result is False
    assert file_path.read_bytes() == original_bytes
    assert _other_files(tmp_path, file_path.name) == []


@pytest.mark.parametrize(
    "raw",
    ["../../etc/passwd", "Monaco GP!"],
)
def test_make_safe_file_name_strips_unsafe_characters(raw):
    safe_name = slr.make_safe_file_name(raw)

    assert safe_name.endswith(".json")
    stem = safe_name[: -len(".json")]
    assert stem != ""
    assert all(c.islower() or c.isdigit() or c in "_-" for c in stem)
    assert "/" not in safe_name
    assert "\\" not in safe_name
    assert ".." not in safe_name


def test_load_track_records_missing_file_returns_empty_list(tmp_path, monkeypatch):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))

    assert slr.load_track_records(TRACK) == []


def test_load_track_records_invalid_json_raises_value_error(tmp_path, monkeypatch):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    _track_file(tmp_path).write_text("{not json", encoding="utf-8")

    with pytest.raises(ValueError):
        slr.load_track_records(TRACK)


def test_load_track_records_bare_list_raises_value_error(tmp_path, monkeypatch):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    _track_file(tmp_path).write_text("[]", encoding="utf-8")

    with pytest.raises(ValueError):
        slr.load_track_records(TRACK)


def test_load_track_records_lap_times_not_list_raises_value_error(tmp_path, monkeypatch):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    _track_file(tmp_path).write_text(
        json.dumps({"lap_times": "nope"}), encoding="utf-8"
    )

    with pytest.raises(ValueError):
        slr.load_track_records(TRACK)


def test_load_track_records_returns_lap_times_list(tmp_path, monkeypatch):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    record = {"driver": "a"}
    _track_file(tmp_path).write_text(
        json.dumps({"lap_times": [record]}), encoding="utf-8"
    )

    assert slr.load_track_records(TRACK) == [record]


def test_save_lap_record_corrupt_file_leaves_file_untouched_and_logs_error(
    tmp_path, monkeypatch, caplog
):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    file_path = _track_file(tmp_path)
    file_path.write_text("{not json", encoding="utf-8")
    original_bytes = file_path.read_bytes()

    with caplog.at_level(logging.ERROR, logger=slr.logger.name):
        slr.save_lap_record(TRACK, "Max", "Red Bull", "1:12.000", True, 300.0)

    assert file_path.read_bytes() == original_bytes
    assert _other_files(tmp_path, file_path.name) == []
    assert any(
        record.levelno == logging.ERROR and "monaco" in record.message.lower()
        for record in caplog.records
    )


def test_delete_lap_record_corrupt_file_returns_false_and_leaves_file_untouched(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    file_path = _track_file(tmp_path)
    file_path.write_text("{not json", encoding="utf-8")
    original_bytes = file_path.read_bytes()

    result = slr.delete_lap_record(TRACK, "Max", "1:12.000", "2024-01-01T00:00:00")

    assert result is False
    assert file_path.read_bytes() == original_bytes
    assert _other_files(tmp_path, file_path.name) == []


def test_save_lap_record_creates_file_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    file_path = _track_file(tmp_path)
    assert not file_path.exists()

    slr.save_lap_record(TRACK, "Lando", "McLaren", "1:11.500", True, 310.0)

    records = slr.load_track_records(TRACK)
    assert len(records) == 1
    assert records[0]["driver"] == "Lando"


def test_load_track_records_propagates_os_error_other_than_missing(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    slr.write_track_records(TRACK, [{"driver": "a"}])

    def _fake_open(*args, **kwargs):
        raise PermissionError("denied")

    monkeypatch.setattr(slr, "open", _fake_open, raising=False)

    with pytest.raises(PermissionError):
        slr.load_track_records(TRACK)


def test_save_lap_record_does_not_write_when_load_raises_os_error(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(slr, "TRACK_TIMES_DIR", str(tmp_path))
    slr.write_track_records(TRACK, [{"driver": "a"}])
    file_path = _track_file(tmp_path)
    original_bytes = file_path.read_bytes()

    def _fake_open(*args, **kwargs):
        raise PermissionError("denied")

    monkeypatch.setattr(slr, "open", _fake_open, raising=False)

    slr.save_lap_record(TRACK, "Max", "Red Bull", "1:12.000", True, 300.0)

    assert file_path.read_bytes() == original_bytes
