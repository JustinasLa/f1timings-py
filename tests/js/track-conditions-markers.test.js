'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard, jsonResponse } = require('./harness.js');

test('formatTemperature rounds or shows placeholder', () => {
  const { window: w } = createDashboard();
  assert.equal(w.formatTemperature(null), '--°C');
  assert.equal(w.formatTemperature(undefined), '--°C');
  assert.equal(w.formatTemperature(31.6), '32°C');
});

test('updateTrackConditions shows temperatures and throttles requests', async () => {
  let payload = { available: true, trackTemperature: 40.4, airTemperature: 25.5 };
  const env = createDashboard({ fetch: () => jsonResponse(payload) });
  const w = env.window;
  const doc = env.document;
  await w.updateTrackConditions();
  assert.equal(env.fetchCalls[0].url, '/api/telemetry/session');
  assert.equal(doc.getElementById('mapConditions').style.display, 'flex');
  assert.equal(doc.getElementById('conditionTrackTemp').textContent, '40°C');
  assert.equal(doc.getElementById('conditionAirTemp').textContent, '26°C');

  env.clock.advance(999);
  await w.updateTrackConditions();
  assert.equal(env.fetchCalls.length, 1, 'throttled within 1s');

  env.clock.advance(1);
  payload = { available: false };
  await w.updateTrackConditions();
  assert.equal(env.fetchCalls.length, 2);
  assert.equal(doc.getElementById('mapConditions').style.display, 'none');

  env.clock.advance(1000);
  payload = null;
  doc.getElementById('mapConditions').style.display = 'flex';
  await w.updateTrackConditions();
  assert.equal(doc.getElementById('mapConditions').style.display, 'none');
});

test('updateTrackConditions tolerates missing elements and fetch errors', async () => {
  const noContainer = createDashboard();
  noContainer.document.getElementById('mapConditions').remove();
  await noContainer.window.updateTrackConditions();
  assert.equal(noContainer.fetchCalls.length, 0);

  const noValues = createDashboard({
    html: '<div id="mapConditions" style="display:none"></div>',
    fetch: () => jsonResponse({ available: true })
  });
  await noValues.window.updateTrackConditions();
  assert.equal(noValues.document.getElementById('mapConditions').style.display, 'flex');

  const failing = createDashboard({ fetch: () => jsonResponse({}, 500) });
  await failing.window.updateTrackConditions();
  assert.equal(failing.logs.error[0][0], 'Error loading track conditions:');
  assert.equal(failing.document.getElementById('mapConditions').style.display, 'none');
});

test('conditions never overlap even when a response exceeds the refresh gap', async () => {
  let resolve;
  const env = createDashboard({ fetch: () => new Promise(r => { resolve = r; }) });
  const first = env.window.updateTrackConditions();
  await env.flush();
  env.clock.advance(1000);
  await env.window.updateTrackConditions();
  assert.equal(env.fetchCalls.length, 1);
  resolve(jsonResponse({available:true,trackTemperature:40,airTemperature:20}));
  await first;
  assert.equal(env.get('conditionsInFlight'),false);
  const second = env.window.updateTrackConditions();
  await env.flush();
  assert.equal(env.fetchCalls.length,2);
  resolve(jsonResponse({},500));
  await second;
  assert.equal(env.get('conditionsInFlight'),false);
  assert.equal(env.document.getElementById('mapConditions').style.display,'none');
});

test('old-track conditions responses and errors leave the new view alone', async () => {
  let resolve;
  const env = createDashboard({ fetch: () => new Promise(r => { resolve = r; }) });
  env.set('currentTrack','japan');
  const first = env.window.updateTrackConditions();
  await env.flush();
  env.set('currentTrack','monza');
  resolve(jsonResponse({available:true,trackTemperature:40}));
  await first;
  assert.equal(env.document.getElementById('mapConditions').style.display,'none');
  env.clock.advance(1000);
  const second = env.window.updateTrackConditions();
  await env.flush();
  env.set('currentTrack','spain');
  resolve(jsonResponse({},500));
  await second;
  assert.equal(env.logs.error.length,0);
  assert.equal(env.get('conditionsInFlight'),false);
});
