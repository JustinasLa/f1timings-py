"""One-time script: build F1 track data from FastF1, aligned to the game frame.

For each track this downloads a FastF1 session, takes the fastest lap, and builds the
track outline plus the start/finish and sector-split markers.

FastF1's position data is in its own coordinate system (units of about 1/10 of a
metre, rotated to point north-up). The live dashboard, however, draws driver dots
using the F1 24 game's world coordinates (in metres), and the per-track offsets in
static/js/dashboard-settings.js were tuned against the GeoJSON outline, which is already
in that game frame. So a raw FastF1 outline does not line up with the live dots.

To fix that, after building the FastF1 outline we calibrate it: we find the single
scale + rotation + shift that best lays the FastF1 shape on top of the existing
track's geojson outline, then apply that same transform to both the outline
points and the markers. The result is written in the game frame, so the live driver
dots trace it (using the existing dashboard-settings.js offsets) while keeping the accurate
FastF1 sector markers.

Run with:  python scripts/fetch_fastf1_tracks.py  (or pass one track name)

It needs internet the first time (FastF1 downloads the session and caches it).
The output is saved to track_data/<track>.json.
"""

import json
import math
import os
import sys
from pathlib import Path

import fastf1
import pandas

# Make sure the repo root is importable when this file is run directly
# (running a script puts its own folder on the path, not the project root).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

# The app's geojson parser gives us the outline in the game frame to calibrate against.
from app.services.track_map_loader import track_service


# Every track we build, as (track key, FastF1 season, FastF1 event). The track
# key is the country-based name used everywhere (geojson/, track_data/,
# track_times/ and the dashboard settings); the event is what FastF1 matches the
# session by. Qualifying is used for all of them (clean, fast laps).
SESSION = "Q"
TRACKS = [
    ("abu_dhabi", 2024, "Abu Dhabi"),
    ("australia", 2024, "Australia"),
    ("austria", 2024, "Austria"),
    ("azerbaijan", 2024, "Azerbaijan"),
    ("bahrain", 2024, "Bahrain"),
    ("belgium", 2024, "Belgium"),
    ("brazil", 2024, "Brazil"),
    ("canada", 2024, "Canada"),
    ("china", 2024, "China"),
    ("great_britain", 2024, "British Grand Prix"),
    ("hungary", 2024, "Hungary"),
    ("imola", 2024, "Emilia Romagna"),
    ("japan", 2024, "Japan"),
    ("las_vegas", 2024, "Las Vegas"),
    ("mexico", 2024, "Mexico City"),
    ("miami", 2024, "Miami"),
    ("monaco", 2024, "Monaco"),
    ("monza", 2024, "Italy"),
    ("netherlands", 2024, "Netherlands"),
    ("portugal", 2021, "Portugal"),
    ("qatar", 2024, "Qatar"),
    ("saudi_arabia", 2024, "Saudi Arabia"),
    ("singapore", 2024, "Singapore"),
    ("spain", 2024, "Spain"),
    ("texas", 2024, "United States"),
]

# Where to keep FastF1's download cache, and where to write our output.
CACHE_DIR = "fastf1_cache"
OUTPUT_DIR = "track_data"

# How many evenly spaced points to resample each outline to when calibrating.
# More points = a more accurate fit, but a slower (one-time) calibration.
CALIBRATION_POINTS = 240

# When tracing the pit lane we get one telemetry point every fraction of a
# second, so the car sitting in its pit box produces a big cluster of points in
# one spot. We drop points closer together than this (in FastF1 units, about a
# tenth of a metre each) so the pit lane comes out as a clean line. About 60
# units is roughly 6 metres.
MIN_PIT_POINT_GAP = 60.0

# PitInTime / PitOutTime mark where the car crosses the pit entry/exit lines,
# which sit a little off the racing line. If we traced only between them, the
# pit lane would start and end floating beside the track. So we widen the window
# by this many seconds on each side to capture the real path as the car peels
# off the racing line into the pits and rejoins it on the way out.
PIT_WINDOW_PAD_SECONDS = 5.0

# After widening, the ends now run along the racing line. We trim them back to
# the point where the path is still within this distance (in game-frame units,
# roughly metres) of the outline, so the drawn pit lane starts/ends right on the
# track and tucks under the white line, without a long stretch laid over it.
PIT_MERGE_DISTANCE = 10.0

