import asyncio
import csv
import io
import logging
from typing import Dict, Optional
import segno
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from app.models.data_models import (
    DriverResponse,
    TrackNameResponse,
    TrackData,
)
from app.services.lap_time_store import (
    get_track,
    set_track,
)


class TrackNameInput(BaseModel):

    name: str


class LapDeleteInput(BaseModel):

    driver: str
    time: str
    recorded_at: Optional[str] = None
    track: Optional[str] = None
from app.services.track_map_loader import track_service
from app.services.saved_lap_records import (
    load_track_records,
    delete_lap_record,
    make_safe_file_name,
)
from app.api.udp_telemetry_routes import get_live_driver_data_for_api, get_local_ip

logger = logging.getLogger(__name__)

router = APIRouter()


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


@router.get("/api/qr.svg", tags=["Display"])
async def get_dashboard_qr_endpoint(request: Request):
    # Phones can't resolve "localhost", so point them at the LAN address.
    netloc = get_local_ip()
    if request.url.port:
        netloc += f":{request.url.port}"
    buffer = io.BytesIO()
    segno.make(f"{request.url.scheme}://{netloc}/").save(
        buffer, kind="svg", scale=4, border=2, xmldecl=False
    )
    return Response(content=buffer.getvalue(), media_type="image/svg+xml")


CSV_EXPORT_COLUMNS = [
    "driver",
    "team",
    "time",
    "is_valid",
    "fastest_speed_kph",
    "sector_1_ms",
    "sector_2_ms",
    "sector_3_ms",
    "recorded_at",
]


def csv_safe_cell(value):
    # Spreadsheet apps execute cells starting with these as formulas.
    text = "" if value is None else str(value)
    if text and text[0] in "=+-@\t\r":
        return "'" + text
    return text


@router.get("/api/track/records/export.csv", tags=["Track"])
async def export_track_records_endpoint(track: str = None):
    track_name = track if track else await get_track()
    if not track_name:
        raise HTTPException(status_code=404, detail="No track name set or specified")

    try:
        lap_times = await asyncio.to_thread(load_track_records, track_name)
    except (OSError, ValueError) as error:
        logger.error(f"Could not read lap times for '{track_name}': {error}")
        raise HTTPException(
            status_code=500,
            detail=f"Could not read lap records for track '{track_name}'",
        )

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(CSV_EXPORT_COLUMNS)
    for record in lap_times:
        writer.writerow([csv_safe_cell(record.get(column)) for column in CSV_EXPORT_COLUMNS])

    file_name = make_safe_file_name(track_name).removesuffix(".json") + "_laps.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{file_name}"'},
    )


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
        logger.error(f"Could not update lap records for '{track_name}': {error}")
        raise HTTPException(
            status_code=500,
            detail=f"Could not update lap records for track '{track_name}'",
        )
    if not removed:
        raise HTTPException(status_code=404, detail="No matching lap to delete")

    return {"deleted": True, "track": track_name}
