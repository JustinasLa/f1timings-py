import asyncio
import logging
import threading
import time

import pytest

from app.api.udp_telemetry_routes import (
    _submit_to_main_loop,
    set_main_event_loop,
)


@pytest.fixture
def main_loop():
    """Run a real asyncio event loop on a background thread.

    ``_submit_to_main_loop`` uses ``asyncio.run_coroutine_threadsafe``, which
    needs a loop that is actually running on another thread, and its
    done-callback fires on that loop's thread too.
    """
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    set_main_event_loop(loop)

    yield loop

    set_main_event_loop(None)
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=2)
    loop.close()


def _wait_for_records(caplog, timeout=1.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if caplog.records:
            return
        time.sleep(0.02)


def test_logs_error_when_coroutine_raises(main_loop, caplog):
    async def boom():
        raise RuntimeError("boom")

    with caplog.at_level(
        logging.ERROR, logger="app.api.udp_telemetry_routes"
    ):
        future = _submit_to_main_loop(boom(), "Auto track set")

        assert isinstance(future.exception(timeout=2), RuntimeError)

        _wait_for_records(caplog)

    error_records = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(error_records) == 1
    record = error_records[0]
    assert record.getMessage() == "Auto track set failed"
    assert record.exc_info is not None
    assert isinstance(record.exc_info[1], RuntimeError)
    assert str(record.exc_info[1]) == "boom"


def test_no_error_logged_when_coroutine_succeeds(main_loop, caplog):
    async def fine():
        return "ok"

    with caplog.at_level(
        logging.ERROR, logger="app.api.udp_telemetry_routes"
    ):
        future = _submit_to_main_loop(fine(), "Auto track set")

        assert future.result(timeout=2) == "ok"

        # Give the done-callback a moment to run on the loop thread even
        # though nothing should get logged.
        time.sleep(0.1)

    error_records = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert error_records == []