# A real pit entry/exit is a straight slip road that joins the pit lane at a
# shallow angle. We replace each traced end with such a straight line. To pick
# where it rejoins the pit lane, we search anchor points this many positions in
# from the end (deeper = longer, shallower slip road) and take the first whose
# join angle is at or below MERGE_JUNCTION_DEGREES (otherwise the shallowest).
MERGE_MIN_ANCHOR = 4
MERGE_MAX_ANCHOR = 24
MERGE_JUNCTION_DEGREES = 15.0

# While the car sits stationary in its pit box, the position telemetry jitters
# by a few metres, which can leave little back-and-forth spikes in the traced
# line. A real pit lane never turns this sharply between two points, so we drop
# any point whose turn is sharper than this (in degrees) to de-spike the line.
MAX_PIT_TURN_DEGREES = 90.0

# Telemetry is sampled sparsely, so a smooth curve (like the pit entry peeling
# off the track) can come out looking angular. We run a small moving-average
# over the interior points to round those corners. Must be an odd number; the
# first and last (window // 2) points are left untouched.
PIT_SMOOTH_WINDOW = 3

# We do not trust a single driver's line through the pits. Instead we trace
# every driver's pit visit in the session and average them into one centerline.
# Each trace needs at least this many points to be used.
MIN_PIT_TRACE_POINTS = 8

# All the kept traces are resampled to this many evenly spaced points so they
# can be averaged position by position.
PIT_RESAMPLE_POINTS = 90

# Before averaging, drop any trace whose length differs from the typical (median)
# length by more than this fraction. This throws out mis-traced or odd pit
# visits (for example a driver who pulled into the garage differently).
PIT_LENGTH_TOLERANCE = 0.25

def rotate_point(x, y, angle_degrees):
    """Rotate a point around the origin by the given angle (in degrees)."""
    angle = math.radians(angle_degrees)
    cos_angle = math.cos(angle)
    sin_angle = math.sin(angle)
    rotated_x = x * cos_angle - y * sin_angle
    rotated_y = x * sin_angle + y * cos_angle
    return rotated_x, rotated_y


def to_local_coordinates(fastf1_x, fastf1_y, rotation_degrees):
    """Turn a FastF1 X/Y point into the app's pos_x / pos_z coordinates.

    We rotate so the track points north-up, then map the result so the app
    draws it the right way round (east to the right, north at the top).
    """
    rotated_x, rotated_y = rotate_point(fastf1_x, fastf1_y, rotation_degrees)
    # The app draws pos_z left-to-right and pos_x top-to-bottom (with larger
    # values lower on screen), so we flip the north axis to put north on top.
    pos_z = rotated_x
    pos_x = -rotated_y
    return pos_x, pos_z


def find_position_at_session_time(pos_data, session_time):
    """Find the X/Y in the position data closest to the given session time."""
    best_x = None
    best_y = None
    smallest_gap = None

    for _, row in pos_data.iterrows():
        gap = abs((row["SessionTime"] - session_time).total_seconds())
        if smallest_gap is None or gap < smallest_gap:
            smallest_gap = gap
            best_x = row["X"]
            best_y = row["Y"]

    return best_x, best_y


def loop_length(points):
    """Total length around a closed loop of (x, z) points (last connects to first)."""
    total = 0.0
    count = len(points)
    for i in range(count):
        current = points[i]
        next_point = points[(i + 1) % count]
        dx = next_point[0] - current[0]
        dz = next_point[1] - current[1]
        total = total + math.sqrt(dx * dx + dz * dz)
    return total


