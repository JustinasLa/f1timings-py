import json
import shutil
import subprocess
from pathlib import Path

import pytest


JS_DIR = Path(__file__).resolve().parent.parent / "static" / "js"

HARNESS = """
var currentTrack = "monza", trackData = null, latestLiveDrivers = {}, fetchDataInterval = null;
var tick = null, now = 0, calls = [], liveResolvers = [], recordsResolvers = [], autoRecords = true;
setInterval = (fn) => { tick = fn; return 1; };
clearInterval = () => {};
Date.now = () => now;
console.error = () => {};
updateDriverAliasPanel = drawDriversOnTrack = redrawCompleteTrack = updateTrackConditions = () => {};
updateLeaderboard = updateFastestLapPill = updatePoleLapCard = () => {};
hasLivePosition = () => false;
buildDriversFromRecords = () => ({});
fetchJsonWithTimeout = (url) => {
  calls.push(url);
  return new Promise((resolve) => {
    if (url.startsWith("/api/drivers/live")) liveResolvers.push(resolve);
    else if (autoRecords) resolve({ lap_times: [] });
    else recordsResolvers.push(resolve);
  });
};
const flush = () => new Promise((r) => setImmediate(r));
const count = (p) => calls.filter((u) => u.startsWith(p)).length;
"""


def _run(script):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")
    source = "\n".join(
        (JS_DIR / name).read_text(encoding="utf-8")
        for name in ("dashboard-settings.js", "poll-api-and-refresh-display.js")
    )
    program = source + HARNESS + "(async () => {\n" + script + "\n})().catch((e) => { console.log(e.stack); process.exit(1); });"
    result = subprocess.run([node, "-e", program], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip())


def test_live_positions_never_overlap():
    out = _run("""
startDataFetching();
for (let i = 0; i < 20; i++) { now += 100; tick(); await flush(); }
const whilePending = count("/api/drivers/live");
liveResolvers.shift()({});
await flush();
now += 100; tick(); await flush();
console.log(JSON.stringify({ whilePending, after: count("/api/drivers/live") }));
""")
    assert out == {"whilePending": 1, "after": 2}


def test_records_fetched_on_events_and_slow_fallback_only():
    out = _run("""
startDataFetching();
await flush();
for (let i = 0; i < 49; i++) { now += 100; tick(); liveResolvers.shift()?.({}); await flush(); }
const beforeFallback = count("/api/track/records");
now += 100; tick(); await flush();
const atFallback = count("/api/track/records");
loadDisplayData(); await flush();
console.log(JSON.stringify({ beforeFallback, atFallback, afterEvent: count("/api/track/records") }));
""")
    assert out == {"beforeFallback": 1, "atFallback": 2, "afterEvent": 3}


def test_records_event_during_inflight_fetch_is_not_lost():
    out = _run("""
autoRecords = false;
loadDisplayData();
await flush();
loadDisplayData();
await flush();
const whileInFlight = count("/api/track/records");
recordsResolvers.shift()({ lap_times: [] });
await flush();
console.log(JSON.stringify({ whileInFlight, after: count("/api/track/records") }));
""")
    assert out == {"whileInFlight": 1, "after": 2}
