import logging
from typing import Dict, List, Optional
from pydantic import BaseModel, Field, field_validator, computed_field

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Internal Data Structures ---


class LapTime(BaseModel):
    time: str  # Store as original string e.g., "1:23.456" or "83.456"
    is_fastest: bool = False
    is_valid: bool = True
    # Top speed in km/h, stored as a full number (the game reports it that way).
    fastest_speed_kph: Optional[int] = None
    # The lap's three sector times in milliseconds (0/None when unknown). S3 is
    # derived from the lap time minus S1 and S2 when the lap is saved.
    sector_1_ms: Optional[int] = None
    sector_2_ms: Optional[int] = None
    sector_3_ms: Optional[int] = None

    # Use computed_field for calculations without storing extra state
    @computed_field
    @property
    def time_seconds(self) -> float:
        """Calculates lap time in seconds for comparison."""
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
                if len(parts) == 3:  # mm.ss.sss format (common in games)
                    minutes = float(parts[0])
                    seconds = float(parts[1])
                    millis = float(f"0.{parts[2]}")
                    parsed_seconds = minutes * 60.0 + seconds + millis
                elif len(parts) == 2:  # ss.sss format
                    # Handle potential whole second part correctly
                    sec_part = float(parts[0])
                    millis_part = float(f"0.{parts[1]}")
                    parsed_seconds = sec_part + millis_part
                else:  # Unexpected format with dots
                    logger.warning(f"Unexpected dot format: {time_str}")
                    parsed_seconds = float(time_str)  # Attempt direct parse
            except (ValueError, IndexError):
                logger.warning(f"Could not parse time with dot: {time_str}")
                return float("inf")
        else:  # Assume plain seconds
            try:
                parsed_seconds = float(time_str)
            except ValueError:
                logger.warning(f"Could not parse plain time: {time_str}")
                return float("inf")

        # A negative lap time is never valid; treat it as unparseable so it can
        # never win the "fastest lap" comparison.
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
        """The driver's fastest VALID lap, or None if they have no valid lap.

        Invalid laps are skipped so a deleted/illegal lap can never count as a
        personal best (this matches how update_overall_fastest_lap picks the
        overall fastest).
        """
        fastest = None
        for lap in self.lap_times:
            if not lap.is_valid:
                continue
            if fastest is None or lap.time_seconds < fastest.time_seconds:
                fastest = lap
        return fastest


# --- API Input Models ---


class LapTimeInput(BaseModel):
    name: str  # Matches frontend 'name'
    team: str  # "RedBull" or "McLaren"
    time: str  # e.g., "1:23.456" or "83.456" or "1.23.456"
    # Top speed in km/h, stored as a full number (the game reports it that way).
    fastest_speed_kph: Optional[int] = None
    is_valid: bool = True
    # The lap's three sector times in milliseconds (None when unknown).
    sector_1_ms: Optional[int] = None
    sector_2_ms: Optional[int] = None
    sector_3_ms: Optional[int] = None

    @field_validator("time")
    def validate_time_format(cls, v):
        # Basic validation - more strict parsing happens in LapTime model
        if not any(c in v for c in ":."):
            try:
                float(v)  # Check if it's convertible to float if no separators
            except ValueError:
                raise ValueError(
                    "Time must be in a recognizable format (mm:ss.sss, mm.ss.sss, ss.sss, or seconds)"
                )
        # Allow formats with separators
        return v


# --- API Response Models ---


class TrackPoint(BaseModel):
    """Represents a single point on the racing line."""

    dist: float = Field(..., description="Distance along track")
    pos_x: float = Field(..., description="X coordinate")
    pos_y: float = Field(..., description="Y coordinate")
    pos_z: float = Field(..., description="Z coordinate")
    drs: int = Field(..., description="DRS zone indicator")


class TrackMarker(BaseModel):
    """A point on the track to mark, such as the start/finish or a sector split."""

    label: str = Field(..., description="Short label, e.g. 'S/F', 'S1', 'S2'")
    pos_x: float = Field(..., description="X coordinate in local track space")
    pos_z: float = Field(..., description="Z coordinate in local track space")


class PitLanePoint(BaseModel):
    """A point along the pit lane, in local track space."""

    pos_x: float = Field(..., description="X coordinate in local track space")
    pos_z: float = Field(..., description="Z coordinate in local track space")


class TrackData(BaseModel):
    """Represents complete track data including metadata and points."""

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
    """
    Defines the structure returned by /api/drivers.
    Matches the Rust version where lap_times was a Vec, even though
    we only store the fastest lap internally now. We reconstruct this
    structure for API consistency.
    """

    name: str
    team: str
    lap_times: List[LapTime] = Field(
        default_factory=list
    )  # List for frontend compatibility
    world_x: Optional[float] = Field(None, description="World X coordinate of the car")
    world_y: Optional[float] = Field(None, description="World Y coordinate of the car")
    world_z: Optional[float] = Field(None, description="World Z coordinate of the car")
    car_index: Optional[int] = Field(None, description="Telemetry car slot index")
    source_id: Optional[str] = Field(None, description="Telemetry source identifier")
    instance_index: Optional[int] = Field(None, description="Telemetry source display index")
    telemetry_name: Optional[str] = Field(None, description="Raw telemetry driver name")
    # Live sector times in milliseconds for the track map. While the car is on a
    # flying lap, S1 and S2 fill in as it crosses each split and S3 stays blank
    # until the lap finishes. When the car is idle (not lapping), these instead
    # hold the driver's fastest-lap sectors as a reference. 0 means that sector
    # has not been set yet.
    live_sector_1_ms: Optional[int] = Field(None, description="Live sector 1 time (ms)")
    live_sector_2_ms: Optional[int] = Field(None, description="Live sector 2 time (ms)")
    live_sector_3_ms: Optional[int] = Field(None, description="Live sector 3 time (ms)")
    # Whether the lap currently in progress has been marked invalid by the game,
    # so the map/leaderboard can colour the live sectors red.
    live_lap_invalid: Optional[bool] = Field(None, description="Is the live lap invalid")
    # True while the car is actively on a flying lap (it crossed a sector split
    # recently). When True the live sectors above are the lap in progress; when
    # False they are the driver's fastest-lap sectors shown as a reference. The
    # leaderboard uses this to know when to switch a row to the live pace.
    live_lap_active: Optional[bool] = Field(None, description="Is the car on a flying lap")


class TrackNameResponse(BaseModel):
    """Response model for track name API endpoint."""

    name: str = Field(..., description="Name of the current track")


# Helper to convert internal Driver state to API response format
def driver_to_response(driver: Driver) -> DriverResponse:
    return DriverResponse(
        name=driver.name,
        team=driver.team,
        lap_times=list(driver.lap_times),
    )