def resample_closed_loop(points, sample_count):
    """Return sample_count points spaced evenly by distance around a closed loop.

    This lets us compare two outlines that have different numbers of points: both
    get reduced to the same number of evenly spaced points.
    """
    point_count = len(points)
    total_length = loop_length(points)
    if total_length == 0:
        return list(points)

    step = total_length / sample_count

    # For each segment (points[i] -> points[i+1], wrapping at the end) record where
    # it starts along the loop and how long it is.
    segment_start_distance = []
    segment_length = []
    running_distance = 0.0
    for i in range(point_count):
        current = points[i]
        next_point = points[(i + 1) % point_count]
        dx = next_point[0] - current[0]
        dz = next_point[1] - current[1]
        length = math.sqrt(dx * dx + dz * dz)
        segment_start_distance.append(running_distance)
        segment_length.append(length)
        running_distance = running_distance + length

    # Walk along the loop, dropping a sample at each multiple of `step`.
    samples = []
    segment_index = 0
    for k in range(sample_count):
        target_distance = k * step

        # Advance to the segment that contains this target distance.
        while (
            segment_index < point_count - 1
            and segment_start_distance[segment_index] + segment_length[segment_index]
            < target_distance
        ):
            segment_index = segment_index + 1

        current = points[segment_index]
        next_point = points[(segment_index + 1) % point_count]
        length = segment_length[segment_index]
        if length == 0:
            fraction = 0.0
        else:
            fraction = (target_distance - segment_start_distance[segment_index]) / length

        sample_x = current[0] + (next_point[0] - current[0]) * fraction
        sample_z = current[1] + (next_point[1] - current[1]) * fraction
        samples.append((sample_x, sample_z))

    return samples


def centroid(points):
    """Average position of a list of (x, z) points."""
    sum_x = 0.0
    sum_z = 0.0
    for point in points:
        sum_x = sum_x + point[0]
        sum_z = sum_z + point[1]
    count = len(points)
    return sum_x / count, sum_z / count


def center_points(points, center):
    """Move points so the given center sits at the origin."""
    centered = []
    for point in points:
        centered.append((point[0] - center[0], point[1] - center[1]))
    return centered


def rms_radius(points):
    """Root-mean-square distance of points from the origin (a size measure)."""
    total = 0.0
    for point in points:
        total = total + point[0] * point[0] + point[1] * point[1]
    return math.sqrt(total / len(points))


def best_alignment(source_points, target_points):
    """Find the scale, rotation and centers that best map source onto target.

    Both inputs are closed loops. We resample both to the same number of evenly
    spaced points, match their sizes and centers, then try every starting offset
    (and both travel directions) to find the rotation with the smallest error.

    Returns a dictionary describing the transform so it can be applied to any point.
    """
    source_samples = resample_closed_loop(source_points, CALIBRATION_POINTS)
    target_samples = resample_closed_loop(target_points, CALIBRATION_POINTS)

    source_center = centroid(source_samples)
    target_center = centroid(target_samples)

    source_centered = center_points(source_samples, source_center)
    target_centered = center_points(target_samples, target_center)

    # Scale the source so it is the same overall size as the target.
    source_size = rms_radius(source_centered)
    target_size = rms_radius(target_centered)
    scale = target_size / source_size

    scaled_source = []
    for point in source_centered:
        scaled_source.append((point[0] * scale, point[1] * scale))

    count = CALIBRATION_POINTS
    best_error = None
    best_rotation = 0.0

    # Try both directions, because the two outlines may run opposite ways.
    for reverse in [False, True]:
        if reverse:
            ordered_source = list(reversed(scaled_source))
        else:
            ordered_source = scaled_source

        # Try every starting offset around the loop.
        for shift in range(count):
            # For this pairing, the best rotation has a direct formula.
            sum_dot = 0.0
            sum_cross = 0.0
            for i in range(count):
                a = ordered_source[(i + shift) % count]
                b = target_centered[i]
                sum_dot = sum_dot + a[0] * b[0] + a[1] * b[1]
                sum_cross = sum_cross + a[0] * b[1] - a[1] * b[0]
            rotation = math.atan2(sum_cross, sum_dot)

            # Measure how well that rotation lines the two loops up.
            cos_r = math.cos(rotation)
            sin_r = math.sin(rotation)
            error = 0.0
            for i in range(count):
                a = ordered_source[(i + shift) % count]
                rotated_x = a[0] * cos_r - a[1] * sin_r
                rotated_z = a[0] * sin_r + a[1] * cos_r
                b = target_centered[i]
                dx = rotated_x - b[0]
                dz = rotated_z - b[1]
                error = error + dx * dx + dz * dz

            if best_error is None or error < best_error:
                best_error = error
                best_rotation = rotation

    transform = {
        "source_center": source_center,
        "target_center": target_center,
        "scale": scale,
        "rotation": best_rotation,
    }
    return transform


