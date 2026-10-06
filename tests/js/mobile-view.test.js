'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDashboard, jsonResponse, REPO_ROOT } = require('./harness.js');

const MOBILE_HTML = fs
  .readFileSync(path.join(REPO_ROOT, 'static', 'mobile.html'), 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '');
const MOBILE_SCRIPTS = Array.from(
  fs.readFileSync(path.join(REPO_ROOT, 'static', 'mobile.html'), 'utf8').matchAll(/<script src="\/js\/([^"]+)"><\/script>/g),
  (m) => m[1]
);

async function boot(fetch) {
  const env = createDashboard({ html: MOBILE_HTML, scripts: MOBILE_SCRIPTS, fetch });
  await new Promise((resolve) => env.document.addEventListener('DOMContentLoaded', resolve));
  await env.flush(20);
  return env;
}

test('shows the current track leaderboard and refreshes it', async () => {
  let laps = [{ driver: 'Ann', time: '1:12.000' }];
  const env = await boot((url) => {
    if (url === '/api/track') return jsonResponse({ name: 'Monaco' });
    if (url === '/api/track/records?track=monaco') return jsonResponse({ lap_times: laps });
    throw new Error('unexpected ' + url);
  });
  const doc = env.document;

  assert.equal(doc.getElementById('sessionTitle').textContent, 'Monaco');
  assert.equal(doc.getElementById('driverCount').textContent, '1');
  assert.equal(doc.querySelector('#timingTableBody tr.clickable-row').dataset.driver, 'Ann');

  laps = [...laps, { driver: 'Bob', time: '1:11.000' }];
  env.clock.advance(3000);
  await env.flush(20);
  assert.deepEqual(
    Array.from(doc.querySelectorAll('#timingTableBody tr.clickable-row'), (r) => r.dataset.driver),
    ['Bob', 'Ann']
  );
  assert.equal(env.logs.error.length, 0);
});

test('unknown track names fall back to the raw name and bad records to empty', async () => {
  const env = await boot((url) => {
    if (url === '/api/track') return jsonResponse({ name: 'Test_Ring' });
    return jsonResponse({ lap_times: null });
  });
  assert.equal(env.document.getElementById('sessionTitle').textContent, 'Test_Ring');
  assert.match(env.document.getElementById('timingTableBody').textContent, /No timing data/);
});

test('no track set shows a placeholder without fetching records', async () => {
  const env = await boot(() => jsonResponse({}));
  assert.equal(env.document.getElementById('sessionTitle').textContent, 'No track selected');
  assert.equal(env.callsTo('/api/track/records').length, 0);
  assert.match(env.document.getElementById('timingTableBody').textContent, /No timing data/);
});

test('fetch failures are logged, not thrown', async () => {
  const env = await boot(() => jsonResponse({}, 500));
  assert.equal(env.logs.error[0][0], 'Error refreshing mobile view:');
});
