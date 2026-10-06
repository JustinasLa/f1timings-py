import json
import shutil
import subprocess
from pathlib import Path

import pytest


STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
JS_DIR = STATIC_DIR / "js"

PRELUDE = "var now = 0; Date.now = () => now;\n"

HARNESS = """
var currentTrack = "monza", trackData = null, latestLiveDrivers = {}, fetchDataInterval = null;
var socket, canvas = { style: {} }, ctx = {};
var tick = null, calls = [], liveOk = true, serverTrack = "Monza", viz = [];
var banner = { hidden: true };
setInterval = (fn) => { tick = fn; return 1; };
clearInterval = () => {};
console.error = () => {};
document = { getElementById: (id) => (id === "connectionBanner" ? banner : null) };
location = { protocol: "http:", host: "localhost" };
WebSocket = function () { socket = this; };
updateDriverAliasPanel = drawDriversOnTrack = redrawCompleteTrack = updateTrackConditions = () => {};
updateLeaderboard = updateFastestLapPill = updatePoleLapCard = () => {};
updateTrackUI = updateTrackSelectValue = () => {};
loadTrackVisualization = (name) => { viz.push(name); };
hasLivePosition = () => false;
buildDriversFromRecords = () => ({});
fetchJsonWithTimeout = (url) => {
  calls.push("GET " + url);
  if (url.startsWith("/api/drivers/live") && !liveOk) return Promise.reject(new Error("down"));
  return Promise.resolve(url.startsWith("/api/drivers/live") ? {} : { lap_times: [] });
};
fetch = (url, options = {}) => {
  calls.push((options.method || "GET") + " " + url);
  return Promise.resolve({ ok: true, json: async () => ({ name: serverTrack }) });
};
const flush = () => new Promise((r) => setImmediate(r));
const count = (p) => calls.filter((c) => c === p || c.startsWith(p)).length;
"""


def _run(script):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")
    source = "\n".join(
        (JS_DIR / name).read_text(encoding="utf-8")
        for name in (
            "dashboard-settings.js",
            "track-map-canvas.js",
            "poll-api-and-refresh-display.js",
            "websocket-live-updates.js",
        )
    )
    program = PRELUDE + source + HARNESS + "(async () => {\n" + script + "\n})().catch((e) => { console.log(e.stack); process.exit(1); });"
    result = subprocess.run([node, "-e", program], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_banner_shown_after_three_seconds_without_live_success_and_hidden_after_success():
    out = _run("""
liveOk = false;
startDataFetching();
await flush();
now = 3000; tick(); await flush();
const atThreshold = banner.hidden;
now = 3100; tick(); await flush();
const afterStale = banner.hidden;
now = 9000; tick(); await flush();
const stillStale = banner.hidden;
liveOk = true;
tick(); await flush();
tick(); await flush();
const afterSuccess = banner.hidden;
console.log(JSON.stringify({ atThreshold, afterStale, stillStale, afterSuccess }));
""")
    assert out == {"atThreshold": True, "afterStale": False, "stillStale": False, "afterSuccess": True}


def test_banner_stays_hidden_while_live_polls_succeed():
    out = _run("""
startDataFetching();
await flush();
for (let i = 0; i < 100; i++) { now += 100; tick(); await flush(); }
console.log(JSON.stringify({ hidden: banner.hidden }));
""")
    assert out == {"hidden": True}


def test_banner_markup_is_in_index_html():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    assert 'id="connectionBanner"' in html
    assert 'class="connection-banner"' in html
    assert ".connection-banner" in (STATIC_DIR / "display.css").read_text(encoding="utf-8")


def test_toast_containers_are_live_regions():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    assert '<div id="lap-toast-container" role="status" aria-live="polite">' in html
    assert '<div id="toast-container" role="status" aria-live="polite">' in html


def test_websocket_open_switches_to_server_track_without_posting_or_double_fetch():
    out = _run("""
serverTrack = "Monaco";
initializeWebSocket();
socket.onopen();
await flush();
console.log(JSON.stringify({
  track: currentTrack,
  viz,
  currentTrackGets: calls.filter((c) => c === "GET /api/track").length,
  posts: count("POST"),
  records: count("GET /api/track/records"),
}));
""")
    assert out == {"track": "monaco", "viz": ["monaco"], "currentTrackGets": 1, "posts": 0, "records": 1}


def test_websocket_open_with_unchanged_track_only_refreshes_records():
    out = _run("""
serverTrack = "Monza";
initializeWebSocket();
socket.onopen();
await flush();
console.log(JSON.stringify({
  track: currentTrack,
  viz,
  posts: count("POST"),
  records: count("GET /api/track/records"),
}));
""")
    assert out == {"track": "monza", "viz": [], "posts": 0, "records": 1}