def apply_transform(pos_x, pos_z, transform):
    """Map a single (pos_x, pos_z) point through the calibrated transform."""
    # 1) move the source center to the origin
    shifted_x = pos_x - transform["source_center"][0]
    shifted_z = pos_z - transform["source_center"][1]
    # 2) scale to match the target size
    scaled_x = shifted_x * transform["scale"]
    scaled_z = shifted_z * transform["scale"]
    # 3) rotate
    cos_r = math.cos(transform["rotation"])
    sin_r = math.sin(transform["rotation"])
    rotated_x = scaled_x * cos_r - scaled_z * sin_r
    rotated_z = scaled_x * sin_r + scaled_z * cos_r
    # 4) move onto the target center
    result_x = rotated_x + transform["target_center"][0]
    result_z = rotated_z + transform["target_center"][1]
    return result_x, result_z


def load_geojson_outline(geojson_file):
    """Load the geojson outline for this track as a list of (pos_x, pos_z) points.

    This is the game-frame shape we calibrate onto. We use the app's own parser so
    the frame matches exactly what the dashboard would otherwise draw.
    """
    geojson_path = Path(geojson_file)
    track_data = track_service.parse_geojson_file(geojson_path)
    if track_data is None:
        raise RuntimeError(
            "Could not parse " + geojson_file + " to calibrate against."
        )

    outline = []
    for point in track_data.points:
        outline.append((point.pos_x, point.pos_z))
    return outline


def remove_close_points(points, min_gap):
    """Drop points that are closer than min_gap to the last kept point.

    This thins out the big cluster of points recorded while the car sits in its
    pit box, so the pit lane comes out as a clean line instead of a blob.
    """
    if len(points) == 0:
        return []

    kept = []
    kept.append(points[0])
    last_kept = points[0]
    for i in range(1, len(points)):
        current = points[i]
        dx = current[0] - last_kept[0]
        dz = current[1] - last_kept[1]
        distance = math.sqrt(dx * dx + dz * dz)
        if distance >= min_gap:
            kept.append(current)
            last_kept = current
    return kept


def collect_pit_points(session, driver_number, pit_in_time, pit_out_time, rotation_degrees):
    """Trace the pit lane for one pit visit, in the FastF1 frame.

    Between PitInTime (crossing the pit-entry line) and PitOutTime (crossing the
    pit-exit line) the car is inside the pit lane the whole time, so the position
    telemetry over that window draws the pit lane: entry road, the box, then the
    exit road. We just read those X/Y points and rotate them like the outline.
    """
    position_data = session.pos_data[driver_number]

    # Keep only the rows recorded while the car was in the pit lane.
    in_pit_window = (position_data["SessionTime"] >= pit_in_time) & (
        position_data["SessionTime"] <= pit_out_time
    )
    pit_rows = position_data[in_pit_window]

    points = []
    for _, row in pit_rows.iterrows():
        pos_x, pos_z = to_local_coordinates(row["X"], row["Y"], rotation_degrees)
        points.append((pos_x, pos_z))
    return points


def turn_angle(a, b, c):
    """Turn angle in degrees at point b on the path a -> b -> c.

    0 means dead straight; 180 means the path reverses back on itself.
    """
    first_x = b[0] - a[0]
    first_z = b[1] - a[1]
    second_x = c[0] - b[0]
    second_z = c[1] - b[1]
    first_length = math.sqrt(first_x * first_x + first_z * first_z)
    second_length = math.sqrt(second_x * second_x + second_z * second_z)
    if first_length == 0 or second_length == 0:
        return 0.0
    dot = first_x * second_x + first_z * second_z
    cosine = dot / (first_length * second_length)
    if cosine > 1.0:
        cosine = 1.0
    if cosine < -1.0:
        cosine = -1.0
    return math.degrees(math.acos(cosine))


def remove_sharp_turns(points, max_angle_degrees):
    """Drop points where the path turns sharper than max_angle_degrees.

    This removes the little back-and-forth spikes left by position jitter while
    the car was stopped in its box, without touching the smooth parts of the
    line. After dropping a point we step back one so a spike of several points
    is cleaned up too.
    """
    result = list(points)
    i = 1
    while i < len(result) - 1:
        if turn_angle(result[i - 1], result[i], result[i + 1]) > max_angle_degrees:
            del result[i]
            if i > 1:
                i = i - 1
        else:
            i = i + 1
    return result


