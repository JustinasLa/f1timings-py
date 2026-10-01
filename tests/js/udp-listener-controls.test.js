'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard, jsonResponse } = require('./harness.js');

function ui(env) {
  const $ = (id) => env.document.getElementById(id);
  return {
    panel: $('udpPanel'),
    text: $('udpStatusText').textContent,
    drivers: $('udpDriverCount').textContent,
    start: $('udpStartBtn'),
    stop: $('udpStopBtn'),
    port: $('udpPortInput')
  };
}

test('initializeTelemetryControls restores the port, polls status and wires buttons', async () => {
  let status = { running: true, active_drivers: 1, port: 20800 };
  const env = createDashboard({ fetch: () => jsonResponse(status) });
  const w = env.window;
  w.localStorage.setItem('udpTelemetryPort', '20999');
  w.initializeTelemetryControls();
  assert.equal(ui(env).port.value, '20999');
  await env.flush();

  let s = ui(env);
  assert.equal(env.fetchCalls[0].url, '/api/telemetry/status');
  assert.ok(s.panel.classList.contains('running'));
  assert.equal(s.text, 'UDP On');
  assert.equal(s.drivers, '1 driver');
  assert.equal(s.start.disabled, true);
  assert.equal(s.stop.disabled, false);
  assert.equal(s.port.disabled, true);
  assert.equal(s.port.value, '20800');
  assert.equal(w.localStorage.getItem('udpTelemetryPort'), '20800');

  // Polls every 2s; re-initialising replaces the interval.
  const intervalsBefore = env.clock.pending().filter((t) => t.interval === 2000).length;
  assert.equal(intervalsBefore, 1);
  w.initializeTelemetryControls();
  assert.equal(env.clock.pending().filter((t) => t.interval === 2000).length, 1);
  await env.flush();
  const before = env.fetchCalls.length;
  status = { running: false, active_drivers: 3 };
  env.clock.advance(2000);
  await env.flush();
  assert.equal(env.fetchCalls.length, before + 1);
  s = ui(env);
  assert.equal(s.text, 'UDP Off');
  assert.equal(s.drivers, '3 drivers');
  assert.equal(s.start.disabled, false);
  assert.equal(s.stop.disabled, true);

  s.port.value = '30000';
  s.port.dispatchEvent(new w.Event('change'));
  assert.equal(w.localStorage.getItem('udpTelemetryPort'), '30000');
  s.port.value = '80';
  s.port.dispatchEvent(new w.Event('change'));
  assert.equal(w.localStorage.getItem('udpTelemetryPort'), '20777');
});

test('initializeTelemetryControls keeps the default port when none is saved', () => {
  const env = createDashboard();
  env.window.initializeTelemetryControls();
  assert.equal(ui(env).port.value, '20777');
});

test('initializeTelemetryControls needs all three controls', () => {
  for (const html of [
    '<button id="udpStopBtn"></button><input id="udpPortInput">',
    '<button id="udpStartBtn"></button><input id="udpPortInput">',
    '<button id="udpStartBtn"></button><button id="udpStopBtn"></button>'
  ]) {
    const env = createDashboard({ html });
    env.window.initializeTelemetryControls();
    assert.equal(env.fetchCalls.length, 0);
    assert.equal(env.clock.pending().length, 0);
  }
});

test('getUdpPort validates the port range', () => {
  const env = createDashboard();
  const port = ui(env).port;
  for (const [value, expected] of [['1024', '1024'], ['65535', '65535'], ['1023', '20777'], ['65536', '20777'], ['abc', '20777']]) {
    port.value = value;
    assert.equal(env.window.getUdpPort(), expected, value);
  }
  const noInput = createDashboard({ html: '<div></div>' });
  assert.equal(noInput.window.getUdpPort(), '20777');
});

