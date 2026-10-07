'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard, jsonResponse } = require('./harness.js');

const SQUARE = [
  { pos_x: 0, pos_z: 0 },
  { pos_x: 0, pos_z: 100 },
  { pos_x: 100, pos_z: 100 }
];
const TRANSFORM = { minX: 0, minY: 0, scale: 1, centerOffsetX: 0, centerOffsetY: 0 };

function withTrack(env) {
  env.set('canvas', env.document.getElementById('trackCanvas'));
  env.set('ctx', env.ctx2d);
  env.set('currentTrack', 'japan');
  env.set('trackData', { points: SQUARE, transformParams: TRANSFORM });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('startDataFetching loads immediately and polls on an interval', async () => {
  const env = createDashboard();
  const w = env.window;
  const old = w.setInterval(() => assert.fail('old interval must be cleared'), 50);
  env.set('fetchDataInterval', old);
  w.startDataFetching();
  await env.flush();

  assert.equal(env.callsTo('/api/drivers/live').length, 1);
  assert.match(env.document.getElementById('timingTableBody').textContent, /No timing data/);
  const intervals = env.clock.pending().filter((t) => t.interval !== null);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].interval, 100);
  assert.notEqual(env.get('fetchDataInterval'), old);

  env.clock.advance(100);
  await env.flush();
  assert.equal(env.callsTo('/api/drivers/live').length, 2);
  assert.equal(env.callsTo('/api/telemetry/session').length, 1);
});

test('startDataFetching without a previous interval', () => {
  const env = createDashboard();
  env.window.startDataFetching();
  assert.ok(env.get('fetchDataInterval'));
});

test('pollDisplayData refreshes records only every 5 seconds', async () => {
  const env = createDashboard({ fetch: () => jsonResponse({ lap_times: [] }) });
  const w = env.window;
  env.set('currentTrack', 'monza');
  await w.loadDisplayData();
  assert.equal(env.callsTo('/api/track/records').length, 1);

  env.clock.advance(4999);
  w.pollDisplayData();
  await env.flush();
  assert.equal(env.callsTo('/api/track/records').length, 1);

  env.clock.advance(1);
  w.pollDisplayData();
  await env.flush();
  assert.equal(env.callsTo('/api/track/records').length, 2);
});

test('connection banner appears when live polling is stale', async () => {
  let ok = true;
  const env = createDashboard({ fetch: () => ok ? jsonResponse({}) : jsonResponse({}, 502) });
  const w = env.window;
  const banner = env.document.getElementById('connectionBanner');
  banner.hidden = false;
  w.updateConnectionBanner();
  assert.equal(banner.hidden, true);

  ok = false;
  env.clock.advance(3000);
  await w.loadLiveDriverPositions();
  w.updateConnectionBanner();
  assert.equal(banner.hidden, true, 'exactly at the threshold is still fresh');
  env.clock.advance(1);
  w.updateConnectionBanner();
  assert.equal(banner.hidden, false);

  ok = true;
  await w.loadLiveDriverPositions();
  w.updateConnectionBanner();
  assert.equal(banner.hidden, true);

  const noBanner = createDashboard({ html: '<div></div>' });
  assert.doesNotThrow(() => noBanner.window.updateConnectionBanner());
});

test('loadDisplayData coalesces overlapping refreshes into one follow-up', async () => {
  const gates = [];
  const env = createDashboard({
    fetch: () => {
      const d = deferred();
      gates.push(d);
      return d.promise.then(() => jsonResponse({ lap_times: [] }));
    }
  });
  const w = env.window;
  env.set('currentTrack', 'monza');
  const first = w.loadDisplayData();
  await env.flush();
  w.loadDisplayData();
  w.loadDisplayData();
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(env.get('displayDataPending'), true);

  gates[0].resolve();
  await first;
  await env.flush();
  assert.equal(env.fetchCalls.length, 2, 'one follow-up fetch');
  assert.equal(env.get('displayDataPending'), false);
  gates[1].resolve();
  await env.flush();
  assert.equal(env.get('displayDataInFlight'), false);
  assert.equal(env.fetchCalls.length, 2);
});

test('refreshDisplayData clears the view without a track', async () => {
  const env = createDashboard();
  env.document.getElementById('fastestLapPill').style.display = 'inline-block';
  env.document.getElementById('poleLapCard').style.display = 'block';
  await env.window.refreshDisplayData();
  assert.equal(env.fetchCalls.length, 0);
  assert.match(env.document.getElementById('timingTableBody').textContent, /No timing data/);
  assert.equal(env.document.getElementById('fastestLapPill').style.display, 'none');
  assert.equal(env.document.getElementById('poleLapCard').style.display, 'none');
});