def smooth_path(points, window):
    """Round a path with a moving average, leaving the two ends in place.

    Each interior point is replaced by the average of itself and its neighbours
    within the window. The first and last (window // 2) points are kept exactly
    so the path still starts and ends where it did.
    """
    if window < 3 or len(points) <= window:
        return points

    half = window // 2
    result = list(points)
    for i in range(half, len(points) - half):
        sum_x = 0.0
        sum_z = 0.0
        for j in range(i - half, i + half + 1):
            sum_x = sum_x + points[j][0]
            sum_z = sum_z + points[j][1]
        result[i] = (sum_x / window, sum_z / window)
    return result


def nearest_outline_point(point, outline_points):
    """Return the outline point closest to the given (pos_x, pos_z) point."""
    best_point = outline_points[0]
    best_distance = None
    for outline_x, outline_z in outline_points:
        dx = point[0] - outline_x
        dz = point[1] - outline_z
        distance = math.sqrt(dx * dx + dz * dz)
        if best_distance is None or distance < best_distance:
            best_distance = distance
            best_point = (outline_x, outline_z)
    return best_point


def nearest_outline_distance(point, outline_points):
    """Smallest distance from a (pos_x, pos_z) point to any outline point."""
    nearest = nearest_outline_point(point, outline_points)
    dx = point[0] - nearest[0]
    dz = point[1] - nearest[1]
    return math.sqrt(dx * dx + dz * dz)


def trim_pitlane_ends(points, outline_points, merge_distance):
    """Trim the on-track run from both ends of the traced path.

    After widening the window the path starts and ends running along the racing
    line. We walk in from each end and drop those near-the-line points, keeping
    the last one within merge_distance of the outline as the join point. What is
    left is: join on the racing line -> peel into the pit lane -> box -> pit lane
    -> rejoin the racing line, which is exactly the path a car drives.
    """
    if len(points) == 0:
        return []

    # From the start, keep advancing while the path hugs the racing line; the
    # last such point is where it begins to peel off into the pit lane.
    start_index = 0
    i = 0
    while i < len(points) and nearest_outline_distance(points[i], outline_points) <= merge_distance:
        start_index = i
        i = i + 1

    # Same from the end, walking backwards to find where it rejoins the line.
    end_index = len(points) - 1
    j = len(points) - 1
    while j >= 0 and nearest_outline_distance(points[j], outline_points) <= merge_distance:
        end_index = j
        j = j - 1

    if start_index >= end_index:
        return points
    return points[start_index : end_index + 1]


def straighten_start_end(points, outline_points):
    """Turn the START of the pit lane into a straight slip road onto the track.

    A real pit entry/exit is a straight road that joins the pit lane at a shallow
    angle, not a curve. We pick the join point on the track (nearest outline
    point to the end) and look for how far down the pit lane (the "anchor") to
    aim so that a straight line from the join to the anchor meets the pit lane at
    a shallow angle. Then we replace the points before the anchor with that
    straight line. Only the start is handled; the caller reverses the list to do
    the other end.
    """
    last_anchor = min(MERGE_MAX_ANCHOR, len(points) - 2)
    if last_anchor < MERGE_MIN_ANCHOR:
        return points

    join = nearest_outline_point(points[0], outline_points)

    # Find the shallowest place to join. We prefer the first anchor whose join
    # angle is within the target; otherwise we keep the shallowest one we saw.
    chosen_anchor = MERGE_MIN_ANCHOR
    smallest_angle = None
    for anchor in range(MERGE_MIN_ANCHOR, last_anchor + 1):
        angle = turn_angle(join, points[anchor], points[anchor + 1])
        if smallest_angle is None or angle < smallest_angle:
            smallest_angle = angle
            chosen_anchor = anchor
        if angle <= MERGE_JUNCTION_DEGREES:
            chosen_anchor = anchor
            break

    # Replace points[0..chosen_anchor] with a straight line from the join to the
    # anchor, so the slip road is dead straight and starts exactly on the track.
    result = list(points)
    target = points[chosen_anchor]
    for i in range(0, chosen_anchor + 1):
        fraction = i / float(chosen_anchor)
        result[i] = (
            join[0] + (target[0] - join[0]) * fraction,
            join[1] + (target[1] - join[1]) * fraction,
        )
    return result


