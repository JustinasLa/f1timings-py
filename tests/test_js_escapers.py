import json
import shutil
import subprocess
from pathlib import Path

import pytest


JS_PATH = Path(__file__).resolve().parent.parent / "static" / "js" / "formatting-and-fetch-helpers.js"


def _run_node(js_source, script):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")

    program = f"""
{js_source}
{script}
"""
    result = subprocess.run(
        [node, "-e", program],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"node script failed: {result.stderr}"
    return result.stdout.strip()


def _source():
    return JS_PATH.read_text(encoding="utf-8")


def test_escape_attr_and_escape_html_escape_dangerous_characters():
    output = _run_node(
        _source(),
        "console.log(JSON.stringify({attr: escapeAttr('&<>\\\"\\''), html: escapeHtml('&<>')}));",
    )
    data = json.loads(output)

    attr = data["attr"]
    html = data["html"]

    stripped_entities = (
        attr.replace("&amp;", "")
        .replace("&lt;", "")
        .replace("&gt;", "")
        .replace("&quot;", "")
        .replace("&#39;", "")
    )
    assert not any(c in stripped_entities for c in "&<>\"'")

    assert "&amp;" in attr
    assert "&lt;" in attr
    assert "&gt;" in attr
    assert "&quot;" in attr
    assert "&#39;" in attr

    assert html == "&amp;&lt;&gt;"


def test_escape_js_is_not_defined():
    output = _run_node(
        _source(),
        "console.log(typeof escapeJs);",
    )
    assert output == "undefined"


@pytest.mark.parametrize(
    "value_js, expected",
    [
        ("null", False),
        ("undefined", False),
        ("''", False),
        ("NaN", False),
        ("'abc'", False),
        ("0", True),
        ("-1234.5", True),
        ("987", True),
    ],
)
def test_has_live_position_only_accepts_finite_numbers(value_js, expected):
    output = _run_node(
        _source(),
        f"const v = {value_js}; console.log(JSON.stringify([!!hasLivePosition({{world_x: v, world_z: v}}), !!hasLivePosition({{world_x: 1, world_z: v}}), !!hasLivePosition({{world_x: v, world_z: 1}})]));",
    )
    assert json.loads(output) == [expected] * 3


def test_has_live_position_rejects_missing_driver():
    output = _run_node(
        _source(),
        "console.log(JSON.stringify([!!hasLivePosition(null), !!hasLivePosition(undefined), !!hasLivePosition({})]));",
    )
    assert json.loads(output) == [False, False, False]
