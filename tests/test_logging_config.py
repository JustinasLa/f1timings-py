import importlib
import logging

import pytest

import app.main as main_module
import app.models.data_models as data_models_module


@pytest.fixture
def reload_main_pristine_logging(monkeypatch):
    """Reload app.main with DEBUG set, after resetting the root logger.

    Root logging state is process-global and other tests/plugins (including
    pytest's own logging plugin) attach handlers to it, so we snapshot and
    restore it around the reload instead of assuming it starts empty.

    ``app.models.data_models`` is reloaded first (mirroring the real import
    order, since app.main pulls it in transitively via app.services) so
    that any module-level ``logging.basicConfig`` call it makes runs before
    app.main's own call, exactly as happens on a fresh process import. A
    plain reload of only app.main would not re-execute data_models' already
    -imported top-level code and would miss the regression this guards
    against.
    """

    saved_handlers = logging.root.handlers[:]
    saved_level = logging.root.level

    def _reload(debug_value):
        logging.root.handlers = []
        logging.root.setLevel(logging.WARNING)
        monkeypatch.setenv("DEBUG", debug_value)
        importlib.reload(data_models_module)
        importlib.reload(main_module)
        return main_module

    yield _reload

    # Teardown: drop whatever handlers the reload installed, restore the
    # pre-test root state, and reload app.main once more without DEBUG so
    # later test modules import it in its default state.
    logging.root.handlers = saved_handlers
    logging.root.setLevel(saved_level)
    monkeypatch.delenv("DEBUG", raising=False)
    importlib.reload(main_module)


def test_debug_env_configures_root_logger_level_and_format(
    reload_main_pristine_logging,
):
    reload_main_pristine_logging("true")

    assert logging.root.level == logging.DEBUG
    assert any(
        handler.formatter is not None and "%(name)s" in handler.formatter._fmt
        for handler in logging.root.handlers
    )
