import math

import pytest
from pydantic import ValidationError

from app.models.data_models import Driver, LapTime, LapTimeInput


@pytest.mark.parametrize(
    "time_str, expected",
    [
        ("1:12.345", 72.345),
        ("1.12.345", 72.345),
        ("72.345", 72.345),
        ("72", 72.0),
    ],
)
def test_time_seconds_parses_supported_formats(time_str, expected):
    assert LapTime(time=time_str).time_seconds == pytest.approx(expected)


@pytest.mark.parametrize("time_str", ["a:12.3", "1.a.3", "1.2.3.4", "abc", "-5", "-1:00.000"])
def test_time_seconds_is_infinite_for_unparseable_or_negative_times(time_str):
    assert math.isinf(LapTime(time=time_str).time_seconds)


def test_fastest_valid_lap_skips_invalid_laps():
    driver = Driver(
        name="Max",
        team="Red Bull",
        lap_times=[
            LapTime(time="1:10.000", is_valid=False),
            LapTime(time="1:12.000"),
            LapTime(time="1:11.000"),
            LapTime(time="1:13.000"),
        ],
    )

    assert driver.fastest_valid_lap.time == "1:11.000"


def test_fastest_valid_lap_is_none_without_valid_laps():
    driver = Driver(name="Max", team="Red Bull", lap_times=[LapTime(time="1:10.000", is_valid=False)])

    assert driver.fastest_valid_lap is None


@pytest.mark.parametrize("time_str", ["1:12.345", "72.345", "72"])
def test_lap_time_input_accepts_recognisable_times(time_str):
    assert LapTimeInput(name="Max", team="Red Bull", time=time_str).time == time_str


def test_lap_time_input_rejects_garbage_time():
    with pytest.raises(ValidationError, match="recognizable format"):
        LapTimeInput(name="Max", team="Red Bull", time="fast")

