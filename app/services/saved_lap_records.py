import json
import logging
import os
import tempfile
import threading
from datetime import datetime

logger = logging.getLogger(__name__)

TRACK_TIMES_DIR = "track_times"

_records_lock = threading.RLock()


def make_safe_file_name(track_name):
    lowered = track_name.strip().lower()
    lowered = lowered.replace(" ", "_")

    safe_name = ""
    for character in lowered:
        is_letter = character >= "a" and character <= "z"
        is_digit = character >= "0" and character <= "9"
        if is_letter or is_digit or character == "_" or character == "-":
            safe_name = safe_name + character

    if not safe_name:
        safe_name = "unknown"

    return safe_name + ".json"


def get_track_file_path(track_name):
    file_name = make_safe_file_name(track_name)
    return os.path.join(TRACK_TIMES_DIR, file_name)


def load_track_records(track_name):
    file_path = get_track_file_path(track_name)

    try:
        with _records_lock, open(file_path, "r", encoding="utf-8") as json_file:
            data = json.load(json_file)
    except FileNotFoundError:
        return []

    if isinstance(data, dict) and "lap_times" in data:
        lap_times = data["lap_times"]
        if isinstance(lap_times, list):
            return lap_times
        raise ValueError(f"track {track_name!r} file has 'lap_times' but it is not a list")
    raise ValueError(f"track {track_name!r} file has no 'lap_times' list")


def write_json_atomic(file_path, file_content):
    tmp_path = None
    try:
        json_text = json.dumps(file_content, indent=2)

        tmp_file = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=os.path.dirname(file_path) or ".",
            delete=False,
        )
        tmp_path = tmp_file.name
        try:
            tmp_file.write(json_text)
            tmp_file.flush()
            os.fsync(tmp_file.fileno())
        finally:
            tmp_file.close()

        os.chmod(tmp_path, 0o644)

        os.replace(tmp_path, file_path)
    except (OSError, TypeError, ValueError):
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        raise


def write_track_records(track_name, lap_times):
    if not os.path.exists(TRACK_TIMES_DIR):
        os.makedirs(TRACK_TIMES_DIR)

    file_content = {
        "track": track_name,
        "lap_times": lap_times,
    }

    file_path = get_track_file_path(track_name)

    try:
        write_json_atomic(file_path, file_content)
        return True
    except (OSError, TypeError, ValueError) as error:
        logger.warning(f"Could not write lap times for '{track_name}': {error}")
        return False


def save_lap_record(
    track_name,
    driver_name,
    team,
    time,
    is_valid,
    fastest_speed_kph,
    sector_1_ms=None,
    sector_2_ms=None,
    sector_3_ms=None,
    tyre=None,
    assists=None,
):
    new_record = {
        "driver": driver_name,
        "team": team,
        "time": time,
        "is_valid": is_valid,
        "fastest_speed_kph": fastest_speed_kph,
        "sector_1_ms": sector_1_ms,
        "sector_2_ms": sector_2_ms,
        "sector_3_ms": sector_3_ms,
        "tyre": tyre,
        "assists": assists,
        "recorded_at": datetime.now().isoformat(timespec="seconds"),
    }

    with _records_lock:
        try:
            lap_times = load_track_records(track_name)
        except (OSError, ValueError) as error:
            logger.error(
                f"Not saving lap for '{driver_name}': could not read existing lap "
                f"times for track '{track_name}', refusing to overwrite them: {error}"
            )
            return False

        lap_times.append(new_record)
        written = write_track_records(track_name, lap_times)
        if written:
            logger.debug(
                f"Saved lap time for '{driver_name}' on track '{track_name}'."
            )
        return written


def delete_lap_record(track_name, driver_name, time, recorded_at):
    with _records_lock:
        lap_times = load_track_records(track_name)

        kept_records = []
        removed = False
        for record in lap_times:
            matches = (
                not removed
                and record.get("driver") == driver_name
                and record.get("time") == time
                and record.get("recorded_at") == recorded_at
            )
            if matches:
                removed = True
                continue
            kept_records.append(record)

        if removed:
            if not write_track_records(track_name, kept_records):
                raise OSError(f"could not write lap records for track {track_name!r}")
            logger.debug(
                f"Deleted lap time for '{driver_name}' on track '{track_name}'."
            )

        return removed
