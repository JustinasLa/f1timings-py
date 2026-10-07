'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createDashboard, jsonResponse, plain, breakLocalStorage, SCRIPT_ORDER, JS_DIR } = require('./harness.js');

test('index.html loads every file in static/js (so coverage sees them all)', () => {
  const onDisk = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual([...SCRIPT_ORDER].sort(), onDisk);
});

test('dashboard settings constants are consistent', () => {
  const env = createDashboard();
  const tracks = Object.keys(env.get('TRACK_DICTIONARY')).sort();
  assert.deepEqual(Object.keys(env.get('TRACK_DISPLAY_NAMES')).sort(), tracks);
  assert.deepEqual(Object.keys(env.get('TRACK_COUNTRY_CODES')).sort(), tracks);
  assert.equal(env.get('TEAM_COLORS').DEFAULT, '#a371f7');
  assert.equal(env.get('currentTrack'), '');
  assert.equal(env.get('expandedDrivers').size, 0);
});

test('escapeHtml and escapeAttr escape markup characters', () => {
  const { window: w } = createDashboard();
  assert.equal(w.escapeHtml('<b>&"\''), '&lt;b&gt;&amp;"\'');
  assert.equal(w.escapeAttr('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
  assert.equal(w.escapeHtml(42), '42');
});

test('readStoredValue / writeStoredValue use localStorage', () => {
  const { window: w } = createDashboard();
  assert.equal(w.readStoredValue('k'), null);
  w.writeStoredValue('k', 'v');
  assert.equal(w.localStorage.getItem('k'), 'v');
  assert.equal(w.readStoredValue('k'), 'v');
});

test('readStoredValue / writeStoredValue swallow storage errors', () => {
  const { window: w } = createDashboard();
  breakLocalStorage(w);
  assert.equal(w.readStoredValue('k'), null);
  assert.doesNotThrow(() => w.writeStoredValue('k', 'v'));
});

test('fetchJsonWithTimeout returns parsed JSON and forwards options', async () => {
  const env = createDashboard({ fetch: () => jsonResponse({ a: 1 }) });
  const data = await env.window.fetchJsonWithTimeout('/x', 500, { method: 'POST' });
  assert.deepEqual(plain(data), { a: 1 });
  assert.equal(env.fetchCalls[0].url, '/x');
  assert.equal(env.fetchCalls[0].init.method, 'POST');
  assert.ok(env.fetchCalls[0].init.signal);
  assert.equal(env.clock.pending().length, 0, 'timeout is cleared');
});

test('fetchJsonWithTimeout uses default options and rejects on HTTP errors', async () => {
  const env = createDashboard({ fetch: () => jsonResponse({}, 503) });
  await assert.rejects(env.window.fetchJsonWithTimeout('/x', 500), /HTTP 503/);
  assert.deepEqual(Object.keys(env.fetchCalls[0].init), ['signal']);
  assert.equal(env.clock.pending().length, 0);
});

test('fetchJsonWithTimeout aborts the request after the timeout', async () => {
  const env = createDashboard({
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })
  });
  const pending = env.window.fetchJsonWithTimeout('/slow', 1500);
  await env.flush();
  assert.equal(env.fetchCalls[0].init.signal.aborted, false);
  env.clock.advance(1500);
  assert.equal(env.fetchCalls[0].init.signal.aborted, true);
  await assert.rejects(pending, /aborted/);
});

test('hasLivePosition requires finite world_x and world_z', () => {
  const { window: w } = createDashboard();
  assert.ok(!w.hasLivePosition(null));
  assert.equal(w.hasLivePosition({ world_x: 1, world_z: 2 }), true);
  assert.equal(w.hasLivePosition({ world_x: 1, world_z: NaN }), false);
  assert.equal(w.hasLivePosition({ world_x: '1', world_z: 2 }), false);
});

