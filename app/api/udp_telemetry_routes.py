import asyncio
import ctypes
import os
import socket
import threading
import time
import logging
import traceback
import unicodedata
from typing import Optional, Dict, Any, List
from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from app.models.data_models import DriverResponse, LapTime

# Load environment variables
load_dotenv()

# Get logger - logging is configured in main.py
logger = logging.getLogger(__name__)

# How long (in seconds) a car may go without crossing a sector split (S/F line,
# S1 or S2) before we stop treating it as "on a flying lap". While it is on a
# lap the track map shows only the lap in progress; once it goes idle for longer
# than this we fall back to showing the driver's fastest-lap sectors instead.
SECTOR_PACE_IDLE_SECONDS = 45


class DriverAliasInput(BaseModel):
    telemetry_name: str
    display_name: str


# Load environment variables from .env file
telemetry_router = APIRouter()  # Moved here

# --- Team ID to Name Mapping ---
# Based on common F1 2024 team IDs. This might need adjustment.
TEAM_ID_MAP = {
    0: "Mercedes-AMG Petronas F1 Team",
    1: "Scuderia Ferrari",
    2: "Oracle Red Bull Racing",
    3: "Williams Racing",
    4: "Aston Martin Aramco F1 Team",
    5: "BWT Alpine F1 Team",
    6: "Visa Cash App RB F1 Team",  # Formerly Scuderia AlphaTauri
    7: "MoneyGram Haas F1 Team",
    8: "McLaren F1 Team",
    9: "Stake F1 Team Kick Sauber",  # Formerly Alfa Romeo Racing
    # Placeholder for unknown or player teams if not in this list
    # Values like 41 for 'Haas F1 Team ES' (presumably esports) or 85 for 'Mercedes AMG Esports' also exist in some contexts.
    # For simplicity, focusing on the main constructor teams.
    255: "Unknown Team",  # Often used for no team or invalid
}


# --- Session Type Constants (F1 24) ---
SESSION_TYPE_MAP = {
    0: "Unknown",
    1: "Practice 1",
    2: "Practice 2",
    3: "Practice 3",
    4: "Short Practice",
    5: "Qualifying 1",
    6: "Qualifying 2",
    7: "Qualifying 3",
    8: "Short Qualifying",
    9: "One Shot Qualifying",
    10: "Race",
    11: "Race 2",
    12: "Race 3",
    13: "Time Trial",
}


# --- Track ID to track-name mapping (F1 24) ---
# Maps the trackId the game sends in the SessionData packet to the track key we
# use everywhere else (the track_data/geojson/track_times file name, and the
# dashboard's TRACK_DICTIONARY key). Used to auto-detect the track from
# telemetry so laps save to the right file and the dashboard follows along.
# Tracks the project has no files for (France, Germany, Russia, Vietnam) are
# left out on purpose; their packets simply will not auto-switch the track.
# The "short" layout IDs point at the same track as their full-length version.
TRACK_ID_TO_NAME = {
    0: "australia",       # Melbourne
    2: "china",           # Shanghai
    3: "bahrain",         # Sakhir
    4: "spain",           # Catalunya
    5: "monaco",
    6: "canada",          # Montreal
    7: "great_britain",   # Silverstone
    9: "hungary",         # Hungaroring
    10: "belgium",        # Spa-Francorchamps
    11: "monza",
    12: "singapore",      # Marina Bay
    13: "japan",          # Suzuka
    14: "abu_dhabi",      # Yas Marina
    15: "texas",          # Circuit of the Americas
    16: "brazil",         # Interlagos
    17: "austria",        # Red Bull Ring
    19: "mexico",
    20: "azerbaijan",     # Baku
    21: "bahrain",        # Sakhir (short)
    22: "great_britain",  # Silverstone (short)
    23: "texas",          # COTA (short)
    24: "japan",          # Suzuka (short)
    26: "netherlands",    # Zandvoort
    27: "imola",
    28: "portugal",       # Portimao
    29: "saudi_arabia",   # Jeddah
    30: "miami",
    31: "las_vegas",
    32: "qatar",          # Losail
}

# Remembers the last track_id we auto-applied, so a SessionData packet only
# triggers a track switch when the track actually changes (these packets arrive
# many times per second). Reset whenever the listener is (re)started.
_last_auto_set_track_id = None


# --- Packet Filtering Configuration ---
# Essential packets for performance optimization
ESSENTIAL_PACKET_IDS = {
    0,  # MotionData - car positions
    1,  # SessionData - session info and track
    2,  # LapData - lap times
    4,  # ParticipantsData - driver names and teams
    6,  # CarTelemetryData - per-car speed for lap top-speed tracking
    7,  # CarStatusData - car status information
}

# Optional packets that can be enabled for detailed telemetry
OPTIONAL_PACKET_IDS = {
    3,  # EventData - session events
    5,  # CarSetupData - car setup information
    6,  # CarTelemetryData - detailed car telemetry
    8,  # CarDamageData - car damage information
    9,  # SessionHistoryData - session history
    10,  # TyreSetData - tyre set information
    11,  # MotionExData - extended motion data
    12,  # CarStatusDataEx - extended car status
    13,  # FinalClassificationData - final classification
    14,  # LobbyInfoData - lobby information
}

# Performance filtering - set to True to only process essential packets
ENABLE_PACKET_FILTERING = True

# Debug capture for the /api/telemetry/raw endpoint. When this is on, the listener
# keeps a full copy of the latest packet of every type so /raw can show it. It is
# OFF by default because converting every packet to a dict on every frame costs
# CPU on the listener thread. Toggle it at runtime via
# POST /api/telemetry/raw/capture.
raw_capture_enabled = False


def get_session_type_name(session_type_id: int) -> str:
    """Convert session type ID to readable name"""
    return SESSION_TYPE_MAP.get(session_type_id, f"Unknown ({session_type_id})")


# The F1 24 session packet reports the weather as a small code. Map it to a
# readable name for the dashboard marker.
WEATHER_MAP = {
    0: "Clear",
    1: "Light Cloud",
    2: "Overcast",
    3: "Light Rain",
    4: "Heavy Rain",
    5: "Storm",
}


def get_weather_name(weather_id: int) -> str:
    """Convert the weather code from the session packet to a readable name."""
    return WEATHER_MAP.get(weather_id, "Unknown")


def should_process_packet(packet_id: int) -> bool:
    """Determine if a packet should be processed based on filtering settings"""
    if not ENABLE_PACKET_FILTERING:
        return True
    return packet_id in ESSENTIAL_PACKET_IDS


