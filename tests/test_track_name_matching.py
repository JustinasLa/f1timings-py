import pytest
from app.services.track_map_loader import track_service


def test_germany_does_not_resolve_to_hungary():
    result = track_service.find_matching_track_name("germany")
    assert result is None


def test_hungary_resolves_to_hungary():
    result = track_service.find_matching_track_name("hungary")
    assert result == "hungary"


def test_hungarian_resolves_to_hungary():
    result = track_service.find_matching_track_name("hungarian")
    assert result == "hungary"


def test_italy_resolves_to_monza():
    result = track_service.find_matching_track_name("italy")
    assert result == "monza"
