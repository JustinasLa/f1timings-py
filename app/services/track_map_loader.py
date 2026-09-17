import csv
import json
import os
import logging
from pathlib import Path
from typing import Optional, List, Dict, Tuple
from app.models.data_models import TrackData, TrackPoint
import math

# Configure logging
logger = logging.getLogger(__name__)

# Pre-built track data (outline + sector markers) made from FastF1 by the
# scripts/fetch_fastf1_*.py scripts. This is the only track-map source used at
# runtime; it is accurate and already includes the start/finish and sector-split
# markers. The geojson/ directory is no longer read at runtime — it is only used
# offline by the fetch_fastf1 script to calibrate the data it bakes into here.
TRACK_DATA_DIR = Path("track_data")


class TrackService:
    """Service for loading and parsing track data files."""

    def __init__(self):
        self.track_cache: Dict[str, TrackData] = {}

    @staticmethod
    def lat_lng_to_local_coordinates(
        lat: float,
        lng: float,
        center_lat: float,
        center_lng: float,
        scale: float = 1000,
        rotation_degrees: float = 0,
    ) -> Tuple[float, float]:
        """
        Convert latitude/longitude to local X/Z coordinates relative to a center point.

        Args:
            lat, lng: Point coordinates
            center_lat, center_lng: Center reference point
            scale: Scale factor to convert to game-like coordinates (default 1000 for meters)
            rotation_degrees: Rotation angle in degrees (positive = clockwise, negative = counter-clockwise)

        Returns:
            Tuple of (x, z) coordinates
        """
        # Convert degrees to radians
        lat_rad = math.radians(lat)
        lng_rad = math.radians(lng)
        center_lat_rad = math.radians(center_lat)
        center_lng_rad = math.radians(center_lng)

        # Earth radius in meters
        R = 6371000

        # Calculate differences
        dlat = lat_rad - center_lat_rad
        dlng = lng_rad - center_lng_rad

        # Convert to local coordinates (x = longitude difference, z = latitude difference)
        x_raw = dlng * R * math.cos(center_lat_rad) * scale / 1000
        z_raw = dlat * R * scale / 1000

        # Apply rotation if specified
        if rotation_degrees != 0:
            rotation_rad = math.radians(rotation_degrees)
            cos_rot = math.cos(rotation_rad)
            sin_rot = math.sin(rotation_rad)

            # Rotate coordinates
            x = x_raw * cos_rot - z_raw * sin_rot
            z = x_raw * sin_rot + z_raw * cos_rot
        else:
            x = x_raw
            z = z_raw

        return x, z

    def get_available_tracks(self) -> List[str]:
        """Get list of available track names from the pre-built track data files."""
        available_tracks = set()

        if TRACK_DATA_DIR.exists():
            for file_path in TRACK_DATA_DIR.glob("*.json"):
                available_tracks.add(file_path.stem)

        return sorted(available_tracks)

    def find_matching_track_name(self, input_track_name: str) -> Optional[str]:
        """
        Find the best matching track name from available tracks using case-insensitive matching
        with comprehensive alias support.

        Args:
            input_track_name: The track name to match (can be any case)

        Returns:
            The actual track name from available tracks, or None if no match found
        """
        if not input_track_name:
            return None

        available_tracks = self.get_available_tracks()
        input_normalized = input_track_name.lower().replace(" ", "_").replace("-", "_")

        # Track aliases mapping - common names to actual track file names
        track_aliases = {
            # Country/Location based aliases
            "australia": "australia",
            "australian": "australia",
            "austria": "austria",
            "austrian": "austria",
            "azerbaijan": "azerbaijan",
            "bahrain": "bahrain",
            "bahraini": "bahrain",
            "belgium": "belgium",
            "belgian": "belgium",
            "brazil": "brazil",
            "brazilian": "brazil",
            "canada": "canada",
            "canadian": "canada",
            "china": "china",
            "chinese": "china",
            "germany": "hungary",  # Note: No German GP in current files
            "hungary": "hungary",
            "hungarian": "hungary",
            "italy": "monza",
            "italian": "monza",
            "japan": "japan",
            "japanese": "japan",
            "mexico": "mexico",
            "mexican": "mexico",
            "netherlands": "netherlands",
            "dutch": "netherlands",
            "qatar": "qatar",
            "saudi_arabia": "saudi_arabia",
            "saudi": "saudi_arabia",
            "singapore": "singapore",
            "spain": "spain",
            "spanish": "spain",
            "uk": "great_britain",
            "britain": "great_britain",
            "british": "great_britain",
            "england": "great_britain",
            "usa": "texas",
            "united_states": "texas",
            "america": "texas",
            "american": "texas",
            "uae": "abu_dhabi",
            "emirates": "abu_dhabi",
            # Circuit/Track name aliases
            "albert_park": "australia",
            "red_bull_ring": "austria",
            "spielberg": "austria",
            "baku_city_circuit": "azerbaijan",
            "bahrain_international_circuit": "bahrain",
            "spa_francorchamps": "belgium",
            "francorchamps": "belgium",
            "interlagos": "brazil",
            "sao_paulo": "brazil",
            "gilles_villeneuve": "canada",
            "montreal": "canada",
            "shanghai_international_circuit": "china",
            "hungaroring": "hungary",
            "budapest": "hungary",
            "autodromo_nazionale_monza": "monza",
            "suzuka_circuit": "japan",
            "autodromo_hermanos_rodriguez": "mexico",
            "mexico_city": "mexico",
            "circuit_zandvoort": "netherlands",
            "losail_international_circuit": "qatar",
            "doha": "qatar",
            "jeddah_corniche_circuit": "saudi_arabia",
            "marina_bay": "singapore",
            "singapore_street_circuit": "singapore",
            "circuit_de_catalunya": "spain",
            "barcelona": "spain",
            "silverstone_circuit": "great_britain",
            "yas_marina": "abu_dhabi",
            "yas_marina_circuit": "abu_dhabi",
            "circuit_of_the_americas": "texas",
            "cota": "texas",
            "austin": "texas",
            "imola_circuit": "imola",
            "autodromo_enzo_e_dino_ferrari": "imola",
            "san_marino": "imola",
            "las_vegas_strip": "las_vegas",
            "vegas": "las_vegas",
            "strip": "las_vegas",
            "miami_international_autodrome": "miami",
            "hard_rock_stadium": "miami",
            "monaco_street_circuit": "monaco",
            "monte_carlo": "monaco",
            "circuit_de_monaco": "monaco",
        }

        # First try alias matching
        for alias, actual_track in track_aliases.items():
            if input_normalized == alias or input_normalized.replace(
                "_", ""
            ) == alias.replace("_", ""):
                # Check if the actual track exists in available tracks
                for track in available_tracks:
                    if track.lower() == actual_track.lower():
                        logger.debug(
                            f"Alias match found for '{input_track_name}' -> '{alias}' -> '{track}'"
                        )
                        return track

        # Second, try exact match (case-insensitive)
        for track in available_tracks:
            if track.lower() == input_normalized:
                logger.debug(f"Exact match found for '{input_track_name}': '{track}'")
                return track

        # Third, try partial matching - check if input is contained in any track name
        for track in available_tracks:
            track_normalized = track.lower().replace(" ", "_").replace("-", "_")
            if (
                input_normalized in track_normalized
                or track_normalized in input_normalized
            ):
                logger.debug(f"Partial match found for '{input_track_name}': '{track}'")
                return track

        # Fourth, try matching without common prefixes/suffixes
        cleaned_input = (
            input_normalized.replace("circuit", "")
            .replace("track", "")
            .replace("street", "")
            .replace("international", "")
            .strip("_")
        )
        for track in available_tracks:
            cleaned_track = (
                track.lower()
                .replace("circuit", "")
                .replace("track", "")
                .replace("street", "")
                .replace("international", "")
                .strip("_")
            )
            if cleaned_input == cleaned_track:
                logger.debug(f"Cleaned match found for '{input_track_name}': '{track}'")
                return track

        logger.warning(
            f"No matching track found for '{input_track_name}' in available tracks: {available_tracks}"
        )
        return None

    def parse_geojson_file(self, file_path: Path) -> Optional[TrackData]:
        """Parse a GeoJSON track file and return TrackData."""
        try:
            with open(file_path, "r", encoding="utf-8") as file:
                geojson_data = json.load(file)

            if geojson_data.get("type") != "FeatureCollection":
                logger.error(f"GeoJSON file {file_path} is not a FeatureCollection")
                return None

            features = geojson_data.get("features", [])
            if not features:
                logger.error(f"No features found in GeoJSON file {file_path}")
                return None

            # Use the first feature (assuming it's the track)
            feature = features[0]
            geometry = feature.get("geometry", {})
            properties = feature.get("properties", {})

            if geometry.get("type") != "LineString":
                logger.error(f"GeoJSON feature is not a LineString in {file_path}")
                return None

            coordinates = geometry.get("coordinates", [])
            if not coordinates:
                logger.error(f"No coordinates found in GeoJSON file {file_path}")
                return None

            # Get track metadata
            track_name = file_path.stem
            track_info = f"Track: {properties.get('Name', track_name)}, Location: {properties.get('Location', 'Unknown')}"
            if properties.get("length"):
                track_info += f", Length: {properties.get('length')}m"

            # Calculate center point for coordinate conversion
            lats = [coord[1] for coord in coordinates]
            lngs = [coord[0] for coord in coordinates]
            center_lat = (min(lats) + max(lats)) / 2
            center_lng = (min(lngs) + max(lngs)) / 2

            logger.debug(
                f"Track center: lat={center_lat}, lng={center_lng}"
            )  # Convert coordinates to track points
            points = []
            total_distance = 0.0

            # Determine rotation based on track name - some tracks shouldn't be rotated
            rotation_degrees = 90  # Default rotation
            no_rotation_tracks = [
                "portimao",
            ]  # Tracks that shouldn't be rotated
            fifteen_rotation_tracks = [  # unsure yet
                "abu_dhabi",
            ]
            if track_name.lower() in no_rotation_tracks:
                rotation_degrees = 0
            if track_name.lower() in fifteen_rotation_tracks:
                rotation_degrees = 15

            for i, (lng, lat) in enumerate(coordinates):
                # Convert lat/lng to local coordinates with track-specific rotation
                x, z = self.lat_lng_to_local_coordinates(
                    lat, lng, center_lat, center_lng, rotation_degrees=rotation_degrees
                )  # Calculate distance along track
                if i > 0:
                    prev_x, prev_z = self.lat_lng_to_local_coordinates(
                        coordinates[i - 1][1],
                        coordinates[i - 1][0],
                        center_lat,
                        center_lng,
                        rotation_degrees=rotation_degrees,  # Use same rotation for consistency
                    )
                    distance_increment = math.sqrt(
                        (x - prev_x) ** 2 + (z - prev_z) ** 2
                    )
                    total_distance += distance_increment

                # Create track point (using defaults for missing data)
                point = TrackPoint(
                    dist=total_distance,
                    pos_x=x,
                    pos_y=0.0,  # GeoJSON doesn't have elevation, default to 0
                    pos_z=z,
                    drs=0,  # No DRS data in GeoJSON, default to 0
                )
                points.append(point)

            if not points:
                logger.error(f"No valid track points generated from {file_path}")
                return None

            track_data = TrackData(
                name=track_name,
                track_info=track_info,
                points=points,
            )

            logger.debug(
                f"Successfully parsed GeoJSON track '{track_name}' with {len(points)} points"
            )
            return track_data

        except Exception as e:
            logger.error(f"Error parsing GeoJSON file {file_path}: {e}")
            return None

    def load_baked_track_data(self, track_name: str) -> Optional[TrackData]:
        """Load pre-built track data (made from FastF1) if a file exists for it.

        Returns TrackData with the outline and sector markers, or None when
        there is no pre-built file for this track.
        """
        normalized_name = track_name.lower().replace(" ", "_")
        baked_file = TRACK_DATA_DIR / f"{normalized_name}.json"
        if not baked_file.exists():
            return None

        try:
            with open(baked_file, "r", encoding="utf-8") as file:
                data = json.load(file)
            track_data = TrackData(**data)
            logger.debug(
                f"Loaded pre-built track data for '{track_name}' from {baked_file}"
            )
            return track_data
        except Exception as error:
            logger.error(f"Error reading pre-built track file {baked_file}: {error}")
            return None

    async def load_track_data(self, track_name: str) -> Optional[TrackData]:
        """Load track data for a given track name, with caching."""
        if not track_name:
            return None

        # Resolve the requested name to a real track first. This applies the
        # alias table (so e.g. "British" or "Silverstone" find great_britain),
        # keys the cache on one canonical name (no duplicate entries per casing),
        # and—because the result is always an existing track file stem—stops a
        # crafted name like "../../secret" from ever reaching the filesystem.
        matched_track_name = self.find_matching_track_name(track_name)
        if not matched_track_name:
            logger.warning(f"No track data for '{track_name}': no matching track")
            return None

        # Check cache first (keyed on the resolved name).
        if matched_track_name in self.track_cache:
            logger.debug(f"Returning cached track data for '{matched_track_name}'")
            return self.track_cache[matched_track_name]

        # Load the pre-built FastF1 track data (outline + sector markers). Every
        # supported track has a file in track_data/, so this is the only source
        # used at runtime.
        baked_track_data = self.load_baked_track_data(matched_track_name)
        if baked_track_data:
            self.track_cache[matched_track_name] = baked_track_data
            return baked_track_data

        logger.warning(f"No pre-built track data for '{matched_track_name}'")
        return None

    def clear_cache(self):
        """Clear the track data cache."""
        self.track_cache.clear()
        logger.debug("Track data cache cleared")


# Global track service instance
track_service = TrackService()
