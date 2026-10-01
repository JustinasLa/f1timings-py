'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard, jsonResponse, SCRIPT_ORDER } = require('./harness.js');

function api(url) {
  if (url === '/api/track') return jsonResponse({ name: 'monaco' });
  if (url.startsWith('/api/track/data')) return jsonResponse({ points: [{ pos_x: 0, pos_z: 0 }, { pos_x: 50, pos_z: 50 }] });
  if (url.startsWith('/api/track/records')) return jsonResponse({ lap_times: [{ driver: 'Ann', time: '1:12.000' }] });
  if (url === '/api/telemetry/status') return jsonResponse({ running: false, active_drivers: 0 });
  if (url === '/api/telemetry/driver_aliases') return jsonResponse({});
  return jsonResponse({});
}

// jsdom fires DOMContentLoaded asynchronously after construction, just like
// a browser, so `before` can still tweak the environment.
async function boot(options = {}, before = () => {}) {
  const env = createDashboard({ scripts: SCRIPT_ORDER, fetch: api, ...options });
  assert.equal(env.document.readyState, 'loading');
  before(env);
  await new Promise((resolve) => env.document.addEventListener('DOMContentLoaded', resolve));
  await env.flush(20);
  return env;
}

test('DOMContentLoaded initialises every part of the dashboard', async () => {
  const env = await boot();
  const doc = env.document;

  assert.equal(env.get('canvas'), doc.getElementById('trackCanvas'));
  assert.equal(env.get('ctx'), env.ctx2d);
  assert.ok(doc.querySelector('.timing-table').classList.contains('hide-col-potential'));
  assert.equal(env.sockets.length, 1);
  assert.equal(doc.querySelectorAll('.track-select-option').length, 25);
  assert.equal(env.get('currentTrack'), 'monaco');
  assert.ok(doc.querySelector('.track-select-option[data-track="monaco"]').classList.contains('active'));
  assert.equal(doc.getElementById('trackCanvas').style.display, 'block');
  assert.equal(env.get('trackRendered'), true);
  assert.equal(doc.querySelector('#timingTableBody tr.clickable-row').dataset.driver, 'Ann');
  assert.equal(doc.getElementById('udpStatusText').textContent, 'UDP Off');
  for (const url of ['/api/track', '/api/telemetry/driver_aliases', '/api/telemetry/status', '/api/drivers/live']) {
    assert.ok(env.fetchCalls.some((c) => c.url === url), url);
  }
  assert.deepEqual(
    env.clock.pending().filter((t) => t.interval !== null).map((t) => t.interval).sort((a, b) => a - b),
    [100, 2000]
  );
  assert.equal(env.logs.error.length, 0);
});

test('a failing init step is logged and the rest still run', async () => {
  const env = await boot({}, (e) => {
    e.window.WebSocket = function () { throw new Error('ws blocked'); };
  });
  assert.equal(env.logs.error[0][0], 'Dashboard init step failed:');
  assert.match(String(env.logs.error[0][1]), /ws blocked/);
  assert.ok(env.get('fetchDataInterval'), 'data fetching still started');
});

test('missing canvas leaves the drawing context unset', async () => {
  const env = await boot({ fetch: () => jsonResponse({}) }, (e) => e.document.getElementById('trackCanvas').remove());
  assert.equal(env.logs.error.length, 0);
  assert.equal(env.get('canvas'), null);
  assert.equal(env.get('ctx'), undefined);
});
