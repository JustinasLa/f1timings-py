from typing import Dict

from app.models.data_models import Driver, LapTime


def update_overall_fastest_lap(drivers: Dict[str, Driver]):
    overall_fastest_time = float("inf")
    fastest_lap_ref: LapTime | None = None

    for driver in drivers.values():
        for lap in driver.lap_times:
            lap.is_fastest = False
            if lap.is_valid and lap.time_seconds < overall_fastest_time:
                overall_fastest_time = lap.time_seconds
                fastest_lap_ref = lap

    if fastest_lap_ref:
        fastest_lap_ref.is_fastest = True