# --- Utility Functions ---
def ms_to_laptime_str(ms: Optional[int]) -> str:
    if (
        ms is None or ms <= 0
    ):  # Handle cases where lap time might be 0, None, or invalid
        # Depending on requirements, could return None, an empty string, or a placeholder
        return (
            "0:00.000"  # Or perhaps better to indicate no valid time, e.g., "--:--.---"
        )

    total_seconds = ms / 1000.0
    minutes = int(total_seconds // 60)
    seconds = int(total_seconds % 60)
    milliseconds = int(round((total_seconds - (minutes * 60) - seconds) * 1000))
    # Ensure milliseconds don't round up to 1000, which would break formatting
    if milliseconds >= 1000:
        milliseconds = 999
    return f"{minutes}:{seconds:02d}.{milliseconds:03d}"


# --- New Helper Function for /api/drivers ---
async def get_live_driver_data_for_api() -> Dict[str, DriverResponse]:
    """
    Assembles live driver data from telemetry stores for the API.
    Returns a dictionary of DriverResponse objects, keyed by driver name.
    """
    # Access global stores; ensure they are declared global if modified, but here we only read.
    # It's assumed participant_data_store, lap_data_store, active_drivers_count are accessible in this scope.

    drivers_api_response: Dict[str, DriverResponse] = {}

    # Each driver's fastest-lap sectors, used as the fallback shown on the track
    # map when a car is not currently on a flying lap (see the pace logic below).
    from app.services.lap_time_store import get_fastest_lap_sectors_by_name
    fastest_sectors_by_name = await get_fastest_lap_sectors_by_name()

    now_time = time.time()

    if telemetry_sources:
        # Take the snapshot under the lock so the worker thread cannot add a new
        # source (and resize the dict) while we are iterating it.
        with telemetry_sources_lock:
            source_items = list(telemetry_sources.items())
    else:
        source_items = [
            (
                "local",
                {
                    "positions": latest_car_positions,
                    "participants": participant_data_store,
                    "laps": lap_data_store,
                    "active_drivers_count": active_drivers_count,
                },
            )
        ]

    for instance_index, (source_id, source_state) in enumerate(source_items):
        source_participants = source_state.get("participants", [])
        source_positions = source_state.get("positions", [])
        source_laps = source_state.get("laps", [])
        source_active_count = source_state.get("active_drivers_count", 0)
        # When each slot last crossed a sector split, used to tell whether the
        # car is on a flying lap (empty for the "local" fallback source, which
        # has no such tracking).
        last_progress_list = source_state.get("last_sector_progress_time", [])

        if (
            not isinstance(source_participants, list)
            or not isinstance(source_active_count, int)
            or source_active_count == 0
        ):
            continue

        for i in range(min(source_active_count, len(source_participants))):
            participant = source_participants[i]

            # Check if lap data is populated and index is valid
            lap_data = {}
            if isinstance(source_laps, list) and i < len(source_laps):
                lap_data = source_laps[i]

            if (
                not participant
                or not isinstance(participant, dict)
                or not participant.get("name")
                or participant.get("name") == "N/A"
            ):
                continue

            telemetry_name = participant.get("name", f"Driver {i+1}")
            driver_name = get_driver_display_name(telemetry_name)
            team_id = participant.get("teamId", 255)
            team_name = TEAM_ID_MAP.get(team_id, "Unknown Team")

            lap_times_list: List[LapTime] = []
            last_lap_ms = lap_data.get("lastLapTimeInMS") if isinstance(lap_data, dict) else None
            if last_lap_ms is not None and isinstance(last_lap_ms, int) and last_lap_ms > 0:
                lap_times_list.append(LapTime(time=ms_to_laptime_str(last_lap_ms), is_fastest=True))

            motion_data = None
            if isinstance(source_positions, list) and i < len(source_positions):
                motion_data = source_positions[i]

            world_x, world_y, world_z = None, None, None
            if motion_data and isinstance(motion_data, dict):
                world_x = motion_data.get("worldPositionX")
                world_y = motion_data.get("worldPositionY")
                world_z = motion_data.get("worldPositionZ")

            # Work out the live sector times to show. S1 and S2 come from the lap
            # in progress and fill in as the car crosses each split (they read 0
            # until then).
            current_s1 = 0
            current_s2 = 0
            live_lap_invalid = False
            if isinstance(lap_data, dict):
                current_s1 = lap_data.get("sector1TimeMS", 0) or 0
                current_s2 = lap_data.get("sector2TimeMS", 0) or 0
                live_lap_invalid = bool(lap_data.get("currentLapInvalid", 0))

            # How long ago this car last crossed a sector split (S/F line, S1 or
            # S2). 0 means we have never seen it cross one this session.
            last_progress_time = 0.0
            if i < len(last_progress_list):
                last_progress_time = last_progress_list[i]
            seconds_since_progress = now_time - last_progress_time

            # Decide what the three live sector boxes should show.
            #   On a flying lap (the car crossed a split within the last
            #   SECTOR_PACE_IDLE_SECONDS): show only the lap in progress so the
            #   pace is clear. S1 and S2 fill in as the car crosses each split
            #   (they read 0 until then) and S3 stays blank until the lap
            #   finishes. The other two boxes are cleared as soon as a fresh lap
            #   starts at the S/F line, so you can see the new pace building up.
            #   Otherwise the car is idle (parked, in the pits, or between
            #   sessions): fall back to the driver's fastest recorded lap so the
            #   boxes show their best pace as a reference.
            driver_is_on_a_lap = (
                last_progress_time > 0
                and seconds_since_progress <= SECTOR_PACE_IDLE_SECONDS
            )
            if driver_is_on_a_lap:
                live_s1 = current_s1
                live_s2 = current_s2
                live_s3 = 0
            else:
                fastest_sectors = fastest_sectors_by_name.get(driver_name)
                if fastest_sectors is not None:
                    live_s1 = fastest_sectors[0]
                    live_s2 = fastest_sectors[1]
                    live_s3 = fastest_sectors[2]
                else:
                    live_s1 = 0
                    live_s2 = 0
                    live_s3 = 0
                # The fastest lap shown here is a valid lap, so never colour
                # these reference sectors red even if the car's current (idle)
                # lap is flagged invalid by the game.
                live_lap_invalid = False

            driver_key = f"{source_id}:{i}"
            drivers_api_response[driver_key] = DriverResponse(
                name=driver_name,
                team=team_name,
                lap_times=lap_times_list,
                world_x=world_x,
                world_y=world_y,
                world_z=world_z,
                car_index=i,
                source_id=source_id,
                instance_index=instance_index,
                telemetry_name=telemetry_name,
                live_sector_1_ms=live_s1,
                live_sector_2_ms=live_s2,
                live_sector_3_ms=live_s3,
                live_lap_invalid=live_lap_invalid,
                live_lap_active=driver_is_on_a_lap,
            )

    logger.debug(
        "[get_live_driver_data_for_api] Returning %s live drivers across %s sources.",
        len(drivers_api_response),
        len(source_items),
    )

    return drivers_api_response


@telemetry_router.get("/driver_aliases", response_model=Dict[str, str])
async def get_driver_aliases():
    """Returns telemetry-name to display-name aliases used for auto-saving laps."""
    return dict(driver_name_aliases)


@telemetry_router.post("/driver_alias", response_model=Dict[str, str])
async def set_driver_alias(alias_input: DriverAliasInput):
    """Sets or clears a display name alias for a raw telemetry driver name."""
    # Defence in depth: both names are shown on every operator's dashboard.
    cleaned_telemetry_name = _clean_driver_name(alias_input.telemetry_name)
    if cleaned_telemetry_name is None:
        raise HTTPException(status_code=400, detail="Telemetry name is invalid")
    telemetry_name = cleaned_telemetry_name

    if not telemetry_name:
        raise HTTPException(status_code=400, detail="Telemetry name cannot be empty")

    # Empty display name is allowed: it clears the alias.
    cleaned_display_name = _clean_driver_name(alias_input.display_name)
    if cleaned_display_name is None:
        raise HTTPException(status_code=400, detail="Display name is invalid")
    display_name = cleaned_display_name

    alias_key = _normalize_driver_name(telemetry_name)
    if (
        alias_key not in driver_name_aliases
        and len(driver_name_aliases) >= 256
    ):
        raise HTTPException(status_code=400, detail="Too many aliases")

    if display_name:
        driver_name_aliases[alias_key] = display_name
    else:
        driver_name_aliases.pop(alias_key, None)

    return dict(driver_name_aliases)


# Global flag and event to control the listener thready listener
try:
    from f1_24_telemetry.listener import TelemetryListener
    from f1_24_telemetry.packets import PacketHeader, HEADER_FIELD_TO_PACKET_TYPE

    F1_TELEMETRY_AVAILABLE = True
except ImportError:
    TelemetryListener = None  # type: ignore
    PacketHeader = None  # type: ignore
    HEADER_FIELD_TO_PACKET_TYPE = None  # type: ignore
    F1_TELEMETRY_AVAILABLE = False
    print("WARNING: f1_24_telemetry library not found. UDP Telemetry will not work.")
    print(
        "Please install it, possibly using: pip install git+https://github.com/xavierdubuc/f1-24-telemetry.git"
    )

# Global state for the telemetry listener
listener_thread: Optional[threading.Thread] = None
listener_stop_event: Optional[threading.Event] = None
listener_port: Optional[int] = None
listener_host: Optional[str] = None
listener_error: Optional[str] = None
active_drivers_count = 0  # Updated by participant packets

# Enhanced telemetry data stores
latest_car_positions: list = []  # Will store dicts of car positions
participant_data_store: list = []  # Will store dicts of participant info
session_data_store: dict = {}  # Will store basic session info
enhanced_session_data_store: dict = {}  # Will store enhanced session info with types
lap_data_store: list = []  # To store lap data for each car
telemetry_sources: Dict[str, Dict[str, Any]] = {}
# Guards inserting/removing keys in telemetry_sources so the background UDP
# thread and the async API handlers never touch the dict's shape at the same
# time (which could otherwise crash an in-progress read of the dict).
telemetry_sources_lock = threading.Lock()
driver_name_aliases: Dict[str, str] = {}

# Auto-save lap times.
# The per-car tracking that decides when a completed lap should be saved (last
# seen lap time, who owns the lap in progress, top speed, and which laps were
# already saved) lives per telemetry source inside telemetry_sources, so two F1
# clients sending the same car slot never overwrite each other's tracking.
IGNORED_AUTOSAVE_DRIVER_NAMES = {"personal best"}
_main_event_loop = None


def set_main_event_loop(loop):
    global _main_event_loop
    _main_event_loop = loop

# Performance tracking
packets_processed_count = 0
packets_filtered_count = 0


def _normalize_driver_name(name: str) -> str:
    return name.strip().lower()


def _clean_driver_name(name: str, max_len: int = 48) -> Optional[str]:
    """Strips a driver name and rejects it (returns None) if too long or if it
    contains control/format characters (C0/C1 controls, DEL, line/paragraph
    separators, zero-width chars, bidi overrides, etc.)."""
    cleaned = name.strip()
    if len(cleaned) > max_len:
        return None
    if any(unicodedata.category(c) in ("Cc", "Cf") for c in cleaned):
        return None
    return cleaned


def get_driver_display_name(telemetry_name: str) -> str:
    return driver_name_aliases.get(_normalize_driver_name(telemetry_name), telemetry_name)


def _maybe_auto_set_track(track_id):
    """Switch the backend track to match the one the game reports, if it changed.

    Called from the listener thread for every SessionData packet. We only act
    when the track_id is different from the last one we applied, so we don't fire
    a track change many times per second. Setting the track makes auto-saved laps
    write to that track's file, and the set_track call broadcasts a "track_update"
    so every open dashboard switches to the live track on its own.
    """
    global _last_auto_set_track_id

    # Nothing to do if the game is still on the same track we last applied.
    if track_id == _last_auto_set_track_id:
        return

    track_name = TRACK_ID_TO_NAME.get(track_id)
    if not track_name:
        # We have no files for this track, so leave the current selection alone.
        return

    # Remember it even before applying, so we don't retry every packet while the
    # event loop is briefly unavailable.
    _last_auto_set_track_id = track_id

    if _main_event_loop is None:
        return

    # set_track is async and lives on the main event loop; the listener runs in a
    # plain thread, so hand the call across with run_coroutine_threadsafe (same
    # pattern used for auto-saving laps).
    from app.services.lap_time_store import set_track

    asyncio.run_coroutine_threadsafe(set_track(track_name), _main_event_loop)
    logger.debug(
        "Auto-detected track from telemetry: track_id %s -> '%s'",
        track_id,
        track_name,
    )


def _empty_car_store() -> list:
    return [{} for _ in range(22)]


def _get_source_state(source_id: str) -> Dict[str, Any]:
    # Adding a new key to telemetry_sources changes the dict's size, so do it
    # under the lock to stay safe against an API handler reading the dict.
    with telemetry_sources_lock:
        if source_id not in telemetry_sources:
            telemetry_sources[source_id] = {
                "positions": _empty_car_store(),
                "participants": _empty_car_store(),
                "session": {},
                "enhanced_session": {},
                "laps": _empty_car_store(),
                "active_drivers_count": 0,
                "last_seen": time.time(),
                # Per-car auto-save tracking for THIS source only.
                "last_lap_times": [0] * 22,  # last seen lastLapTimeInMS per slot
                "lap_owner_names": [None] * 22,  # who owns the lap in progress
                "lap_top_speeds": [0.0] * 22,  # max speed seen this lap per slot
                "saved_signatures": [],  # signatures of laps already auto-saved
                "lap_tracking_started": [False] * 22,  # have we seen this slot yet
                # Sector tracking. The game only sends S1 and S2 for the lap in
                # progress, and they reset to 0 when the next lap starts, so we
                # remember the latest non-zero S1/S2 we saw for each car. When a
                # lap completes we use them (plus the derived S3) to save the
                # finished lap's sector times with its record.
                "live_sector1_ms": [0] * 22,  # newest S1 seen this lap per slot
                "live_sector2_ms": [0] * 22,  # newest S2 seen this lap per slot
                # Whether the lap in progress was marked invalid at any point. The
                # game's currentLapInvalid flag is reset when the next lap starts,
                # so (like the sectors) we remember it across the lap and use it to
                # save the finished lap with the correct validity.
                "live_lap_invalid_flag": [False] * 22,
                # When (time.time()) each slot last crossed a sector split: the
                # S/F line (lap completed), S1 or S2. The track map uses this to
                # tell whether the car is on a flying lap or has gone idle. 0
                # means we have not seen it cross a split yet.
                "last_sector_progress_time": [0.0] * 22,
                # The display name currently driving each slot. When it changes
                # (a player was switched mid-session), we reset that slot's pace
                # timer so the new driver starts fresh and never shows the old
                # driver's in-progress sectors.
                "live_display_owner": [None] * 22,
                # Latest raw packet of each type (every field the game sent),
                # keyed by packet_id, for the /raw debug endpoint.
                "raw_packets": {},
            }
        telemetry_sources[source_id]["last_seen"] = time.time()
        return telemetry_sources[source_id]


def _parse_packet_with_sender(listener_instance):
    raw_packet, sender = listener_instance.socket.recvfrom(2048)
    header = PacketHeader.from_buffer_copy(raw_packet)
    key = (header.packet_format, header.packet_version, header.packet_id)
    return HEADER_FIELD_TO_PACKET_TYPE[key].unpack(raw_packet), sender


# --- Raw packet dumping (debug) ---
# The f1_24_telemetry library hands us each packet as a ctypes Structure. These
# two helpers walk that structure and turn it into plain Python types (dicts,
# lists, numbers, strings) so it can be returned as JSON by the /raw endpoint.
def _convert_ctypes_value(value):
    """Turn a single ctypes field value into a plain, JSON-friendly value."""
    # Text fields (like driver names) arrive as bytes; decode them and cut the
    # string at the first null byte the game uses for padding.
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").split("\x00")[0]

    # A nested structure (for example the packet header, or one car's data).
    if isinstance(value, ctypes.Structure):
        return _structure_to_dict(value)

    # A fixed-size array, such as the per-car lists in most packets.
    if isinstance(value, ctypes.Array):
        items = []
        for element in value:
            items.append(_convert_ctypes_value(element))
        return items

    # Anything else is already a plain int/float and can be used as-is.
    return value


def _structure_to_dict(structure):
    """Convert a whole ctypes Structure into a dict of all its fields."""
    result = {}
    for field in structure._fields_:
        field_name = field[0]
        field_value = getattr(structure, field_name)
        result[field_name] = _convert_ctypes_value(field_value)
    return result


class TelemetryStatus(BaseModel):
    running: bool
    host: Optional[str] = None
    port: Optional[int] = None
    active_drivers: int = 0
    error: Optional[str] = None


class StartResponse(BaseModel):
    message: str
    host: str
    port: int


class SessionConditions(BaseModel):
    # Live track conditions shown on the map markers. Every field is optional so
    # the endpoint still returns cleanly before any session packet has arrived.
    available: bool = False
    weather: Optional[int] = None
    weatherName: Optional[str] = None
    trackTemperature: Optional[int] = None
    airTemperature: Optional[int] = None
    timeOfDay: Optional[int] = None


class RawCaptureInput(BaseModel):
    # Whether the listener should capture raw packets for the /raw endpoint.
    enabled: bool


def get_local_ip():
    """Helper function to get the local IP address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(0.1)  # Prevent long block if no network
    try:
        # Doesn't actually have to connect, uses OS routing table
        s.connect(("10.255.255.255", 1))
        IP = s.getsockname()[0]
    except Exception:
        try:
            IP = socket.gethostbyname(socket.gethostname())
        except socket.gaierror:
            IP = "127.0.0.1"  # Fallback
    finally:
        s.close()
    return IP


def telemetry_listener_worker(host: str, port: int, stop_event: threading.Event):
    global listener_error, active_drivers_count, packets_processed_count, packets_filtered_count
    global latest_car_positions, participant_data_store, session_data_store, enhanced_session_data_store, lap_data_store, telemetry_sources

    listener_instance = None
    try:
        print(f"Attempting to start UDP telemetry listener on {host}:{port}")
        listener_instance = TelemetryListener(port=port, host=host)
        # Give the socket a short timeout so recvfrom wakes up regularly. Without
        # this, a quiet game (no packets) would leave recvfrom blocked forever and
        # the worker could never notice the stop signal until the next packet.
        if hasattr(listener_instance, "socket") and listener_instance.socket:
            listener_instance.socket.settimeout(1.0)
        print(f"UDP Telemetry listener started on {host}:{port}")

        # Ensure stores are initialized (though _clear_listener_state should handle this prior to thread start)
        if not latest_car_positions or len(latest_car_positions) != 22:
            latest_car_positions = [{} for _ in range(22)]
        if not participant_data_store or len(participant_data_store) != 22:
            participant_data_store = [{} for _ in range(22)]
        if not session_data_store:
            session_data_store = {}
        if not lap_data_store or len(lap_data_store) != 22:
            lap_data_store = [{} for _ in range(22)]

        while not stop_event.is_set():
            try:
                packet, sender = _parse_packet_with_sender(listener_instance)
                source_id = sender[0]
                source_state = _get_source_state(source_id)
                latest_car_positions = source_state["positions"]
                participant_data_store = source_state["participants"]
                session_data_store = source_state["session"]
                enhanced_session_data_store = source_state["enhanced_session"]
                lap_data_store = source_state["laps"]
                active_drivers_count = source_state.get("active_drivers_count", 0)
                if not packet:
                    logger.warning(
                        "listener_instance.get() returned a null/falsey packet. Skipping."
                    )
                    continue

                logger.debug(
                    f"Listener got a packet of type: {type(packet)}. Has 'header' attribute? {hasattr(packet, 'header')}"
                )

                if hasattr(packet, "header"):
                    packet_id = packet.header.packet_id
                    logger.debug(
                        f"Received packet_id: {packet_id} (type: {type(packet_id)})"
                    )  # Packet filtering for performance optimization

                    # Keep a full copy of the latest packet of every type for the
                    # /raw debug endpoint, but only when raw capture is turned on
                    # (it is off by default to save CPU). We do this BEFORE the
                    # performance filter below so the dump includes every packet
                    # the game sends, not just the ones the dashboard normally
                    # uses. We store it under the same lock that guards the sources
                    # dict so the /raw handler never reads a half-written entry.
                    if raw_capture_enabled:
                        raw_packet_dump = _structure_to_dict(packet)
                        with telemetry_sources_lock:
                            source_state["raw_packets"][packet_id] = {
                                "packet_id": packet_id,
                                "received_at": time.time(),
                                "data": raw_packet_dump,
                            }

                    if not should_process_packet(packet_id):
                        packets_filtered_count += 1
                        logger.debug(
                            f"Packet ID {packet_id} filtered out for performance"
                        )
                        continue

                    packets_processed_count += 1

                    if packet_id == 0:  # MotionData
                        logger.debug(
                            f"Processing MotionData (ID 0). Cars: {len(packet.car_motion_data) if hasattr(packet, 'car_motion_data') else 'N/A'}"
                        )
                        # active_drivers_count = sum(1 for car_motion in packet.car_motion_data if car_motion.world_position_x != 0 or car_motion.world_position_y != 0 or car_motion.world_position_z != 0) # This is not the authoritative source for active_drivers_count
                        for i, car_motion in enumerate(packet.car_motion_data):
                            if i < 22:  # Ensure we don't exceed our list size
                                latest_car_positions[i] = {
                                    "worldPositionX": car_motion.world_position_x,
                                    "worldPositionY": car_motion.world_position_y,
                                    "worldPositionZ": car_motion.world_position_z,
                                    "gForceLateral": car_motion.g_force_lateral,
                                    "gForceLongitudinal": car_motion.g_force_longitudinal,
                                    "gForceVertical": car_motion.g_force_vertical,
                                    "yaw": car_motion.yaw,
                                    "pitch": car_motion.pitch,
                                    "roll": car_motion.roll,
                                }

                        logger.debug(
                            f"Updated latest_car_positions for {len(packet.car_motion_data) if hasattr(packet, 'car_motion_data') else 'N/A'} cars. First car X: {latest_car_positions[0].get('worldPositionX') if latest_car_positions and latest_car_positions[0] else 'N/A'}"
                        )
                    elif packet_id == 1:  # SessionData
                        logger.debug(
                            f"Processing SessionData (ID 1). Track ID: {packet.track_id if hasattr(packet, 'track_id') else 'N/A'}"
                        )

                        # Update basic session data store (backwards compatibility)
                        session_data_store.update(
                            {
                                "trackId": packet.track_id,
                                "networkGame": packet.network_game,
                                "gamePaused": packet.game_paused,
                                "sessionType": packet.session_type,
                                "sessionLinkIdentifier": packet.session_link_identifier,
                                "sessionTimeLeft": packet.session_time_left,
                                "sessionDuration": packet.session_duration,
                                "pitSpeedLimit": packet.pit_speed_limit,
                            }
                        )

                        # Follow the track the game is actually on, so laps save to
                        # the right file and every dashboard switches to it. Only
                        # fires when the track changes (see _maybe_auto_set_track).
                        _maybe_auto_set_track(packet.track_id)

                        # Update enhanced session data store with session type details
                        session_type_name = get_session_type_name(packet.session_type)
                        enhanced_session_data_store.update(
                            {
                                "trackId": packet.track_id,
                                "networkGame": packet.network_game,
                                "gamePaused": packet.game_paused,
                                "sessionType": packet.session_type,
                                "sessionTypeName": session_type_name,
                                "sessionTimeLeft": packet.session_time_left,
                                "sessionDuration": packet.session_duration,
                                "pitSpeedLimit": packet.pit_speed_limit,
                                "sessionLinkIdentifier": packet.session_link_identifier,
                                # Weather / conditions shown on the map markers.
                                # Temperatures are whole degrees Celsius; weather
                                # is a code (see get_weather_name); timeOfDay is
                                # minutes since midnight in the game world.
                                "weather": packet.weather,
                                "weatherName": get_weather_name(packet.weather),
                                "trackTemperature": packet.track_temperature,
                                "airTemperature": packet.air_temperature,
                                "timeOfDay": packet.time_of_day,
                                # Additional enhanced fields
                                "sessionTypeCategory": (
                                    "Practice"
                                    if packet.session_type in [1, 2, 3, 4]
                                    else (
                                        "Qualifying"
                                        if packet.session_type in [5, 6, 7, 8, 9]
                                        else (
                                            "Race"
                                            if packet.session_type in [10, 11, 12]
                                            else "Other"
                                        )
                                    )
                                ),
                                "isRaceSession": packet.session_type in [10, 11, 12],
                                "isPracticeSession": packet.session_type
                                in [1, 2, 3, 4],
                                "isQualifyingSession": packet.session_type
                                in [5, 6, 7, 8, 9],
                            }
                        )

                        logger.debug(
                            f"Updated session data stores. Track ID: {session_data_store.get('trackId')}, "
                            f"Session Type: {session_data_store.get('sessionType')} ({session_type_name})"
                        )

                    elif packet_id == 4:  # ParticipantsData
                        num_cars_to_log = (
                            str(packet.num_active_cars)
                            if hasattr(packet, "num_active_cars")
                            else (
                                str(packet.m_numActiveCars)
                                if hasattr(packet, "m_numActiveCars")
                                else "N/A"                            )
                        )
                        logger.debug(
                            f"Processing ParticipantsData (ID 4). Num Active Cars: {num_cars_to_log}"
                        )
                        if hasattr(
                            packet, "num_active_cars"
                        ):  # Check for 'num_active_cars' first
                            active_drivers_count = packet.num_active_cars
                            logger.debug(
                                f"[telemetry_listener_worker] active_drivers_count set to: {active_drivers_count} from packet.num_active_cars"
                            )
                        elif hasattr(
                            packet, "m_numActiveCars"
                        ):  # Fallback to 'm_numActiveCars'
                            active_drivers_count = packet.m_numActiveCars
                            logger.debug(
                                f"[telemetry_listener_worker] active_drivers_count set to: {active_drivers_count} from packet.m_numActiveCars (fallback)"
                            )
                        else:
                            logger.warning(
                                f"[telemetry_listener_worker] PacketParticipantsData (ID 4) received, but NEITHER 'num_active_cars' NOR 'm_numActiveCars' attribute is present. Cannot update active_drivers_count from packet header."
                            )

                        if hasattr(packet, "participants"):
                            # Ensure participant_data_store is initialized as a list of 22 empty dicts if not already
                            # This check is important if the listener starts after some packets have been missed
                            if (
                                not isinstance(participant_data_store, list)
                                or len(participant_data_store) != 22
                            ):
                                logger.warning(
                                    "participant_data_store is not a list of 22 elements. Re-initializing."
                                )
                                participant_data_store[:] = [
                                    {} for _ in range(22)
                                ]  # Modify in place

                            num_to_process = 0
                            if hasattr(packet, "m_numActiveCars"):  # F1 2020+
                                num_to_process = packet.m_numActiveCars
                            elif hasattr(packet, "header") and hasattr(
                                packet.header, "player_car_index"
                            ):  # Fallback for older games
                                num_to_process = len(packet.participants)
                            else:
                                num_to_process = len(
                                    packet.participants
                                )  # Default to length of participants array if count is missing

                            logger.debug(
                                f"ParticipantsData: num_to_process = {num_to_process}, actual len(packet.participants) = {len(packet.participants)}"
                            )

                            # Clear only the relevant portion of the store before repopulating
                            # for i in range(22):
                            #     participant_data_store[i] = {}

                            processed_indices = set()
                            for i in range(
                                min(num_to_process, len(packet.participants), 22)
                            ):
                                participant = packet.participants[i]
                                processed_indices.add(i)
                                try:
                                    name_bytes = getattr(participant, "name", b"")
                                    name_str = (
                                        name_bytes.decode("utf-8", errors="replace")
                                        .split("\x00")[0]
                                        .strip()
                                    )
                                    cleaned_name_str = _clean_driver_name(name_str)
                                    if (
                                        not cleaned_name_str
                                        or cleaned_name_str == "???????????????"
                                        or cleaned_name_str.lower() == "player"
                                        or cleaned_name_str.isspace()
                                    ):
                                        race_num = getattr(
                                            participant, "race_number", 0
                                        )
                                        name_str = f"Driver {race_num if race_num != 0 else i + 1}"
                                    else:
                                        name_str = cleaned_name_str
                                except Exception as e:
                                    logger.error(
                                        f"Error decoding participant name for index {i}: {e}"
                                    )
                                    race_num = getattr(participant, "race_number", 0)
                                    name_str = (
                                        f"Driver {race_num if race_num != 0 else i + 1}"
                                    )

                                participant_data_store[i] = {
                                    "aiControlled": getattr(
                                        participant, "ai_controlled", 1
                                    ),
                                    "driverId": getattr(participant, "driver_id", 255),
                                    "networkId": getattr(
                                        participant, "network_id", 255
                                    ),
                                    "teamId": getattr(participant, "team_id", 255),
                                    "myTeam": getattr(participant, "my_team", 0),
                                    "raceNumber": getattr(
                                        participant, "race_number", 0
                                    ),
                                    "nationality": getattr(
                                        participant, "nationality", 0
                                    ),
                                    "name": name_str,
                                    "yourTelemetry": getattr(
                                        participant, "your_telemetry", 0
                                    ),
                                    "is_online_player": (
                                        True
                                        if hasattr(participant, "network_id")
                                        and participant.network_id != 0
                                        and participant.network_id != 255
                                        and getattr(participant, "driver_id", 255)
                                        == 255
                                        else False
                                    ),
                                    "raw_name_bytes": (
                                        name_bytes.hex()
                                        if isinstance(name_bytes, bytes)
                                        else ""
                                    ),
                                }
                            # Clear data for cars that are no longer active in this packet
                            for i in range(22):
                                if i not in processed_indices and i >= num_to_process:
                                    participant_data_store[i] = {}

                        logger.debug(
                            f"Participant data store updated. Active drivers: {active_drivers_count}. Processed up to {min(num_to_process, len(packet.participants), 22)} participants."
                        )
                        if (
                            participant_data_store
                            and len(participant_data_store) > 0
                            and participant_data_store[0]
                        ):
                            logger.debug(
                                f"First participant after update: Name='{participant_data_store[0].get('name')}', TeamID='{participant_data_store[0].get('teamId')}'"
                            )
                        else:
                            logger.debug(
                                "Participant_data_store is empty or first element is empty after update."
                            )
                        source_state["active_drivers_count"] = active_drivers_count
                    elif packet_id == 2:  # LapData
                        logger.debug(
                            f"Processing LapData (ID 2). Cars: {len(packet.lap_data) if hasattr(packet, 'lap_data') else 'N/A'}"
                        )
                        for i, car_lap in enumerate(packet.lap_data):
                            if i < 22:
                                lap_data_store[i] = {
                                    "lastLapTimeInMS": (
                                        car_lap.last_lap_time_in_ms
                                        if hasattr(car_lap, "last_lap_time_in_ms")
                                        else 0
                                    ),
                                    "currentLapTimeInMS": (
                                        car_lap.current_lap_time_in_ms
                                        if hasattr(car_lap, "current_lap_time_in_ms")
                                        else 0
                                    ),
                                    "lapDistance": (
                                        car_lap.lap_distance
                                        if hasattr(car_lap, "lap_distance")
                                        else 0.0
                                    ),
                                    "totalDistance": (
                                        car_lap.total_distance
                                        if hasattr(car_lap, "total_distance")
                                        else 0.0
                                    ),
                                    "safetyCarDelta": (
                                        car_lap.safety_car_delta
                                        if hasattr(car_lap, "safety_car_delta")
                                        else 0.0
                                    ),
                                    "carPosition": (
                                        car_lap.car_position
                                        if hasattr(car_lap, "car_position")
                                        else 0
                                    ),
                                    "currentLapNum": (
                                        car_lap.current_lap_num
                                        if hasattr(car_lap, "current_lap_num")
                                        else 0
                                    ),
                                    "pitStatus": (
                                        car_lap.pit_status
                                        if hasattr(car_lap, "pit_status")
                                        else 0
                                    ),
                                    "numPitStops": (
                                        car_lap.num_pit_stops
                                        if hasattr(car_lap, "num_pit_stops")
                                        else 0
                                    ),
                                    "currentLapInvalid": (
                                        car_lap.current_lap_invalid
                                        if hasattr(car_lap, "current_lap_invalid")
                                        else 0
                                    ),
                                    "penalties": (
                                        car_lap.penalties
                                        if hasattr(car_lap, "penalties")
                                        else 0
                                    ),
                                    "totalWarnings": (
                                        car_lap.total_warnings
                                        if hasattr(car_lap, "total_warnings")
                                        else 0
                                    ),  # Corrected from 'warnings'
                                    "cornerCuttingWarnings": (
                                        car_lap.corner_cutting_warnings
                                        if hasattr(car_lap, "corner_cutting_warnings")
                                        else 0
                                    ),
                                    "numUnservedDriveThroughPens": (
                                        car_lap.num_unserved_drive_through_pens
                                        if hasattr(
                                            car_lap, "num_unserved_drive_through_pens"
                                        )
                                        else 0
                                    ),
                                    "numUnservedStopGoPens": (
                                        car_lap.num_unserved_stop_go_pens
                                        if hasattr(car_lap, "num_unserved_stop_go_pens")
                                        else 0
                                    ),
                                    "gridPosition": (
                                        car_lap.grid_position
                                        if hasattr(car_lap, "grid_position")
                                        else 0
                                    ),
                                    "driverStatus": (
                                        car_lap.driver_status
                                        if hasattr(car_lap, "driver_status")
                                        else 0
                                    ),
                                    "resultStatus": (
                                        car_lap.result_status
                                        if hasattr(car_lap, "result_status")
                                        else 0
                                    ),
                                    "pitLaneTimerActive": (
                                        car_lap.pit_lane_timer_active
                                        if hasattr(car_lap, "pit_lane_timer_active")
                                        else 0
                                    ),
                                    "pitLaneTimeInLaneInMS": (
                                        car_lap.pit_lane_time_in_lane_in_ms
                                        if hasattr(
                                            car_lap, "pit_lane_time_in_lane_in_ms"
                                        )
                                        else 0
                                    ),
                                    "pitStopTimerInMS": (
                                        car_lap.pit_stop_timer_in_ms
                                        if hasattr(car_lap, "pit_stop_timer_in_ms")
                                        else 0
                                    ),
                                    "pitStopShouldServePen": (
                                        car_lap.pit_stop_should_serve_pen
                                        if hasattr(car_lap, "pit_stop_should_serve_pen")
                                        else 0
                                    ),
                                    "speedTrapFastestSpeed": (
                                        car_lap.speed_trap_fastest_speed
                                        if hasattr(car_lap, "speed_trap_fastest_speed")
                                        else 0.0
                                    ),
                                    "speedTrapFastestLap": (
                                        car_lap.speed_trap_fastest_lap
                                        if hasattr(car_lap, "speed_trap_fastest_lap")
                                        else 0
                                    ),
                                    # Sector times for the lap in progress. The game
                                    # splits each sector time into a minutes part and a
                                    # milliseconds part, so add them back together into
                                    # a single millisecond value. These read 0 until the
                                    # car crosses the matching split.
                                    "sector1TimeMS": (
                                        getattr(car_lap, "sector_1_time_minutes", 0) * 60000
                                        + getattr(car_lap, "sector_1_time_in_ms", 0)
                                    ),
                                    "sector2TimeMS": (
                                        getattr(car_lap, "sector_2_time_minutes", 0) * 60000
                                        + getattr(car_lap, "sector_2_time_in_ms", 0)
                                    ),
                                }
                            # Auto-save completed laps to the leaderboard.
                            # Lap packets include inactive ghost/reference slots,
                            # so persist only active participant slots. All the
                            # tracking below is per-source so two F1 clients on
                            # the same car slot never clash.
                            last_lap_times = source_state["last_lap_times"]
                            lap_owner_names = source_state["lap_owner_names"]
                            lap_top_speeds = source_state["lap_top_speeds"]
                            saved_signatures = source_state["saved_signatures"]
                            lap_tracking_started = source_state["lap_tracking_started"]
                            live_sector1_ms = source_state["live_sector1_ms"]
                            live_sector2_ms = source_state["live_sector2_ms"]

                            active_slots = (
                                active_drivers_count
                                if isinstance(active_drivers_count, int)
                                and active_drivers_count > 0
                                else 0
                            )
                            if _main_event_loop is not None and i < active_slots:
                                last_lap_ms = lap_data_store[i].get("lastLapTimeInMS", 0)
                                lap_invalid = bool(lap_data_store[i].get("currentLapInvalid", 0))
                                participant = participant_data_store[i] if i < len(participant_data_store) else {}
                                telemetry_name = participant.get("name", "")
                                current_display_name = get_driver_display_name(telemetry_name)

                                last_sector_progress_time = source_state["last_sector_progress_time"]
                                live_display_owner = source_state["live_display_owner"]
                                now_time = time.time()

                                # If a different driver now owns this slot (a player
                                # was switched mid-session), reset the pace timer so
                                # the new driver is treated as completely fresh and
                                # never shows the previous driver's in-progress pace.
                                if (
                                    live_display_owner[i] is not None
                                    and live_display_owner[i] != current_display_name
                                ):
                                    last_sector_progress_time[i] = 0.0
                                live_display_owner[i] = current_display_name

                                # Remember the latest non-zero S1/S2 for the lap in
                                # progress. The game resets these to 0 when a new lap
                                # starts, so guarding on > 0 keeps the finishing lap's
                                # values around until we snapshot them at the line.
                                current_s1 = lap_data_store[i].get("sector1TimeMS", 0)
                                current_s2 = lap_data_store[i].get("sector2TimeMS", 0)
                                # The moment the car first shows a new S1 or S2 it has
                                # just crossed that split, so refresh the pace timer.
                                if current_s1 > 0 and live_sector1_ms[i] == 0:
                                    last_sector_progress_time[i] = now_time
                                if current_s2 > 0 and live_sector2_ms[i] == 0:
                                    last_sector_progress_time[i] = now_time
                                if current_s1 > 0:
                                    live_sector1_ms[i] = current_s1
                                if current_s2 > 0:
                                    live_sector2_ms[i] = current_s2

                                if not lap_tracking_started[i]:
                                    # First time we see this slot in this session.
                                    # Whatever last lap time it already shows was
                                    # set BEFORE we started listening, so record it
                                    # as the baseline without saving it. Saving
                                    # begins from the next completed lap.
                                    lap_tracking_started[i] = True
                                    lap_owner_names[i] = current_display_name
                                else:
                                    # A brand-new completed lap time appeared for this car slot.
                                    is_new_completed_lap = (
                                        last_lap_ms > 0
                                        and last_lap_ms != last_lap_times[i]
                                    )
                                    if is_new_completed_lap:
                                        # Crossing the start/finish line completes a
                                        # lap, which also counts as crossing a sector
                                        # split, so refresh the pace timer here too.
                                        last_sector_progress_time[i] = now_time

                                        # Work out the just-finished lap's three sector
                                        # times to save with the lap. S1 and S2 are the
                                        # values we tracked above; S3 is whatever is left
                                        # of the whole lap after S1 and S2. If we never
                                        # saw S1 or S2 (a partial lap), leave S3 at 0 so
                                        # the leaderboard shows a dash, not a wrong number.
                                        finished_s1 = live_sector1_ms[i]
                                        finished_s2 = live_sector2_ms[i]
                                        finished_s3 = 0
                                        if (
                                            finished_s1 > 0
                                            and finished_s2 > 0
                                            and last_lap_ms > (finished_s1 + finished_s2)
                                        ):
                                            finished_s3 = last_lap_ms - finished_s1 - finished_s2

                                        # The next lap starts now, so clear the live
                                        # trackers ready for it.
                                        live_sector1_ms[i] = 0
                                        live_sector2_ms[i] = 0

                                        # Whether the just-finished lap was invalid.
                                        # We use the flag we tracked across the lap
                                        # (not currentLapInvalid, which the game has
                                        # already reset for the new lap), then clear
                                        # it ready for the new lap.
                                        finished_invalid = source_state["live_lap_invalid_flag"][i]
                                        source_state["live_lap_invalid_flag"][i] = False

                                        # Credit the finished lap to whoever owned it when it
                                        # STARTED (captured at the previous lap boundary), not to
                                        # whatever the name says right now. This way, renaming a
                                        # player mid-lap does not steal the lap already in progress;
                                        # the new name only takes effect from the next lap onward.
                                        if lap_owner_names[i] is not None:
                                            lap_driver_name = lap_owner_names[i]
                                        else:
                                            lap_driver_name = current_display_name

                                        normalized_telemetry_name = _normalize_driver_name(telemetry_name)
                                        normalized_driver_name = _normalize_driver_name(lap_driver_name)
                                        lap_signature = (normalized_driver_name, last_lap_ms, finished_invalid)
                                        if (
                                            normalized_telemetry_name not in IGNORED_AUTOSAVE_DRIVER_NAMES
                                            and lap_signature not in saved_signatures
                                        ):
                                            team_id = participant.get("teamId", 255)
                                            team_name = TEAM_ID_MAP.get(team_id, "Unknown Team")
                                            if lap_driver_name and lap_driver_name not in ("N/A", ""):
                                                lap_time_str = ms_to_laptime_str(last_lap_ms)
                                                computed_speed = lap_top_speeds[i] if i < len(lap_top_speeds) else 0.0
                                                speed_trap_speed = lap_data_store[i].get("speedTrapFastestSpeed") or 0.0
                                                if computed_speed > 0:
                                                    speed = computed_speed
                                                else:
                                                    speed = speed_trap_speed
                                                from app.models.data_models import LapTimeInput
                                                from app.services.lap_time_store import add_or_update_lap_time
                                                if speed and speed > 0:
                                                    # The game reports speed as a
                                                    # whole number of km/h, so save
                                                    # it as a full number too.
                                                    fastest_speed_kph = round(speed)
                                                else:
                                                    fastest_speed_kph = None
                                                # Pass the three sector times we
                                                # captured for this finished lap, so
                                                # they are saved with the record and
                                                # can show in the leaderboard. Use None
                                                # for any sector we never saw (0), so the
                                                # UI shows a dash instead of "0.000".
                                                saved_s1 = finished_s1 if finished_s1 > 0 else None
                                                saved_s2 = finished_s2 if finished_s2 > 0 else None
                                                saved_s3 = finished_s3 if finished_s3 > 0 else None
                                                lap_input = LapTimeInput(
                                                    name=lap_driver_name,
                                                    team=team_name,
                                                    time=lap_time_str,
                                                    is_valid=not finished_invalid,
                                                    fastest_speed_kph=fastest_speed_kph,
                                                    sector_1_ms=saved_s1,
                                                    sector_2_ms=saved_s2,
                                                    sector_3_ms=saved_s3,
                                                )
                                                asyncio.run_coroutine_threadsafe(
                                                    add_or_update_lap_time(lap_input),
                                                    _main_event_loop
                                                )
                                                # Remember this lap so the same one is not
                                                # saved twice. Keep the list bounded by
                                                # dropping the oldest entry, NOT by wiping
                                                # the whole list.
                                                saved_signatures.append(lap_signature)
                                                if len(saved_signatures) > 1000:
                                                    saved_signatures.pop(0)
                                                logger.debug(
                                                    "Auto-saved lap: %s - %s (speed:%s)",
                                                    lap_driver_name,
                                                    lap_time_str,
                                                    f"{speed:.1f}kph" if speed else "-",
                                                )

                                        if i < len(lap_top_speeds):
                                            lap_top_speeds[i] = 0.0
                                if i < len(last_lap_times):
                                    last_lap_times[i] = lap_data_store[i].get("lastLapTimeInMS", 0)

                                # Keep the lap's owner in step with the current name
                                # until the car crosses the first sector split. The
                                # game resets sector1TimeMS to 0 at the start of every
                                # lap (including after a restart or flashback), so
                                # while it reads 0 the lap has not really begun yet and
                                # a rename should still change who the lap belongs to.
                                # Once S1 is set the owner is frozen, so renaming
                                # mid-lap keeps the lap under the name that started it.
                                if current_s1 == 0:
                                    lap_owner_names[i] = current_display_name

                                # Once the lap in progress is marked invalid it stays
                                # invalid, so remember it here. This runs after the
                                # completion handling above (which read and cleared the
                                # flag for the finished lap), so it only ever marks the
                                # lap currently under way.
                                if lap_invalid:
                                    source_state["live_lap_invalid_flag"][i] = True

                        logger.debug(
                            f"Updated lap_data_store for {len(packet.lap_data) if hasattr(packet, 'lap_data') else 'N/A'} cars."
                        )
                    elif packet_id == 6:  # CarTelemetryData
                        lap_top_speeds = source_state["lap_top_speeds"]
                        for i, car_telemetry in enumerate(packet.car_telemetry_data):
                            if i < len(lap_top_speeds) and hasattr(car_telemetry, "speed"):
                                lap_top_speeds[i] = max(
                                    lap_top_speeds[i],
                                    float(car_telemetry.speed),
                                )
                    elif packet_id == 7:  # CarStatusData
                        logger.debug(
                            f"Processing CarStatusData (ID 7). Cars: {len(packet.car_status_data) if hasattr(packet, 'car_status_data') else 'N/A'}"
                        )
                        if hasattr(packet, "car_status_data"):
                            # Ensure car_status_store is initialized correctly
                            # For now, we'll add basic car status to participant data if needed
                            for i, status_data in enumerate(packet.car_status_data):
                                if i < 22 and i < len(participant_data_store):
                                    # Add some basic status info to participant data
                                    if participant_data_store[i]:
                                        participant_data_store[i].update(
                                            {
                                                "fuelMix": getattr(
                                                    status_data, "fuel_mix", 0
                                                ),
                                                "frontLeftWingDamage": getattr(
                                                    status_data,
                                                    "front_left_wing_damage",
                                                    0,
                                                ),
                                                "frontRightWingDamage": getattr(
                                                    status_data,
                                                    "front_right_wing_damage",
                                                    0,
                                                ),
                                                "rearWingDamage": getattr(
                                                    status_data, "rear_wing_damage", 0
                                                ),
                                                "drsAllowed": getattr(
                                                    status_data, "drs_allowed", 0
                                                ),
                                                "tyresWear": [
                                                    getattr(
                                                        status_data, "tyres_wear_rl", 0
                                                    ),
                                                    getattr(
                                                        status_data, "tyres_wear_rr", 0
                                                    ),
                                                    getattr(
                                                        status_data, "tyres_wear_fl", 0
                                                    ),
                                                    getattr(
                                                        status_data, "tyres_wear_fr", 0
                                                    ),
                                                ],
                                                "tyreCompound": getattr(
                                                    status_data,
                                                    "actual_tyre_compound",
                                                    0,
                                                ),
                                                "vehicleFiaFlags": getattr(
                                                    status_data, "vehicle_fia_flags", 0
                                                ),
                                            }
                                        )
                            logger.debug(
                                f"Updated car status data for {len(packet.car_status_data)} cars"
                            )
                else:
                    logger.warning(
                        f"Received packet (type: {type(packet)}) but it has no 'header' attribute. Cannot determine packet_id."
                    )

            except socket.timeout:
                continue
            except Exception as e:
                if stop_event.is_set():
                    print(
                        "Telemetry worker: socket error during stop signal, likely normal."
                    )
                    break
                # One bad/unknown packet (e.g. an unrecognised packet type) must
                # not kill the whole listener. Record the error and keep going so
                # the next valid packet is still processed.
                listener_error = f"Error in telemetry worker: {type(e).__name__}: {e}"
                print(f"ERROR IN TELEMETRY WORKER: {listener_error}")
                traceback.print_exc()
                continue

        print("UDP Telemetry listener worker signaled to stop or errored.")

    except Exception as e:
        listener_error = (
            f"Failed to start/run telemetry listener: {type(e).__name__}: {e}"
        )
        print(f"ERROR STARTING TELEMETRY LISTENER: {listener_error}")
        traceback.print_exc()
    finally:
        if (
            listener_instance
            and hasattr(listener_instance, "socket")
            and listener_instance.socket
        ):
            print("Closing telemetry listener socket.")
            listener_instance.socket.close()
        print("Telemetry listener worker finished.")


def _clear_listener_state():
    global listener_thread, listener_stop_event, listener_port, listener_host, listener_error, active_drivers_count
    global latest_car_positions, participant_data_store, session_data_store, enhanced_session_data_store, lap_data_store
    global packets_processed_count, packets_filtered_count, _last_auto_set_track_id

    listener_thread = None
    listener_stop_event = None
    listener_port = None
    listener_host = None
    listener_error = None
    active_drivers_count = 0

    # Reset telemetry data stores
    latest_car_positions = [{} for _ in range(22)]
    participant_data_store = [{} for _ in range(22)]
    session_data_store = {}
    enhanced_session_data_store = {}
    lap_data_store = [{} for _ in range(22)]
    # Clearing the sources also drops their per-source auto-save tracking, so a
    # fresh start does not carry over any old lap state.
    with telemetry_sources_lock:
        telemetry_sources.clear()

    # Reset performance counters
    packets_processed_count = 0
    packets_filtered_count = 0

    # Forget the auto-detected track so a fresh start re-detects it from the
    # first SessionData packet of the new session.
    _last_auto_set_track_id = None


@telemetry_router.post("/start", response_model=StartResponse)
async def start_telemetry(port: int = Query(20777, ge=1024, le=65535)):
    global listener_thread, listener_stop_event, listener_port, listener_host, listener_error, active_drivers_count

    # Get desired host from environment variable, default to 0.0.0.0
    desired_host = os.getenv("F1_TELEMETRY_LISTENER_HOST", "0.0.0.0")

    if not F1_TELEMETRY_AVAILABLE:
        raise HTTPException(
            status_code=500,
            detail="F1 Telemetry library (f1_24_telemetry) is not installed or available.",
        )

    if listener_thread and listener_thread.is_alive():
        raise HTTPException(
            status_code=400,
            detail=f"Telemetry listener is already running on host {listener_host}, port {listener_port}",
        )

    _clear_listener_state()  # Clear any previous error state before starting
    listener_port = port
    listener_host = desired_host
    listener_stop_event = threading.Event()

    listener_thread = threading.Thread(
        target=telemetry_listener_worker,
        args=(listener_host, listener_port, listener_stop_event),
        daemon=True,
    )
    listener_thread.start()

    await asyncio.sleep(0.5)  # Give thread a moment to initialize

    if listener_error:  # Check if worker thread set an error during startup
        initial_error = listener_error
        _clear_listener_state()
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start telemetry listener: {initial_error}",
        )

    if not listener_thread.is_alive():
        _clear_listener_state()
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start telemetry listener: Thread did not start.",
        )

    local_ip = get_local_ip()
    return StartResponse(
        message=f"UDP telemetry listener started on host {listener_host}, port {listener_port}",
        host=listener_host,
        port=listener_port,
    )


@telemetry_router.post("/stop")
async def stop_telemetry():
    global listener_thread, listener_stop_event

    if not listener_thread or not listener_thread.is_alive() or not listener_stop_event:
        raise HTTPException(
            status_code=400, detail="Telemetry listener is not running."
        )

    print("Attempting to stop telemetry listener...")
    listener_stop_event.set()
    listener_thread.join(timeout=3.0)  # Wait for the thread to finish

    if listener_thread.is_alive():
        print("Telemetry listener thread did not stop gracefully after timeout.")
        # Thread is daemon, so it will be killed if main app exits.
        # Forcing a socket close might be an option if we had direct access from here.
        # The worker itself tries to close its socket on stop_event.
        # Not raising an error here, but logging it.
        # Client will see success, but server might have lingering thread until socket timeout.

    final_error = (
        listener_error  # Capture error that might have occurred during shutdown
    )
    _clear_listener_state()
    print("Telemetry listener stop process completed.")

    response_message = "UDP telemetry listener stopped."
    if final_error and "Error in telemetry worker" not in final_error:
        # If error is not just a normal stop-related socket error
        response_message += (
            f" Note: An error occurred during operation or shutdown: {final_error}"
        )

    return {"message": response_message}


@telemetry_router.get("/status", response_model=TelemetryStatus)
async def get_telemetry_status():
    is_running = listener_thread is not None and listener_thread.is_alive()
    total_active_drivers = (
        sum(
            source.get("active_drivers_count", 0)
            for source in telemetry_sources.values()
            if isinstance(source.get("active_drivers_count", 0), int)
        )
        if telemetry_sources
        else active_drivers_count
    )

    # Ensure error is cleared if not running and no specific stop error occurred
    current_error = listener_error
    if (
        not is_running
        and current_error == "Failed to start/run telemetry listener: timed out"
    ):
        current_error = None  # Clear timeout error if not running

    logger.debug(
        f"[get_telemetry_status] is_running: {is_running}, current active_drivers_count global: {active_drivers_count}"
    )
    return TelemetryStatus(
        running=is_running,
        host=listener_host if is_running else None,
        port=listener_port if is_running else None,
        active_drivers=total_active_drivers if is_running else 0,
        error=current_error,
    )


@telemetry_router.get("/session", response_model=SessionConditions)
async def get_session_conditions():
    """Return the live track conditions (weather, temperatures, time of day).

    These come from the F1 24 session packet and are shown as markers in the
    top-right of the track map. Until a session packet arrives the values are
    null and "available" is false, so the dashboard simply hides the markers.
    """
    weather = enhanced_session_data_store.get("weather")
    track_temperature = enhanced_session_data_store.get("trackTemperature")
    air_temperature = enhanced_session_data_store.get("airTemperature")
    time_of_day = enhanced_session_data_store.get("timeOfDay")

    # We treat the conditions as available only once a session packet has filled
    # in the temperatures, so the markers stay hidden before any data arrives.
    has_conditions = track_temperature is not None and air_temperature is not None

    weather_name = None
    if weather is not None:
        weather_name = get_weather_name(weather)

    return SessionConditions(
        available=has_conditions,
        weather=weather,
        weatherName=weather_name,
        trackTemperature=track_temperature,
        airTemperature=air_temperature,
        timeOfDay=time_of_day,
    )


@telemetry_router.post("/raw/capture")
async def set_raw_capture(capture_input: RawCaptureInput):
    """Turn raw packet capture on or off for the /raw debug endpoint.

    Capture is off by default to save CPU on the listener thread. Send
    {"enabled": true} to start capturing, then read /raw; send {"enabled": false}
    to stop. The setting takes effect on the next packet the listener handles.
    """
    global raw_capture_enabled
    raw_capture_enabled = capture_input.enabled
    return {"raw_capture_enabled": raw_capture_enabled}


@telemetry_router.get("/raw")
async def get_raw_telemetry():
    """Debug endpoint: return the latest raw packet of every type the game sends.

    Raw capture is OFF by default; turn it on with
    POST /api/telemetry/raw/capture {"enabled": true} (and start the listener with
    F1 24 sending telemetry). While capture is off, "sources" stays empty.

    "sources" is grouped by the source IP that sent the packets, then by
    packet_id. Every field of every packet is included (positions, full car
    telemetry, damage, tyre sets, classification, and so on), so this shows all
    of the data we receive over UDP, not just what the dashboard uses.
    """
    # Snapshot the sources under the lock so the background listener thread
    # cannot add a new source (or a new packet type) while we are reading.
    with telemetry_sources_lock:
        source_items = list(telemetry_sources.items())

        result = {}
        for source_id, source_state in source_items:
            raw_packets = source_state.get("raw_packets", {})
            packets_for_source = {}
            for packet_id in raw_packets:
                # The packet_id is an int; use a string key so it is valid JSON.
                packets_for_source[str(packet_id)] = raw_packets[packet_id]
            result[source_id] = packets_for_source

    return {"raw_capture_enabled": raw_capture_enabled, "sources": result}


