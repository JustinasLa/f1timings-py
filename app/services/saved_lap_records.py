"""Saves lap times to a JSON file for each track.

Each track gets its own file inside the "track_times" folder, for example
"track_times/monaco.json". A file keeps a list of every lap time set on that
track, together with the name of the driver who set it.
"""

import json
import logging
import os
import tempfile
import threading
from datetime import datetime

logger = logging.getLogger(__name__)

# The folder where all the per-track JSON files are kept.
TRACK_TIMES_DIR = "track_times"

# Guards the read-modify-write of a track's file. It is re-entrant because
# save_lap_record and delete_lap_record call load_track_records while already
# holding this lock.
_records_lock = threading.RLock()


def make_safe_file_name(track_name):
    """Turns a track name into a safe file name like "abu_dhabi.json".

    Only simple characters (letters, digits, underscore and hyphen) are kept.
    Dropping everything else means the result can never contain a slash,
    backslash or ".." and so can never point outside the track_times folder.
    """
    lowered = track_name.strip().lower()
    lowered = lowered.replace(" ", "_")

    safe_name = ""
    for character in lowered:
        is_letter = character >= "a" and character <= "z"
        is_digit = character >= "0" and character <= "9"
        if is_letter or is_digit or character == "_" or character == "-":
            safe_name = safe_name + character

    # If the name had no usable characters at all, fall back to a default so we
    # never build a file path that is just ".json".
    if not safe_name:
        safe_name = "unknown"

    return safe_name + ".json"


def get_track_file_path(track_name):
    """Builds the full path to a track's JSON file."""
    file_name = make_safe_file_name(track_name)
    return os.path.join(TRACK_TIMES_DIR, file_name)


def load_track_records(track_name):
    """Reads all saved lap times for a track.

    Returns a list of records. If the file does not exist yet, an empty list is
    returned.

    Raises OSError (other than FileNotFoundError) or ValueError when the file
    does exist but cannot be read or parsed. Callers that then write the list
    back MUST NOT treat that as "no records", or they would overwrite a file
    whose contents we simply failed to read.
    """
    file_path = get_track_file_path(track_name)

    try:
        with _records_lock, open(file_path, "r", encoding="utf-8") as json_file:
            data = json.load(json_file)
    except FileNotFoundError:
        return []

    # The file stores an object that has a "lap_times" list inside it. Guard
    # against a file whose top level is not an object (e.g. a hand-edited list
    # or a bare value), which would otherwise raise or silently misbehave.
    if isinstance(data, dict) and "lap_times" in data:
        lap_times = data["lap_times"]
        if isinstance(lap_times, list):
            return lap_times
        raise ValueError(f"track {track_name!r} file has 'lap_times' but it is not a list")
    raise ValueError(f"track {track_name!r} file has no 'lap_times' list")


def write_track_records(track_name, lap_times):
    """Writes the full list of lap times for a track back to its JSON file,
    wrapped in the simple object shape the rest of the code expects."""
    # Make sure the folder exists before we try to write a file into it.
    if not os.path.exists(TRACK_TIMES_DIR):
        os.makedirs(TRACK_TIMES_DIR)

    file_content = {
        "track": track_name,
        "lap_times": lap_times,
    }

    file_path = get_track_file_path(track_name)

    # Write to a temp file in the same directory and atomically rename it into
    # place, so a crash, full disk, or a bad value mid-dump can never leave a
    # truncated or empty file where a good one used to be.
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
        return True
    except (OSError, TypeError, ValueError) as error:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
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
):
    """Adds one lap time (and who set it) to a track's JSON file.

    Returns True when the record was written, False when it could not be
    (either the existing file could not be read, so the write was refused to
    avoid overwriting it, or the write itself failed).
    """
    # Build the new record describing this lap and who set it. The "team" says
    # which simulator the lap came from, "is_valid" remembers whether the lap
    # was a valid, legal lap, and "fastest_speed_kph" is the top speed reached
    # during the lap (or None when we don't have it). The three sector times are
    # in milliseconds (None when we never captured them).
    new_record = {
        "driver": driver_name,
        "team": team,
        "time": time,
        "is_valid": is_valid,
        "fastest_speed_kph": fastest_speed_kph,
        "sector_1_ms": sector_1_ms,
        "sector_2_ms": sector_2_ms,
        "sector_3_ms": sector_3_ms,
        "recorded_at": datetime.now().isoformat(timespec="seconds"),
    }

    # Read-modify-write under the lock so a concurrent delete (or another save)
    # cannot overwrite this change.
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
    """Removes one saved lap from a track's JSON file.

    A lap is identified by the driver who set it, its time string and its
    recorded_at timestamp. Only the FIRST record matching all three is removed,
    so deleting one lap never accidentally removes a duplicate. Returns True when
    a record was removed, False when nothing matched. Raises OSError or
    ValueError (propagated from load_track_records) when the track's existing
    records could not be read, leaving the file untouched.
    """
    with _records_lock:
        lap_times = load_track_records(track_name)

        kept_records = []
        removed = False
        for record in lap_times:
            # Match the first record with the same driver, time and timestamp.
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
            write_track_records(track_name, kept_records)
            logger.debug(
                f"Deleted lap time for '{driver_name}' on track '{track_name}'."
            )

        return removed
