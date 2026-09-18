import pytest

from app.api import udp_telemetry_routes
from app.api.udp_telemetry_routes import (
    TRACK_ID_TO_NAME,
    _maybe_auto_set_track,
    set_main_event_loop,
)


@pytest.fixture
def reset_state(monkeypatch):
    """Reset the auto-track-set globals and record calls to _submit_to_main_loop."""
    monkeypatch.setattr(udp_telemetry_routes, "_last_auto_set_track_id", None)

    submitted = []

    def fake_submit(coro, what):
        coro.close()  # avoid "coroutine was never awaited" warnings
        submitted.append(what)
        return None

    monkeypatch.setattr(udp_telemetry_routes, "_submit_to_main_loop", fake_submit)

    yield submitted

    set_main_event_loop(None)
    monkeypatch.setattr(udp_telemetry_routes, "_last_auto_set_track_id", None)


def test_no_loop_does_not_remember_track(reset_state):
    """When no main loop is set, calling with a known track id must not submit
    anything and must not update _last_auto_set_track_id."""
    submitted = reset_state
    track_id = next(iter(TRACK_ID_TO_NAME))

    _maybe_auto_set_track(track_id)

    assert submitted == []
    assert udp_telemetry_routes._last_auto_set_track_id is None


def test_loop_available_submits_and_remembers_track(reset_state):
    submitted = reset_state
    set_main_event_loop(object())
    track_id = next(iter(TRACK_ID_TO_NAME))
    track_name = TRACK_ID_TO_NAME[track_id]

    _maybe_auto_set_track(track_id)

    assert len(submitted) == 1
    assert track_name in submitted[0]
    assert udp_telemetry_routes._last_auto_set_track_id == track_id


def test_repeated_call_with_same_track_does_not_resubmit(reset_state):
    submitted = reset_state
    set_main_event_loop(object())
    track_id = next(iter(TRACK_ID_TO_NAME))

    _maybe_auto_set_track(track_id)
    _maybe_auto_set_track(track_id)

    assert len(submitted) == 1


def test_unknown_track_id_never_submits_or_remembers(reset_state):
    submitted = reset_state
    set_main_event_loop(object())
    unknown_track_id = -1
    assert unknown_track_id not in TRACK_ID_TO_NAME

    _maybe_auto_set_track(unknown_track_id)

    assert submitted == []
    assert udp_telemetry_routes._last_auto_set_track_id is None
