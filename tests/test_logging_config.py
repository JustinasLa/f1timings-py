import importlib
import logging

import pytest

import app.main as main_module
import app.models.data_models as data_models_module


@pytest.fixture
def reload_main_pristine_logging(monkeypatch):

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
