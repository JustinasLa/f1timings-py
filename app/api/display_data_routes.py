import logging
from typing import Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models.data_models import (
    DriverResponse,
    TrackNameResponse,
    TrackData,
    driver_to_response,  # Re-enabled for converting manual lap times
)
from app.services.lap_time_store import (
    get_track,
    set_track,
    app_data,
    state_lock,
)


class TrackNameInput(BaseModel):
    """Body for setting the current track name."""

    name: str


class LapDeleteInput(BaseModel):
    """Body for deleting one saved lap. The lap is identified by who set it, its
    time string and its recorded_at timestamp. track is optional; the current
    track is used when it is not given."""

    driver: str
    time: str
    recorded_at: Optional[str] = None
    track: Optional[str] = None
from app.services.track_map_loader import track_service
from app.services.saved_lap_records import load_track_records, delete_lap_record
from app.api.udp_telemetry_routes import get_live_driver_data_for_api

# Configure logging
logger = logging.getLogger(__name__)

# Create router
router = APIRouter()


@router.get("/api/drivers", response_model=Dict[str, DriverResponse], tags=["Drivers"])
async def get_drivers_endpoint():
    """Gets all current drivers and their live telemetry data (name, team, last lap time)."""
    # FUTURE: Fetch live driver data compiled from telemetry stores (for fastest lap times from game)
    # drivers_response = await get_live_driver_data_for_api()
    # return drivers_response

    # For now, return manually added times from the API/store.
    async with state_lock:
        drivers_copy = {
            name: driver.model_copy(deep=True)
            for name, driver in app_data.drivers.items()
        }

    # Convert internal driver objects to API response format
    drivers_response = {
        name: driver_to_response(driver) for name, driver in drivers_copy.items()
    }

    return drivers_response


@router.get(
    "/api/drivers/live", response_model=Dict[str, DriverResponse], tags=["Drivers"]
)
async def get_live_drivers_endpoint():
    """Gets live telemetry data from the game (positions, teams, etc.) for track visualization."""
    # Fetch live driver data compiled from telemetry stores
    drivers_response = await get_live_driver_data_for_api()
    return drivers_response


@router.get("/api/track", response_model=TrackNameResponse, tags=["Track"])
async def get_track_name_endpoint():
    """Gets the currently set track name with case matching to available tracks."""
    stored_track_name = await get_track()

    if not stored_track_name:
        return TrackNameResponse(name="")

    # Try to find a matching track name from available tracks
    matched_track_name = track_service.find_matching_track_name(stored_track_name)

    if matched_track_name:
        return TrackNameResponse(name=matched_track_name)
    else:
        # Return the original name if no match found
        logger.warning(f"No matching track found for stored name '{stored_track_name}'")
        return TrackNameResponse(name=stored_track_name)


@router.post("/api/track", response_model=TrackNameResponse, tags=["Track"])
async def set_track_name_endpoint(track_input: TrackNameInput):
    """Sets the current track name.

    This is what tells the backend which track newly auto-saved laps belong to,
    so they are written to the right file in track_times/. The dashboard calls
    this when the user picks a track from the dropdown.
    """
    matched_track_name = track_service.find_matching_track_name(track_input.name)
    if matched_track_name:
        track_to_store = matched_track_name
    else:
        track_to_store = track_input.name

    stored_track_name = await set_track(track_to_store)
    return TrackNameResponse(name=stored_track_name or "")


@router.get("/api/track/data", response_model=TrackData, tags=["Track"])
async def get_track_data_endpoint(track: str = None):
    """Gets the track data for the specified track or currently set track."""
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
    """Gets list of available tracks."""
    return track_service.get_available_tracks()


@router.get("/api/track/records", tags=["Track"])
async def get_track_records_endpoint(track: str = None):
    """Gets all saved lap times for a track from its JSON file.

    Pass ?track=<name> to choose a track, otherwise the current track is used.
    These records survive restarts and track changes.
    """
    track_name = track if track else await get_track()
    if not track_name:
        raise HTTPException(status_code=404, detail="No track name set or specified")

    lap_times = load_track_records(track_name)
    return {"track": track_name, "lap_times": lap_times}


@router.post("/api/track/records/delete", tags=["Track"])
async def delete_track_record_endpoint(delete_input: LapDeleteInput):
    """Deletes one saved lap from a track's JSON file.

    The lap is matched by driver + time + recorded_at, so only the exact lap the
    user clicked is removed. Used by the X button next to each lap in the
    leaderboard's expanded recent-laps view.
    """
    track_name = delete_input.track if delete_input.track else await get_track()
    if not track_name:
        raise HTTPException(status_code=404, detail="No track name set or specified")

    removed = delete_lap_record(
        track_name,
        delete_input.driver,
        delete_input.time,
        delete_input.recorded_at,
    )
    if not removed:
        raise HTTPException(status_code=404, detail="No matching lap to delete")

    return {"deleted": True, "track": track_name}
