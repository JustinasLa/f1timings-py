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

    # escapeAttr: no raw &, <, >, ", ' outside of entity encodings.
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

    # escapeHtml escapes & < > but is not required to touch quotes.
    assert html == "&amp;&lt;&gt;"


def test_escape_js_is_not_defined():
    output = _run_node(
        _source(),
        "console.log(typeof escapeJs);",
    )
    assert output == "undefined"
