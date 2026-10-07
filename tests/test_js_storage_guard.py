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
const input = {
  value: '20777', disabled: false, attributes: {}, validationMessage: '',
  addEventListener: (name, fn) => { listeners[name] = fn; },
  setCustomValidity(message) { this.validationMessage = message; },
  setAttribute(name, value) { this.attributes[name] = value; },
};
const button = { disabled: false, addEventListener: () => {} };
const element = { classList: { toggle() {}, remove() {}, add() {}, contains() { return false; } }, textContent: '' };
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


def test_invalid_udp_port_never_starts_even_when_storage_is_blocked():
    output = _run_node(
        """
(async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ running: false }) };
  };
  initializeTelemetryControls();
  input.value = '70000';
  listeners.input();
  await startUdpTelemetry();
  const invalid = { port: getUdpPort(), error: input.validationMessage,
    disabled: button.disabled, aria: input.attributes['aria-invalid'] };
  input.value = '2e4';
  listeners.input();
  console.log(JSON.stringify({ invalid, validPort: getUdpPort(),
    validError: input.validationMessage,
    startRequests: requests.filter(url => url.startsWith('/api/telemetry/start')).length }));
})();
"""
    )
    assert json.loads(output) == {
        "invalid": {
            "port": None,
            "error": "Enter a port from 1024 to 65535",
            "disabled": True,
            "aria": "true",
        },
        "validPort": "20000",
        "validError": "",
        "startRequests": 0,
    }


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
