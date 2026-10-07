import json
import shutil
import subprocess
from pathlib import Path

import pytest


JS_DIR = Path(__file__).resolve().parent.parent / "static" / "js"

BLOCKED_STORAGE = """
const blocked = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
Object.defineProperty(globalThis, 'localStorage', { get: blocked });
Object.defineProperty(globalThis, 'sessionStorage', { get: blocked });
const listeners = {};
const input = { value: '', disabled: false, addEventListener: (name, fn) => { listeners[name] = fn; } };
const button = { disabled: false, addEventListener: () => {} };
const element = { classList: { toggle() {}, remove() {}, add() {} }, textContent: '' };
const elements = {
  udpStartBtn: button, udpStopBtn: button, udpPortInput: input,
  udpPanel: element, udpStatusText: element, udpDriverCount: element,
};
globalThis.document = { getElementById: (id) => elements[id] || null };
globalThis.fetch = () => Promise.reject(new Error('offline'));
globalThis.setInterval = () => 0;
"""


def _run_node(script):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")

    sources = "\n".join(
        (JS_DIR / name).read_text(encoding="utf-8")
        for name in ("formatting-and-fetch-helpers.js", "udp-listener-controls.js")
    )
    result = subprocess.run(
        [node, "-"],
        input=f"{BLOCKED_STORAGE}\n{sources}\n{script}",
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"node script failed: {result.stderr}"
    return result.stdout.strip()


def test_udp_controls_survive_blocked_storage():
    output = _run_node(
        """
(async () => {
  initializeTelemetryControls();
  listeners.change();
  updateTelemetryControls({ running: true, active_drivers: 2, port: 20888 });
  await startUdpTelemetry();
  console.log(JSON.stringify({ port: input.value }));
})();
"""
    )
    assert json.loads(output) == {"port": 20888}


def test_start_dashboard_runs_every_step_when_one_throws():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")

    source = (JS_DIR / "start-dashboard.js").read_text(encoding="utf-8")
    program = f"""
const calls = [];
let onLoad;
globalThis.document = {{
  addEventListener: (name, fn) => {{ onLoad = fn; }},
  getElementById: () => null,
}};
for (const name of ['initializeColumnSettings', 'initializeLayoutDivider', 'initializeWebSocket',
    'loadCurrentTrack', 'loadTrackSelectOptions', 'loadDriverAliases', 'startDataFetching']) {{
  globalThis[name] = () => calls.push(name);
}}
globalThis.initializeTelemetryControls = () => {{ throw new Error('boom'); }};
{source}
console.error = () => {{}};
onLoad();
console.log(JSON.stringify(calls));
"""
    result = subprocess.run([node, "-"], input=program, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, f"node script failed: {result.stderr}"
    assert "startDataFetching" in json.loads(result.stdout.strip())
