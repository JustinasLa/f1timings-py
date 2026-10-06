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

load_dotenv()

debug_mode = os.getenv("DEBUG", "false").lower() in ("true", "1", "yes", "on")
log_level = logging.DEBUG if debug_mode else logging.INFO

logger = logging.getLogger(__name__)
logger.setLevel(log_level)


class AppData:

    def __init__(self):
        self.drivers: Dict[str, Driver] = {}
        self.track_name: Optional[str] = None


app_data = AppData()
state_lock = asyncio.Lock()

websocket_manager = None


def set_websocket_manager(manager):
    global websocket_manager
    websocket_manager = manager
    print(f"WebSocket manager set: {manager}")


async def add_or_update_lap_time(
    lap_input: LapTimeInput, track_name: Optional[str] = None
) -> Dict[str, Driver]:
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
                tyre=lap_input.tyre,
                assists=lap_input.assists,
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
            is_faster_lap = new_lap.is_valid
            logger.debug(f"Created new driver '{driver_name}' with lap time {new_lap.time}.")
        else:
            driver = app_data.drivers[driver_name]

            if driver.team != lap_input.team:
                driver.team = lap_input.team

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

        current_track_name = track_name or app_data.track_name

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
                "sector_1_ms": new_lap.sector_1_ms,
                "sector_2_ms": new_lap.sector_2_ms,
                "sector_3_ms": new_lap.sector_3_ms,
                "track": current_track_name,
            },
        }

        drivers_copy = {
            name: driver.model_copy(deep=True)
            for name, driver in app_data.drivers.items()
        }

    if current_track_name:
        await asyncio.to_thread(
            save_lap_record,
            current_track_name,
            driver_name,
            lap_input.team,
            new_lap.time,
            new_lap.is_valid,
            new_lap.fastest_speed_kph,
            new_lap.sector_1_ms,
            new_lap.sector_2_ms,
            new_lap.sector_3_ms,
            new_lap.tyre,
            new_lap.assists,
        )
    else:
        logger.warning(
            "Lap %s for '%s' kept in memory only: no track set, nothing saved to disk",
            new_lap.time,
            driver_name,
        )

    if websocket_manager and broadcast_message:
        await websocket_manager.broadcast(broadcast_message)

    return drivers_copy

async def get_fastest_lap_sectors_by_name() -> Dict[str, tuple]:
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
    async with state_lock:
        return app_data.track_name


async def set_track(track_name: Optional[str]) -> Optional[str]:
    global websocket_manager

    if track_name:
        cleaned_track_name = track_name.strip()
    else:
        cleaned_track_name = None

    async with state_lock:
        app_data.track_name = cleaned_track_name

    if websocket_manager and cleaned_track_name:
        broadcast_message = {
            "type": "track_update",
            "data": {"name": cleaned_track_name},
        }
        await websocket_manager.broadcast(broadcast_message)

    return cleaned_track_name