test('start button starts the listener on the chosen port', async () => {
  const env = createDashboard({
    fetch: (url) => url.startsWith('/api/telemetry/start') ? jsonResponse({ ok: true }) : jsonResponse({ running: true, active_drivers: 0 })
  });
  const w = env.window;
  ui(env).port.value = '21000';
  const pending = w.startUdpTelemetry();
  let s = ui(env);
  assert.equal(s.text, 'Starting');
  assert.ok(s.panel.classList.contains('pending'));
  assert.equal(s.start.disabled, true);
  assert.equal(s.stop.disabled, true);
  assert.equal(s.port.disabled, true);
  assert.equal(env.get('telemetryStatusPending'), true);

  // Background status polls are suppressed while pending.
  await w.refreshTelemetryStatus();
  assert.equal(env.callsTo('/api/telemetry/status').length, 0);

  await pending;
  assert.equal(env.fetchCalls[0].url, '/api/telemetry/start?port=21000');
  assert.equal(env.fetchCalls[0].init.method, 'POST');
  assert.equal(env.callsTo('/api/telemetry/status').length, 1);
  s = ui(env);
  assert.equal(s.text, 'UDP On');
  assert.ok(!s.panel.classList.contains('pending'));
  assert.equal(w.localStorage.getItem('udpTelemetryPort'), '21000');
  assert.equal(env.get('telemetryStatusPending'), false);
});

test('start failure shows an error state', async () => {
  const env = createDashboard({ fetch: () => jsonResponse({}, 409) });
  await env.window.startUdpTelemetry();
  const s = ui(env);
  assert.equal(s.text, 'Start failed');
  assert.equal(s.drivers, '0 drivers');
  assert.equal(s.start.disabled, false);
  assert.equal(env.logs.error[0][0], 'Error starting UDP telemetry:');
  assert.equal(env.get('telemetryStatusPending'), false);
});

test('stop button stops the listener; failure keeps it running', async () => {
  let fail = false;
  const env = createDashboard({
    fetch: (url) => {
      if (url === '/api/telemetry/stop') return fail ? jsonResponse({}, 500) : jsonResponse({});
      return jsonResponse({ running: false, active_drivers: 0 });
    }
  });
  const w = env.window;
  w.initializeTelemetryControls();
  await env.flush();
  env.fetchCalls.length = 0;
  ui(env).stop.disabled = false;
  ui(env).stop.click();
  assert.equal(ui(env).text, 'Stopping');
  await env.flush();
  assert.equal(env.fetchCalls[0].url, '/api/telemetry/stop');
  assert.equal(env.fetchCalls[0].init.method, 'POST');
  assert.equal(ui(env).text, 'UDP Off');

  fail = true;
  await w.stopUdpTelemetry();
  const s = ui(env);
  assert.equal(s.text, 'Stop failed');
  assert.ok(s.panel.classList.contains('running'));
  assert.equal(s.stop.disabled, false);
  assert.equal(env.logs.error[0][0], 'Error stopping UDP telemetry:');
});

test('status errors show "Status unavailable"', async () => {
  const env = createDashboard({ fetch: () => { throw new Error('down'); } });
  await env.window.refreshTelemetryStatus();
  assert.equal(ui(env).text, 'Status unavailable');
});

test('updateTelemetryControls handles odd payloads and missing elements', () => {
  const env = createDashboard();
  const w = env.window;
  w.updateTelemetryControls(null);
  assert.equal(ui(env).text, 'UDP Off');
  assert.equal(ui(env).drivers, '0 drivers');
  w.updateTelemetryControls({ running: 'yes', active_drivers: 2.5 });
  assert.equal(ui(env).text, 'UDP Off');
  assert.equal(ui(env).drivers, '0 drivers');

  const sparse = createDashboard({ html: '<div id="udpPanel" class="running"></div>' });
  sparse.window.updateTelemetryControls({ running: true });
  sparse.window.setTelemetryPending('Starting');
  assert.ok(sparse.document.getElementById('udpPanel').classList.contains('pending'));
  assert.ok(!sparse.document.getElementById('udpPanel').classList.contains('running'));

  const empty = createDashboard({ html: '<div></div>' });
  assert.doesNotThrow(() => empty.window.setTelemetryPending('Starting'));
  assert.equal(empty.get('telemetryStatusPending'), true);
});