test('parseTimeToSeconds handles all supported formats', () => {
  const { window: w } = createDashboard();
  assert.equal(w.parseTimeToSeconds(''), Infinity);
  assert.equal(w.parseTimeToSeconds(null), Infinity);
  assert.equal(w.parseTimeToSeconds('1:23.456'), 83.456);
  assert.equal(w.parseTimeToSeconds('1:23'), 83);
  assert.equal(w.parseTimeToSeconds('1:2:3.4'), Infinity);
  assert.equal(w.parseTimeToSeconds('1:2:3:4'), Infinity);
  assert.equal(w.parseTimeToSeconds('1.23.456'), 83.456);
  assert.equal(w.parseTimeToSeconds('83.5'), 83.5);
  assert.equal(w.parseTimeToSeconds('90'), 90);
  assert.equal(w.parseTimeToSeconds('0'), Infinity);
  assert.equal(w.parseTimeToSeconds('abc'), Infinity);
});

test('parseTimeToSeconds rejects malformed values without coercion or partial parsing', () => {
  const { window: w } = createDashboard();
  const invalid = [undefined, null, false, true, {}, [], [90], () => 90,
    0, -1, NaN, Infinity, -Infinity, '', ' ', '0.000', '0:00.000', '0.00.000',
    '-1', '-1:30.000', '-1.30.000', '90junk', '1:xx.000', '1:20:30',
    '1:60.000', '1.60.000', '1:90', '1.2.3.4', '1e2', 'NaN', 'Infinity',
    '1:23.456junk', '.5', '90\n20', '9'.repeat(400),
    '9'.repeat(400) + ':00.000', '9'.repeat(400) + '.00.000'];
  for (const value of invalid) {
    assert.equal(w.parseTimeToSeconds(value), Infinity, `unexpected parse for ${String(value)}`);
    assert.equal(w.formatTime(value), 'N/A');
  }
});

test('parseTimeToSeconds supports positive numeric inputs, trimmed strings and fractional sectors', () => {
  const { window: w } = createDashboard();
  for (const [value, expected] of [[90, 90], [0.001, 0.001], [90.125, 90.125],
    [' 1:23.456 ', 83.456], ['0:00.001', 0.001], ['0.00.001', 0.001],
    ['1:2', 62], ['1.2.3', 62.3], ['00090', 90], ['1:59.999', 119.999]]) {
    assert.equal(w.parseTimeToSeconds(value), expected);
  }
});

test('formatSeconds, formatTime and formatGap', () => {
  const { window: w } = createDashboard();
  assert.equal(w.formatSeconds(Infinity), 'N/A');
  assert.equal(w.formatSeconds(83.456), '1:23.456');
  assert.equal(w.formatSeconds(65.5), '1:05.500');
  assert.equal(w.formatTime('1:23.456'), '1:23.456');
  assert.equal(w.formatTime(''), 'N/A');
  assert.equal(w.formatGap(1.25), '1.250s');
  assert.equal(w.formatGap(0.5), '0.500s');
  assert.equal(w.formatGap(65.25), '1:05.250');
  assert.equal(w.formatGap(125), '2:05.000');
});

test('formatSeconds rounds milliseconds before minute and padding boundaries', () => {
  const { window: w } = createDashboard();
  for (const [seconds, expected] of [[0, '0:00.000'], [9.9996, '0:10.000'],
    [59.9994, '0:59.999'], [59.9996, '1:00.000'], [119.9996, '2:00.000'],
    [3599.9996, '60:00.000'], [65.0001, '1:05.000']]) {
    assert.equal(w.formatSeconds(seconds), expected);
  }
  for (const value of [NaN, -Infinity, -1, '90', null, Number.MAX_VALUE]) {
    assert.equal(w.formatSeconds(value), 'N/A');
  }
  assert.equal(w.formatTime('59.9996'), '1:00.000');
  assert.equal(w.formatGap(119.9996), '2:00.000');
  assert.equal(w.formatGap(Infinity), 'N/A');
  assert.equal(w.formatGap(NaN), 'N/A');
});