test('refreshDisplayData renders records for the current track', async () => {
  let body = {
    lap_times: [
      { driver: 'Ann', time: '1:30.000', team: 'McLaren F1 Team' },
      { driver: 'Bob', time: '1:31.000' },
      { driver: 'Pole', time: '1:20.000', is_pole_reference: true }
    ]
  };
  const env = createDashboard({ fetch: () => jsonResponse(body) });
  const doc = env.document;
  env.set('currentTrack', 'las_vegas');
  await env.window.refreshDisplayData();
  assert.equal(env.fetchCalls[0].url, '/api/track/records?track=las_vegas');
  assert.equal(doc.querySelectorAll('#timingTableBody tr.clickable-row').length, 2);
  assert.equal(doc.getElementById('fastestLapPill').textContent, '1:30.000');
  assert.equal(doc.getElementById('poleLapCard').style.display, 'block');

  body = { lap_times: 'nope' };
  await env.window.refreshDisplayData();
  assert.match(doc.getElementById('timingTableBody').textContent, /No timing data/);
});

test('refreshDisplayData logs fetch errors and keeps the old table', async () => {
  const env = createDashboard({ fetch: () => jsonResponse({}, 500) });
  env.set('currentTrack', 'monza');
  env.document.getElementById('timingTableBody').innerHTML = '<tr><td>old</td></tr>';
  await env.window.refreshDisplayData();
  assert.equal(env.logs.error[0][0], 'Error loading display data:');
  assert.equal(env.document.getElementById('timingTableBody').textContent, 'old');
});

test('loadLiveDriverPositions draws drivers, updates aliases and guards re-entry', async () => {
  const live = { 0: { name: 'Ann Lee', world_x: 10, world_z: 10, instance_index: 0 } };
  const env = createDashboard({ fetch: () => jsonResponse(live) });
  withTrack(env);
  const w = env.window;
  const p1 = w.loadLiveDriverPositions();
  const p2 = w.loadLiveDriverPositions();
  await Promise.all([p1, p2]);
  assert.equal(env.fetchCalls.length, 1, 'second call skipped while in flight');
  assert.equal(env.get('latestLiveDrivers'), live);
  assert.equal(env.document.querySelector('.driver-alias-raw').textContent, 'Ann Lee');
  assert.deepEqual(env.ctx2d.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]), ['AL']);
  assert.equal(env.get('liveDriversInFlight'), false);
});

test('loadLiveDriverPositions redraws the bare track when nobody has a position', async () => {
  let respond = () => jsonResponse({ 0: { name: 'Ann' } });
  const env = createDashboard({ fetch: () => respond() });
  withTrack(env);
  const w = env.window;
  await w.loadLiveDriverPositions();
  assert.equal(env.ctx2d.calls[0].name, 'clearRect');
  assert.equal(env.ctx2d.calls.filter((c) => c.name === 'arc').length, 0);

  env.ctx2d.calls.length = 0;
  respond = () => { throw new Error('down'); };
  await w.loadLiveDriverPositions();
  assert.equal(env.ctx2d.calls[0].name, 'clearRect', 'redraws on failure too');
  assert.equal(env.get('liveDriversInFlight'), false);
});

test('loadLiveDriverPositions without track data draws nothing', async () => {
  let respond = () => jsonResponse({ 0: { name: 'Ann', world_x: 1, world_z: 1 } });
  const env = createDashboard({ fetch: () => respond() });
  env.set('ctx', env.ctx2d);
  await env.window.loadLiveDriverPositions();
  respond = () => { throw new Error('down'); };
  await env.window.loadLiveDriverPositions();
  assert.equal(env.ctx2d.calls.length, 0);
  assert.equal(env.get('latestLiveDrivers')[0].name, 'Ann');
});


test('polling invokes optional map recovery and supports an absent map module', async () => {
  const env = createDashboard();
  let retries = 0;
  env.set('retryTrackVisualization', () => { retries++; });
  env.window.pollDisplayData();
  await env.flush();
  assert.equal(retries, 1);
  env.set('retryTrackVisualization', undefined);
  env.window.pollDisplayData();
  await env.flush();
  assert.equal(retries, 1);
});
