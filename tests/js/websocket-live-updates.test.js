'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard, jsonResponse } = require('./harness.js');

function api(url) {
  if (url === '/api/track') return jsonResponse({ name: 'Monza' });
  if (url.startsWith('/api/track/records')) return jsonResponse({ lap_times: [] });
  if (url.startsWith('/api/track/data')) return jsonResponse({ points: [] });
  return jsonResponse({ running: true, active_drivers: 2 });
}

function send(socket, msg) {
  socket.onmessage({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
}

test('connects to ws:// on http pages and loads the track on open', async () => {
  const env = createDashboard({ fetch: api });
  env.set('canvas', env.document.getElementById('trackCanvas'));
  env.window.initializeWebSocket();
  assert.equal(env.sockets.length, 1);
  assert.equal(env.sockets[0].url, 'ws://localhost:8000/ws');
  assert.equal(env.get('socket'), env.sockets[0]);

  env.sockets[0].onopen();
  await env.flush();
  assert.deepEqual(env.logs.log[0], ['WS connected']);
  assert.equal(env.fetchCalls[0].url, '/api/track');
  assert.equal(env.get('currentTrack'), 'monza');
});

test('connects to wss:// on https pages', () => {
  const env = createDashboard({ url: 'https://example.test/' });
  env.window.initializeWebSocket();
  assert.equal(env.sockets[0].url, 'wss://example.test/ws');
});

test('laptime_update shows a toast and reloads the leaderboard', async () => {
  const env = createDashboard({ fetch: api });
  env.window.initializeWebSocket();
  env.set('currentTrack', 'monza');
  send(env.sockets[0], { type: 'laptime_update', data: { name: 'Ann', time: '1:30.000' } });
  await env.flush();
  assert.equal(env.document.querySelectorAll('#lap-toast-container .lap-toast').length, 1);
  assert.equal(env.callsTo('/api/track/records?track=monza').length, 1);

  send(env.sockets[0], { type: 'laptime_update' });
  await env.flush();
  assert.equal(env.document.querySelectorAll('#lap-toast-container .lap-toast').length, 1);
  assert.equal(env.callsTo('/api/track/records').length, 2);
});

test('track_update switches track only when it changes', async () => {
  const env = createDashboard({ fetch: api });
  env.set('canvas', env.document.getElementById('trackCanvas'));
  env.window.initializeWebSocket();
  const socket = env.sockets[0];

  send(socket, { type: 'track_update', data: { name: 'Spain' } });
  await env.flush();
  assert.equal(env.get('currentTrack'), 'spain');
  assert.equal(env.document.getElementById('sessionTitle').textContent, 'Spain');
  assert.equal(env.callsTo('/api/track/data?track=spain').length, 1);
  assert.equal(env.callsTo('/api/track/records?track=spain').length, 1);

  send(socket, { type: 'track_update', data: { name: 'SPAIN' } });
  send(socket, { type: 'track_update', data: {} });
  send(socket, { type: 'track_update' });
  await env.flush();
  assert.equal(env.fetchCalls.length, 2);
  assert.equal(env.get('currentTrack'), 'spain');
});

test('telemetry_update refreshes UDP status; bad and unknown messages are ignored', async () => {
  const env = createDashboard({ fetch: api });
  env.window.initializeWebSocket();
  send(env.sockets[0], { type: 'telemetry_update' });
  await env.flush();
  assert.equal(env.fetchCalls[0].url, '/api/telemetry/status');
  assert.equal(env.document.getElementById('udpStatusText').textContent, 'UDP On');

  assert.doesNotThrow(() => send(env.sockets[0], '{not json'));
  send(env.sockets[0], { type: 'something_else' });
  await env.flush();
  assert.equal(env.fetchCalls.length, 1);
});

test('reconnects 2s after close; errors close the socket', () => {
  const env = createDashboard();
  env.window.initializeWebSocket();
  const first = env.sockets[0];
  first.onerror();
  assert.equal(first.closed, true);
  assert.equal(env.sockets.length, 1);
  env.clock.advance(1999);
  assert.equal(env.sockets.length, 1);
  env.clock.advance(1);
  assert.equal(env.sockets.length, 2);
  assert.equal(env.get('socket'), env.sockets[1]);
});