def straighten_merge_ends(points, outline_points):
    """Make both the entry and exit straight slip roads onto the track."""
    points = straighten_start_end(points, outline_points)
    points = list(reversed(points))
    points = straighten_start_end(points, outline_points)
    points = list(reversed(points))
    return points


def path_length(points):
    """Total length along an open path of (x, z) points."""
    total = 0.0
    for i in range(1, len(points)):
        dx = points[i][0] - points[i - 1][0]
        dz = points[i][1] - points[i - 1][1]
        total = total + math.sqrt(dx * dx + dz * dz)
    return total


def median_value(values):
    """Middle value of a list (average of the two middle ones if even count)."""
    if len(values) == 0:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def resample_path(points, count):
    """Return count points spaced evenly by distance along an open path.

    This lets several pit traces with different point counts be lined up and
    averaged: each is reduced to the same number of evenly spaced points.
    """
    if len(points) < 2 or count < 2:
        return list(points)

    cumulative = [0.0]
    for i in range(1, len(points)):
        dx = points[i][0] - points[i - 1][0]
        dz = points[i][1] - points[i - 1][1]
        cumulative.append(cumulative[-1] + math.sqrt(dx * dx + dz * dz))

    total = cumulative[-1]
    if total == 0:
        return list(points)

    step = total / (count - 1)
    result = []
    segment = 0
    for k in range(count):
        target = k * step
        while segment < len(points) - 2 and cumulative[segment + 1] < target:
            segment = segment + 1
        segment_length = cumulative[segment + 1] - cumulative[segment]
        if segment_length == 0:
            fraction = 0.0
        else:
            fraction = (target - cumulative[segment]) / segment_length
        x = points[segment][0] + (points[segment + 1][0] - points[segment][0]) * fraction
        z = points[segment][1] + (points[segment + 1][1] - points[segment][1]) * fraction
        result.append((x, z))
    return result


def build_one_pit_trace(
    session, driver_number, pit_in_time, pit_out_time, rotation_degrees, transform, outline_points
):
    """Trace, clean and trim one driver's pit visit into a game-frame path.

    Returns the list of (pos_x, pos_z) points (entry -> exit), or None if there
    was too little usable data. The ends are not straightened here; that happens
    once on the averaged centerline.
    """
    window_pad = pandas.Timedelta(seconds=PIT_WINDOW_PAD_SECONDS)
    raw_points = collect_pit_points(
        session,
        driver_number,
        pit_in_time - window_pad,
        pit_out_time + window_pad,
        rotation_degrees,
    )
    cleaned_points = remove_close_points(raw_points, MIN_PIT_POINT_GAP)
    if len(cleaned_points) < MIN_PIT_TRACE_POINTS:
        return None

    game_frame_points = []
    for raw_x, raw_z in cleaned_points:
        pos_x, pos_z = apply_transform(raw_x, raw_z, transform)
        game_frame_points.append((pos_x, pos_z))

    game_frame_points = remove_sharp_turns(game_frame_points, MAX_PIT_TURN_DEGREES)
    game_frame_points = smooth_path(game_frame_points, PIT_SMOOTH_WINDOW)
    trimmed_points = trim_pitlane_ends(game_frame_points, outline_points, PIT_MERGE_DISTANCE)
    if len(trimmed_points) < MIN_PIT_TRACE_POINTS:
        return None
    return trimmed_points


