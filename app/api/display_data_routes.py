import asyncio
import logging
from typing import Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models.data_models import (
    DriverResponse,
    TrackNameResponse,
    TrackData,
    driver_to_response,
)
from app.services.lap_time_store import (
    get_track,
    set_track,
    app_data,
    state_lock,
)


class TrackNameInput(BaseModel):

    name: str


class LapDeleteInput(BaseModel):

    driver: str
    time: str
    recorded_at: Optional[str] = None
    track: Optional[str] = None
from app.services.track_map_loader import track_service
from app.services.saved_lap_records import load_track_records, delete_lap_record
from app.api.udp_telemetry_routes import get_live_driver_data_for_api

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/drivers", response_model=Dict[str, DriverResponse], tags=["Drivers"])
async def get_drivers_endpoint():

    async with state_lock:
        drivers_copy = {
            name: driver.model_copy(deep=True)
            for name, driver in app_data.drivers.items()
        }

    drivers_response = {
        name: driver_to_response(driver) for name, driver in drivers_copy.items()
    }

    return drivers_response


@router.get(
    "/api/drivers/live", response_model=Dict[str, DriverResponse], tags=["Drivers"]
)
async def get_live_drivers_endpoint():
    drivers_response = await get_live_driver_data_for_api()
    return drivers_response


@router.get("/api/track", response_model=TrackNameResponse, tags=["Track"])
async def get_track_name_endpoint():
    stored_track_name = await get_track()

    if not stored_track_name:
        return TrackNameResponse(name="")

    matched_track_name = track_service.find_matching_track_name(stored_track_name)

    if matched_track_name:
        return TrackNameResponse(name=matched_track_name)
    else:
        logger.warning(f"No matching track found for stored name '{stored_track_name}'")
        return TrackNameResponse(name=stored_track_name)


@router.post("/api/track", response_model=TrackNameResponse, tags=["Track"])
async def set_track_name_endpoint(track_input: TrackNameInput):
    matched_track_name = track_service.find_matching_track_name(track_input.name)
    if matched_track_name:
        track_to_store = matched_track_name
    else:
        track_to_store = track_input.name

    stored_track_name = await set_track(track_to_store)
    return TrackNameResponse(name=stored_track_name or "")


@router.get("/api/track/data", response_model=TrackData, tags=["Track"])
async def get_track_data_endpoint(track: str = None):
    track_name = track if track else await get_track()
    if not track_name:
        raise HTTPException(status_code=404, detail="No track name set or specified")

    track_data = await track_service.load_track_data(track_name)
    if not track_data:
        raise HTTPException(
            status_code=404, detail=f"Track data not found for '{track_name}'"
        )

    return track_data


@router.get("/api/tracks", response_model=List[str], tags=["Track"])
async def get_available_tracks_endpoint():
    return track_service.get_available_tracks()


@router.get("/api/track/records", tags=["Track"])
async def get_track_records_endpoint(track: str = None):
    track_name = track if track else await get_track()
    if not track_name:
        raise HTTPException(status_code=404, detail="No track name set or specified")

    try:
        lap_times = await asyncio.to_thread(load_track_records, track_name)
    except (OSError, ValueError) as error:
        logger.warning(f"Could not read lap times for '{track_name}': {error}")
        lap_times = []

    return {"track": track_name, "lap_times": lap_times}


@router.post("/api/track/records/delete", tags=["Track"])
async def delete_track_record_endpoint(delete_input: LapDeleteInput):
    track_name = delete_input.track if delete_input.track else await get_track()
    if not track_name:
        raise HTTPException(status_code=404, detail="No track name set or specified")

    try:
        removed = await asyncio.to_thread(
            delete_lap_record,
            track_name,
            delete_input.driver,
            delete_input.time,
            delete_input.recorded_at,
        )
    except (OSError, ValueError) as error:
        logger.error(f"Could not read lap records for '{track_name}': {error}")
        raise HTTPException(
            status_code=500,
            detail=f"Could not read lap records for track '{track_name}'",
        )
    if not removed:
        raise HTTPException(status_code=404, detail="No matching lap to delete")

    return {"deleted": True, "track": track_name}
