import asyncio
import logging
import os
from typing import Dict, Optional
from dotenv import load_dotenv
from app.models.data_models import (
    LapTimeInput,
    Driver,
    LapTime,
)
from app.utils.lap_time_helpers import update_overall_fastest_lap
from app.services.saved_lap_records import save_lap_record

# Load environment variables
load_dotenv()

# Configure logging based on DEBUG environment variable
debug_mode = os.getenv("DEBUG", "false").lower() in ("true", "1", "yes", "on")
log_level = logging.DEBUG if debug_mode else logging.INFO

logger = logging.getLogger(__name__)
logger.setLevel(log_level)


# --- Application State ---
class AppData:
    """Holds the application's in-memory state."""

    def __init__(self):
        self.drivers: Dict[str, Driver] = {}
        self.track_name: Optional[str] = None


app_data = AppData()
state_lock = asyncio.Lock()

# WebSocket connection manager will be imported and used for broadcasting
# This is a forward reference which will be populated at runtime
websocket_manager = None


def set_websocket_manager(manager):
    """Set the WebSocket manager to be used for broadcasting.
    This function is called from main.py during startup."""
    global websocket_manager
    websocket_manager = manager
    print(f"WebSocket manager set: {manager}")


async def add_or_update_lap_time(lap_input: LapTimeInput) -> Dict[str, Driver]:
    """Adds or updates a lap time for a driver."""
    global websocket_manager

    broadcast_message = None
    async with state_lock:
        driver_name = lap_input.name
        try:
            new_lap = LapTime(
                time=lap_input.time,
                is_fastest=False,
                is_valid=lap_input.is_valid,
                fastest_speed_kph=lap_input.fastest_speed_kph,
                sector_1_ms=lap_input.sector_1_ms,
                sector_2_ms=lap_input.sector_2_ms,
                sector_3_ms=lap_input.sector_3_ms,
            )
        except ValueError as e:
            logger.error(
                f"Invalid time format provided for {driver_name}: {lap_input.time} - {e}"
            )
            raise ValueError(f"Invalid time format: {lap_input.time}")

        is_new_driver = driver_name not in app_data.drivers
        is_faster_lap = False

        if is_new_driver:
            app_data.drivers[driver_name] = Driver(
                name=driver_name, team=lap_input.team, lap_times=[new_lap]
            )
            # A driver's first lap is their best only when it is a valid lap.
            is_faster_lap = new_lap.is_valid
            logger.debug(f"Created new driver '{driver_name}' with lap time {new_lap.time}.")
        else:
            driver = app_data.drivers[driver_name]

            if driver.team != lap_input.team:
                driver.team = lap_input.team

            # Compare against the driver's fastest VALID lap so far. An invalid
            # lap is never counted as a personal best.
            prev_best = driver.fastest_valid_lap
            driver.lap_times.append(new_lap)
            if new_lap.is_valid and (
                prev_best is None or new_lap.time_seconds < prev_best.time_seconds
            ):
                is_faster_lap = True
                logger.debug(f"New best lap for '{driver_name}': {new_lap.time}.")
            else:
                logger.debug(f"Lap {new_lap.time} for '{driver_name}' appended (not fastest).")

        update_overall_fastest_lap(app_data.drivers)

        broadcast_message = {
            "type": "laptime_update",
            "action": "add" if is_new_driver else "update",
            "data": {
                "name": driver_name,
                "team": lap_input.team,
                "time": new_lap.time,
                "time_seconds": new_lap.time_seconds,
                "is_faster": is_faster_lap,
                "is_overall_fastest": new_lap.is_fastest,
                "is_valid": new_lap.is_valid,
                # The lap's three sector times (ms) so the notification toast can
                # show them. None for any sector we never captured.
                "sector_1_ms": new_lap.sector_1_ms,
                "sector_2_ms": new_lap.sector_2_ms,
                "sector_3_ms": new_lap.sector_3_ms,
            },
        }

        drivers_copy = {
            name: driver.model_copy(deep=True)
            for name, driver in app_data.drivers.items()
        }

        # Remember the current track so we can save this lap to its file below.
        current_track_name = app_data.track_name

    # Save this lap time (and who set it) to the track's JSON file.
    # We do this after releasing the lock so the file write does not block
    # other readers. We only save when a track has been set.
    if current_track_name:
        save_lap_record(
            current_track_name,
            driver_name,
            lap_input.team,
            new_lap.time,
            new_lap.is_valid,
            new_lap.fastest_speed_kph,
            new_lap.sector_1_ms,
            new_lap.sector_2_ms,
            new_lap.sector_3_ms,
        )

    if websocket_manager and broadcast_message:
        await websocket_manager.broadcast(broadcast_message)

    return drivers_copy

async def get_fastest_lap_sectors_by_name() -> Dict[str, tuple]:
    """Return each driver's fastest-valid-lap sector times, keyed by driver name.

    Each value is a (sector_1_ms, sector_2_ms, sector_3_ms) tuple; any sector we
    never recorded comes back as 0. Drivers with no valid lap are left out.

    The live track map uses this to fall back to a driver's best-lap sectors when
    they are not currently on a flying lap.
    """
    sectors_by_name: Dict[str, tuple] = {}
    async with state_lock:
        for driver_name in app_data.drivers:
            driver = app_data.drivers[driver_name]
            fastest_lap = driver.fastest_valid_lap
            if fastest_lap is None:
                continue
            sector_1 = fastest_lap.sector_1_ms or 0
            sector_2 = fastest_lap.sector_2_ms or 0
            sector_3 = fastest_lap.sector_3_ms or 0
            sectors_by_name[driver_name] = (sector_1, sector_2, sector_3)
    return sectors_by_name


async def get_track() -> Optional[str]:
    """Gets the current track name."""
    async with state_lock:
        return app_data.track_name


async def set_track(track_name: Optional[str]) -> Optional[str]:
    """Sets the current track name and tells every dashboard about the change.

    The track name is what decides which file in track_times/ newly auto-saved
    laps are written to (see add_or_update_lap_time), so this must be set for
    laps to be persisted. Passing an empty value clears the current track.
    """
    global websocket_manager

    if track_name:
        cleaned_track_name = track_name.strip()
    else:
        cleaned_track_name = None

    async with state_lock:
        app_data.track_name = cleaned_track_name

    # Let any connected dashboards switch to the new track. The frontend already
    # listens for this "track_update" message.
    if websocket_manager and cleaned_track_name:
        broadcast_message = {
            "type": "track_update",
            "data": {"name": cleaned_track_name},
        }
        await websocket_manager.broadcast(broadcast_message)

    return cleaned_track_name