def average_pit_traces(traces):
    """Average several pit-lane traces into one representative centerline.

    Each trace runs entry -> exit. We drop traces whose length is far from the
    typical (median) length, resample the rest to the same number of evenly
    spaced points, and average position by position. This cancels the wandering
    of any single driver's line and the noise around their individual pit box.
    Returns the averaged points and how many traces were used.
    """
    lengths = []
    for trace in traces:
        lengths.append(path_length(trace))
    typical_length = median_value(lengths)

    kept_traces = []
    for trace, length in zip(traces, lengths):
        if typical_length == 0:
            kept_traces.append(trace)
        elif abs(length - typical_length) <= PIT_LENGTH_TOLERANCE * typical_length:
            kept_traces.append(trace)
    if len(kept_traces) == 0:
        kept_traces = traces

    resampled_traces = []
    for trace in kept_traces:
        resampled_traces.append(resample_path(trace, PIT_RESAMPLE_POINTS))

    averaged = []
    for i in range(PIT_RESAMPLE_POINTS):
        sum_x = 0.0
        sum_z = 0.0
        for trace in resampled_traces:
            sum_x = sum_x + trace[i][0]
            sum_z = sum_z + trace[i][1]
        averaged.append((sum_x / len(resampled_traces), sum_z / len(resampled_traces)))
    return averaged, len(kept_traces)


def build_pitlane(session, rotation_degrees, transform, outline_points):
    """Build the pit lane point list (in the final game frame) from telemetry.

    A single driver's line through the pits is unreliable, so we trace every
    driver's pit visit (an in-lap with a PitInTime followed by that driver's
    next lap, the out-lap, with a PitOutTime), clean each one, and average them
    into one centerline. We then replace the ends with straight slip roads that
    join the track. outline_points is the finished game-frame outline.
    """
    laps = session.laps

    traces = []
    for _, in_lap in laps.iterrows():
        pit_in_time = in_lap["PitInTime"]
        if pandas.isnull(pit_in_time):
            continue

        driver_number = in_lap["DriverNumber"]
        next_lap_number = in_lap["LapNumber"] + 1

        # Find this driver's next lap and check it is an out-lap (left the pits).
        out_lap = None
        for _, candidate_lap in laps.iterrows():
            if candidate_lap["DriverNumber"] != driver_number:
                continue
            if candidate_lap["LapNumber"] != next_lap_number:
                continue
            if pandas.isnull(candidate_lap["PitOutTime"]):
                continue
            out_lap = candidate_lap
            break

        if out_lap is None:
            continue

        trace = build_one_pit_trace(
            session,
            driver_number,
            pit_in_time,
            out_lap["PitOutTime"],
            rotation_degrees,
            transform,
            outline_points,
        )
        if trace is not None:
            traces.append(trace)

    if len(traces) == 0:
        print("No usable pit stop found; pit lane will be empty.")
        return []

    averaged_points, used_count = average_pit_traces(traces)

    # Replace each end with a dead-straight slip road that joins the track,
    # like a real pit entry/exit.
    averaged_points = straighten_merge_ends(averaged_points, outline_points)

    pitlane = []
    for pos_x, pos_z in averaged_points:
        pitlane.append({"pos_x": round(pos_x, 4), "pos_z": round(pos_z, 4)})

    print(
        "Pit lane averaged from "
        + str(used_count)
        + " of "
        + str(len(traces))
        + " driver pit visits: "
        + str(len(pitlane))
        + " points"
    )
    return pitlane


