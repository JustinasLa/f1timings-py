import logging
from typing import Dict, List, Optional
from pydantic import BaseModel, Field, field_validator, computed_field

logger = logging.getLogger(__name__)


class LapTime(BaseModel):
    time: str
    is_fastest: bool = False
    is_valid: bool = True
    fastest_speed_kph: Optional[int] = None
    sector_1_ms: Optional[int] = None
    sector_2_ms: Optional[int] = None
    sector_3_ms: Optional[int] = None
    tyre: Optional[str] = None

    @computed_field
    @property
    def time_seconds(self) -> float:
        time_str = self.time
        parsed_seconds = float("inf")
        if ":" in time_str:
            try:
                parts = time_str.split(":")
                minutes = float(parts[0])
                seconds = float(parts[1])
                parsed_seconds = minutes * 60.0 + seconds
            except (ValueError, IndexError):
                logger.warning(f"Could not parse time with colon: {time_str}")
                return float("inf")
        elif "." in time_str:
            try:
                parts = time_str.split(".")
                if len(parts) == 3:
                    minutes = float(parts[0])
                    seconds = float(parts[1])
                    millis = float(f"0.{parts[2]}")
                    parsed_seconds = minutes * 60.0 + seconds + millis
                elif len(parts) == 2:
                    sec_part = float(parts[0])
                    millis_part = float(f"0.{parts[1]}")
                    parsed_seconds = sec_part + millis_part
                else:
                    logger.warning(f"Unexpected dot format: {time_str}")
                    parsed_seconds = float(time_str)
            except (ValueError, IndexError):
                logger.warning(f"Could not parse time with dot: {time_str}")
                return float("inf")
        else:
            try:
                parsed_seconds = float(time_str)
            except ValueError:
                logger.warning(f"Could not parse plain time: {time_str}")
                return float("inf")

        if parsed_seconds < 0:
            logger.warning(f"Ignoring negative lap time: {time_str}")
            return float("inf")
        return parsed_seconds


class Driver(BaseModel):
    name: str
    team: str
    lap_times: List[LapTime] = Field(default_factory=list)

    @property
    def fastest_valid_lap(self) -> Optional["LapTime"]:
        fastest = None
        for lap in self.lap_times:
            if not lap.is_valid:
                continue
            if fastest is None or lap.time_seconds < fastest.time_seconds:
                fastest = lap
        return fastest


class LapTimeInput(BaseModel):
    name: str
    team: str
    time: str
    fastest_speed_kph: Optional[int] = None
    is_valid: bool = True
    sector_1_ms: Optional[int] = None
    sector_2_ms: Optional[int] = None
    sector_3_ms: Optional[int] = None
    tyre: Optional[str] = None
    # [lap_distance_m, elapsed_ms, speed_kph, throttle, brake] every ~25 m.
    trace: Optional[List[List[float]]] = None

    @field_validator("time")
    def validate_time_format(cls, v):
        if not any(c in v for c in ":."):
            try:
                float(v)
            except ValueError:
                raise ValueError(
                    "Time must be in a recognizable format (mm:ss.sss, mm.ss.sss, ss.sss, or seconds)"
                )
        return v


class TrackPoint(BaseModel):

    dist: float = Field(..., description="Distance along track")
    pos_x: float = Field(..., description="X coordinate")
    pos_y: float = Field(..., description="Y coordinate")
    pos_z: float = Field(..., description="Z coordinate")
    drs: int = Field(..., description="DRS zone indicator")


class TrackMarker(BaseModel):

    label: str = Field(..., description="Short label, e.g. 'S/F', 'S1', 'S2'")
    pos_x: float = Field(..., description="X coordinate in local track space")
    pos_z: float = Field(..., description="Z coordinate in local track space")


class PitLanePoint(BaseModel):

    pos_x: float = Field(..., description="X coordinate in local track space")
    pos_z: float = Field(..., description="Z coordinate in local track space")


class TrackData(BaseModel):

    name: str = Field(..., description="Track name")
    track_info: str = Field(..., description="Track metadata from file header")
    points: List[TrackPoint] = Field(..., description="Racing line points")
    markers: List[TrackMarker] = Field(
        default_factory=list, description="Start/finish and sector split markers"
    )
    pitlane: List[PitLanePoint] = Field(
        default_factory=list, description="Pit lane outline points (drawn in gray)"
    )


class DriverResponse(BaseModel):

    name: str
    team: str
    lap_times: List[LapTime] = Field(
        default_factory=list
    )
    world_x: Optional[float] = Field(None, description="World X coordinate of the car")
    world_y: Optional[float] = Field(None, description="World Y coordinate of the car")
    world_z: Optional[float] = Field(None, description="World Z coordinate of the car")
    car_index: Optional[int] = Field(None, description="Telemetry car slot index")
    source_id: Optional[str] = Field(None, description="Telemetry source identifier")
    instance_index: Optional[int] = Field(None, description="Telemetry source display index")
    telemetry_name: Optional[str] = Field(None, description="Raw telemetry driver name")
    live_sector_1_ms: Optional[int] = Field(None, description="Live sector 1 time (ms)")
    live_sector_2_ms: Optional[int] = Field(None, description="Live sector 2 time (ms)")
    live_sector_3_ms: Optional[int] = Field(None, description="Live sector 3 time (ms)")
    live_lap_invalid: Optional[bool] = Field(None, description="Is the live lap invalid")
    live_lap_active: Optional[bool] = Field(None, description="Is the car on a flying lap")


class TrackNameResponse(BaseModel):

    name: str = Field(..., description="Name of the current track")