def build_one_track(track_name, season, event, session):
    """Build one track's data file from FastF1, calibrated to the game frame."""
    output_file = os.path.join(OUTPUT_DIR, track_name + ".json")
    geojson_file = os.path.join("geojson", track_name + ".geojson")

    print(f"Loading {season} {event} {session} session from FastF1...")
    fastf1_session = fastf1.get_session(season, event, session)
    fastf1_session.load()

    # How much FastF1 says to rotate this circuit so it points north-up.
    circuit_info = fastf1_session.get_circuit_info()
    rotation_degrees = float(circuit_info.rotation)
    print(f"Circuit rotation: {rotation_degrees} degrees")

    # Take the fastest lap and its position data (X/Y over time).
    fastest_lap = fastf1_session.laps.pick_fastest()
    pos_data = fastest_lap.get_pos_data()

    # Build the FastF1 outline (still in FastF1's own frame for now).
    fastf1_points = []
    for _, row in pos_data.iterrows():
        pos_x, pos_z = to_local_coordinates(row["X"], row["Y"], rotation_degrees)
        fastf1_points.append((pos_x, pos_z))

    # Build the three markers in the FastF1 frame: start/finish (lap start) and
    # the two sector splits (where the lap crossed into sectors 2 and 3).
    fastf1_markers = []
    start_x, start_z = to_local_coordinates(
        pos_data.iloc[0]["X"], pos_data.iloc[0]["Y"], rotation_degrees
    )
    fastf1_markers.append({"label": "S/F", "pos_x": start_x, "pos_z": start_z})

    sector1_time = fastest_lap["Sector1SessionTime"]
    sector2_time = fastest_lap["Sector2SessionTime"]

    s1_x, s1_y = find_position_at_session_time(pos_data, sector1_time)
    s1_pos_x, s1_pos_z = to_local_coordinates(s1_x, s1_y, rotation_degrees)
    fastf1_markers.append({"label": "S1", "pos_x": s1_pos_x, "pos_z": s1_pos_z})

    s2_x, s2_y = find_position_at_session_time(pos_data, sector2_time)
    s2_pos_x, s2_pos_z = to_local_coordinates(s2_x, s2_y, rotation_degrees)
    fastf1_markers.append({"label": "S2", "pos_x": s2_pos_x, "pos_z": s2_pos_z})

    # Calibrate the FastF1 shape onto the game-frame geojson outline.
    print(f"Calibrating against {geojson_file}...")
    geojson_outline = load_geojson_outline(geojson_file)
    transform = best_alignment(fastf1_points, geojson_outline)
    print(
        "Calibration: scale "
        + str(round(transform["scale"], 4))
        + ", rotation "
        + str(round(math.degrees(transform["rotation"]), 2))
        + " degrees"
    )

    # Apply the transform to the outline, building the final point list.
    points = []
    total_distance = 0.0
    previous_x = None
    previous_z = None
    for raw_x, raw_z in fastf1_points:
        pos_x, pos_z = apply_transform(raw_x, raw_z, transform)
        if previous_x is not None:
            step = math.sqrt((pos_x - previous_x) ** 2 + (pos_z - previous_z) ** 2)
            total_distance = total_distance + step
        previous_x = pos_x
        previous_z = pos_z
        points.append(
            {
                "dist": total_distance,
                "pos_x": pos_x,
                "pos_y": 0.0,
                "pos_z": pos_z,
                "drs": 0,
            }
        )

    # Apply the same transform to the markers.
    markers = []
    for marker in fastf1_markers:
        marker_x, marker_z = apply_transform(marker["pos_x"], marker["pos_z"], transform)
        markers.append({"label": marker["label"], "pos_x": marker_x, "pos_z": marker_z})

    # Trace the real pit lane from a car's pit stop, using the same transform.
    print("Tracing pit lane from pit in/out telemetry...")
    outline_points = []
    for point in points:
        outline_points.append((point["pos_x"], point["pos_z"]))
    pitlane = build_pitlane(fastf1_session, rotation_degrees, transform, outline_points)

    track_data = {
        "name": track_name,
        "track_info": f"Track: {event} (FastF1 {season} {session}, game-frame calibrated)",
        "points": points,
        "markers": markers,
        "pitlane": pitlane,
    }

    output = open(output_file, "w", encoding="utf-8")
    try:
        json.dump(track_data, output, indent=2)
    finally:
        output.close()

    print(
        f"Wrote {len(points)} points, {len(markers)} markers and "
        f"{len(pitlane)} pit lane points to {output_file}"
    )


def main():
    # Make sure the folders we need exist.
    if not os.path.exists(CACHE_DIR):
        os.makedirs(CACHE_DIR)
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)

    fastf1.Cache.enable_cache(CACHE_DIR)

    # With no argument we build every track. Pass one data file name (for
    # example "monaco" or "silverstone") to build just that track.
    only_track = None
    if len(sys.argv) > 1:
        only_track = sys.argv[1].lower()

    failures = []
    for track_name, season, event in TRACKS:
        if only_track is not None and track_name != only_track:
            continue
        print("")
        print("=== building " + track_name + " ===")
        try:
            build_one_track(track_name, season, event, SESSION)
        except Exception as error:
            print("FAILED to build " + track_name + ": " + str(error))
            failures.append(track_name)

    print("")
    if failures:
        print("Finished with failures: " + ", ".join(failures))
    else:
        print("Finished: all requested tracks built.")


if __name__ == "__main__":
    main()
