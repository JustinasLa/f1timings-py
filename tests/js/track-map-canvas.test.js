'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard, jsonResponse, plain } = require('./harness.js');

const SQUARE = [
  { pos_x: 0, pos_z: 0 },
  { pos_x: 0, pos_z: 100 },
  { pos_x: 100, pos_z: 100 },
  { pos_x: 100, pos_z: 0 }
];

function withCanvas(env) {
  env.set('canvas', env.document.getElementById('trackCanvas'));
  env.set('ctx', env.ctx2d);
  return env;
}

function callNames(env) {
  return env.ctx2d.calls.map((c) => c.name);
}

function trackApi(trackData, extra = {}) {
  return (url, init) => {
    if (url in extra) return extra[url](url, init);
    if (url.startsWith('/api/track/data')) return jsonResponse(trackData);
    if (url.startsWith('/api/track/records')) return jsonResponse({ lap_times: [] });
    return jsonResponse({});
  };
}

test('loadCurrentTrack switches to the backend track and loads its data', async () => {
  const env = withCanvas(createDashboard({
    fetch: trackApi({ points: SQUARE }, { '/api/track': () => jsonResponse({ name: 'Monza' }) })
  }));
  const doc = env.document;
  await env.window.loadCurrentTrack();
  await env.flush();

  assert.equal(env.get('currentTrack'), 'monza');
  const title = doc.getElementById('sessionTitle');
  assert.equal(title.textContent, 'Monza');
  const flag = title.querySelector('img.track-country-flag');
  assert.equal(flag.alt, 'IT');
  assert.equal(flag.src, 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f1ee-1f1f9.svg');
  assert.equal(doc.getElementById('sessionLocation').textContent, 'Grand Prix Circuit');
  assert.equal(doc.getElementById('trackHeaderName').textContent, 'Monza - Track Map');
  assert.equal(doc.title, 'F1 Timings - Monza');
  assert.equal(env.callsTo('/api/track/data?track=monza').length, 1);
  assert.equal(env.callsTo('/api/track/records?track=monza').length, 1);
  assert.equal(doc.getElementById('trackCanvas').style.display, 'block');

  // Same track again: only the records are refreshed.
  await env.window.loadCurrentTrack();
  await env.flush();
  assert.equal(env.callsTo('/api/track/data').length, 1);
  assert.equal(env.callsTo('/api/track/records').length, 2);
});

test('loadCurrentTrack ignores empty, failed and erroring responses', async () => {
  let response = () => jsonResponse({});
  const env = createDashboard({ fetch: () => response() });
  await env.window.loadCurrentTrack();
  response = () => jsonResponse({ name: 'Monza' }, 500);
  await env.window.loadCurrentTrack();
  assert.equal(env.fetchCalls.length, 2);
  assert.equal(env.get('currentTrack'), '');

  response = () => { throw new Error('offline'); };
  await env.window.loadCurrentTrack();
  assert.equal(env.logs.error[0][0], 'Error loading track:');
});

test('updateTrackUI title-cases unknown tracks without a flag', () => {
  const env = createDashboard();
  env.set('currentTrack', 'my_test_track');
  env.window.updateTrackUI();
  const title = env.document.getElementById('sessionTitle');
  assert.equal(title.textContent, 'My Test Track');
  assert.equal(title.querySelector('img'), null);
  assert.equal(env.document.title, 'F1 Timings - My Test Track');
});

test('setTrackNameWithFlag tolerates a missing element', () => {
  const env = createDashboard();
  assert.doesNotThrow(() => env.window.setTrackNameWithFlag(null, 'x', 'monza'));
  assert.equal(env.window.getTwemojiFlagUrl('gb').endsWith('/1f1ec-1f1e7.svg'), true);
});

test('track select menu lists tracks, toggles and switches track', async () => {
  const env = withCanvas(createDashboard({ fetch: trackApi({ points: SQUARE }) }));
  const w = env.window;
  const doc = env.document;
  env.set('currentTrack', 'bahrain');
  await w.loadTrackSelectOptions();

  const toggle = doc.getElementById('trackSelectToggle');
  const menu = doc.getElementById('trackSelectMenu');
  const options = Array.from(menu.querySelectorAll('.track-select-option'));
  assert.equal(options.length, 25);
  assert.equal(options[0].dataset.track, 'abu_dhabi');
  assert.equal(options[0].textContent, 'Abu Dhabi');
  assert.deepEqual(options.filter((o) => o.classList.contains('active')).map((o) => o.dataset.track), ['bahrain']);

  toggle.click();
  assert.ok(menu.classList.contains('open'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.click();
  assert.ok(!menu.classList.contains('open'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');

  toggle.click();
  doc.body.click();
  assert.ok(!menu.classList.contains('open'), 'outside click closes the menu');

  toggle.click();
  menu.querySelector('[data-track="monaco"]').click();
  await env.flush();
  assert.ok(!menu.classList.contains('open'));
  assert.equal(env.get('currentTrack'), 'monaco');
  assert.ok(menu.querySelector('[data-track="monaco"]').classList.contains('active'));
  assert.ok(!menu.querySelector('[data-track="bahrain"]').classList.contains('active'));
  const post = env.fetchCalls.find((c) => c.url === '/api/track' && c.init.method === 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { name: 'monaco' });
  assert.equal(env.callsTo('/api/track/data?track=monaco').length, 1);
  assert.equal(env.callsTo('/api/track/records?track=monaco').length, 1);
});

test('track select menu handles missing elements and build errors', async () => {
  const noToggle = createDashboard({ html: '<div id="trackSelectMenu"></div>' });
  await noToggle.window.loadTrackSelectOptions();
  assert.equal(noToggle.document.getElementById('trackSelectMenu').children.length, 0);
  assert.doesNotThrow(() => noToggle.window.closeTrackSelectMenu());

  const noMenu = createDashboard({ html: '<button id="trackSelectToggle"></button>' });
  await noMenu.window.loadTrackSelectOptions();
  noMenu.window.closeTrackSelectMenu();
  assert.equal(noMenu.document.getElementById('trackSelectToggle').getAttribute('aria-expanded'), null);

  const broken = createDashboard();
  broken.document.getElementById('trackSelectMenu').replaceChildren = () => { throw new Error('dom broke'); };
  await broken.window.loadTrackSelectOptions();
  assert.equal(broken.logs.error[0][0], 'Error loading track options:');
});

test('switchDisplayTrack ignores empty/same names and logs save failures', async () => {
  const env = withCanvas(createDashboard({
    fetch: trackApi({ points: SQUARE }, { '/api/track': () => { throw new Error('nope'); } })
  }));
  env.set('currentTrack', 'monza');
  env.window.switchDisplayTrack('');
  env.window.switchDisplayTrack('monza');
  assert.equal(env.fetchCalls.length, 0);

  env.set('trackData', { points: [] });
  env.set('trackRendered', true);
  env.window.switchDisplayTrack('Japan');
  assert.equal(env.get('currentTrack'), 'japan');
  assert.equal(env.get('trackData'), null);
  assert.equal(env.get('trackRendered'), false);
  await env.flush();
  assert.equal(env.logs.error[0][0], 'Error setting track:');
  assert.equal(env.get('trackRendered'), true, 'japan map rendered');
});

test('loadTrackVisualization shows placeholders for missing or bad data', async () => {
  let data = () => jsonResponse({ points: [] });
  const env = withCanvas(createDashboard({ fetch: () => data() }));
  const placeholder = env.document.getElementById('trackPlaceholder');
  const message = () => placeholder.querySelector('div:last-child').textContent;
  const canvas = env.document.getElementById('trackCanvas');

  await env.window.loadTrackVisualization('Nowhere');
  assert.equal(message(), 'No map data for Nowhere');
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(placeholder.style.display, 'flex');
  assert.equal(canvas.style.display, 'none');

  await env.window.loadTrackVisualization('Monza');
  assert.equal(env.fetchCalls[0].url, '/api/track/data?track=monza');
  assert.equal(message(), 'No track points available');

  data = () => jsonResponse({});
  await env.window.loadTrackVisualization('monza');
  assert.equal(message(), 'No track points available');

  data = () => jsonResponse({}, 404);
  await env.window.loadTrackVisualization('monza');
  assert.equal(message(), 'Track data unavailable');
  assert.match(String(env.logs.error[0][1]), /HTTP 404/);
  assert.equal(env.get('trackData'), null);
});

test('loadTrackVisualization draws track outline, pit lane and markers', async () => {
  const td = {
    points: SQUARE,
    pitlane: [{ pos_x: 10, pos_z: 10 }, { pos_x: 10, pos_z: 90 }],
    markers: [
      { label: 'S/F', pos_x: 0, pos_z: 0 },
      { label: 'S1', pos_x: 100, pos_z: 100 }
    ]
  };
  const env = withCanvas(createDashboard({ fetch: () => jsonResponse(td) }));
  env.set('currentTrack', 'monza');
  await env.window.loadTrackVisualization('monza');

  assert.equal(env.document.getElementById('trackCanvas').style.display, 'block');
  assert.equal(env.document.getElementById('trackPlaceholder').style.display, 'none');
  const trackData = env.get('trackData');
  assert.ok(trackData.transformParams);
  assert.equal(env.get('trackRendered'), true);

  const calls = env.ctx2d.calls;
  assert.equal(calls[0].name, 'clearRect');
  assert.deepEqual(calls[0].args, [0, 0, 1200, 800]);
  const strokes = calls.filter((c) => c.name === 'stroke');
  assert.deepEqual(
    strokes.map((c) => c.state.strokeStyle),
    ['rgba(160,160,160,0.18)', '#9aa3ad', 'rgba(255,255,255,0.08)', '#e6edf3', '#ffffff', '#f1c40f']
  );
  const labels = calls.filter((c) => c.name === 'fillText');
  assert.deepEqual(labels.map((c) => [c.args[0], c.state.fillStyle]), [['S/F', '#ffffff'], ['S1', '#f1c40f']]);

  // The outline is closed: last lineTo returns to the first point.
  const outline = calls.slice(calls.findIndex((c) => c.state.strokeStyle === 'rgba(255,255,255,0.08)' && c.name === 'beginPath'));
  const first = outline.find((c) => c.name === 'moveTo').args;
  const lastLine = outline.filter((c) => c.name === 'lineTo')[SQUARE.length - 1].args;
  assert.deepEqual(lastLine, first);

  // All projected points stay inside the padded canvas.
  for (const c of calls.filter((x) => x.name === 'moveTo' || x.name === 'lineTo').slice(0, 10)) {
    assert.ok(c.args[0] >= 39.99 && c.args[0] <= 1160.01, `x ${c.args[0]}`);
    assert.ok(c.args[1] >= 39.99 && c.args[1] <= 760.01, `y ${c.args[1]}`);
  }
});

test('geometry helpers', () => {
  const env = withCanvas(createDashboard());
  const w = env.window;
  assert.deepEqual(plain(w.rotatePlanePoint(3, 4, 0)), { x: 3, y: 4 });
  const r = w.rotatePlanePoint(1, 0, 90);
  assert.ok(Math.abs(r.x) < 1e-12 && Math.abs(r.y - 1) < 1e-12);

  const transform = { minX: 10, minY: 20, scale: 2, centerOffsetX: 5, centerOffsetY: 6 };
  assert.deepEqual(plain(w.planeToCanvas(11, 21, {}, transform)), { x: 7, y: 8 });

  // Degenerate track (all points identical) does not divide by zero.
  const t = w.computeTrackTransform({ points: [{ pos_x: 0, pos_z: 0 }, { pos_x: 0, pos_z: 0 }] }, { d: 2, x_offset: 800, z_offset: 400 });
  assert.equal(t.scale, 720);
  assert.equal(t.minX, 800);
  assert.equal(t.minY, 400);
  assert.equal(t.centerOffsetX, 240);
  assert.equal(t.centerOffsetY, 40);

  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  assert.equal(w.findNearestPointIndex(pts, { x: 9, y: 9 }), 2);
  assert.equal(w.findNearestPointIndex([], { x: 0, y: 0 }), 0);
  const a0 = w.trackDirectionAcross(pts, 0); // neighbours: last and 1
  assert.ok(Math.abs(a0.x - 1) < 1e-12 && Math.abs(a0.y - 0) < 1e-12);
  const a2 = w.trackDirectionAcross(pts, 2); // neighbours: 1 and 0 (wraps)
  assert.ok(Math.abs(a2.x - 0) < 1e-12 && Math.abs(a2.y + 1) < 1e-12);
  assert.deepEqual(plain(w.trackDirectionAcross([{ x: 1, y: 1 }], 0)), { x: 0, y: 0 });

  w.strokeTrackOutline([]);
  w.drawTrackOnCanvas({ points: [{ pos_x: 0, pos_z: 0 }] }, { d: 1 });
  assert.equal(env.ctx2d.calls.length, 0);
});

test('redraw, pit lane and markers bail out on incomplete state', () => {
  const env = withCanvas(createDashboard());
  const w = env.window;
  const transform = { minX: 0, minY: 0, scale: 1, centerOffsetX: 0, centerOffsetY: 0 };

  w.redrawCompleteTrack();
  w.drawPitlane();
  w.drawTrackMarkers();
  env.set('trackData', { points: SQUARE });
  w.redrawCompleteTrack();
  w.drawPitlane();
  w.drawTrackMarkers();
  env.set('trackData', { points: SQUARE, transformParams: transform, pitlane: 'x', markers: 'x' });
  w.drawPitlane();
  w.drawTrackMarkers();
  env.set('trackData', { points: SQUARE, transformParams: transform, pitlane: [{}], markers: [] });
  w.drawPitlane();
  w.drawTrackMarkers();
  env.set('currentTrack', 'nowhere');
  env.set('trackData', {
    points: SQUARE, transformParams: transform,
    pitlane: [{ pos_x: 0, pos_z: 0 }, { pos_x: 1, pos_z: 1 }], markers: [{ label: 'S1', pos_x: 0, pos_z: 0 }]
  });
  w.redrawCompleteTrack();
  w.drawPitlane();
  w.drawTrackMarkers();
  assert.equal(env.ctx2d.calls.length, 0);

  env.set('currentTrack', 'japan');
  w.redrawCompleteTrack();
  assert.equal(callNames(env)[0], 'clearRect');
  assert.equal(env.ctx2d.calls.filter((c) => c.name === 'fillText').length, 1);
});

test('drawDriversOnTrack draws dots with colours and initials', () => {
  const env = withCanvas(createDashboard());
  const w = env.window;
  const transform = { minX: 0, minY: 0, scale: 1, centerOffsetX: 0, centerOffsetY: 0 };
  env.set('currentTrack', 'abu_dhabi'); // has driver offsets and rotation 25
  env.set('trackData', { points: SQUARE, transformParams: transform });

  w.drawDriversOnTrack({
    'Max Verstappen': { world_x: 100, world_z: 50, instance_index: 0 },
    k2: { name: '  lewis   hamilton ', world_x: 0, world_z: 0, instance_index: 3 },
    k3: { name: 'a b c d', world_x: 0, world_z: 0, instance_index: -1, team: 'Scuderia Ferrari' },
    '': { world_x: 0, world_z: 0, instance_index: 'x', team: 'nobody' },
    k5: { name: 'NoPos', world_x: null, world_z: 0 }
  });

  const calls = env.ctx2d.calls;
  assert.equal(calls[0].name, 'clearRect', 'track is redrawn first');
  const texts = calls.filter((c) => c.name === 'fillText');
  assert.deepEqual(texts.map((c) => c.args[0]), ['MV', 'LH', 'ABC', '']);
  const fills = calls.filter((c) => c.name === 'fill').map((c) => c.state.fillStyle);
  assert.deepEqual(fills, [
    'rgba(0,0,0,0.5)', '#1E78FF',
    'rgba(0,0,0,0.5)', '#FF8700',
    'rgba(0,0,0,0.5)', '#DC0000',
    'rgba(0,0,0,0.5)', '#a371f7'
  ]);
  const arcs = calls.filter((c) => c.name === 'arc');
  assert.deepEqual(arcs.slice(0, 3).map((c) => c.args[2]), [12, 10, 10]);

  // Position uses world coordinates plus the per-track driver offsets.
  const p = env.get('TRACK_DICTIONARY').abu_dhabi;
  const expected = w.planeToCanvas(100 / p.d + p.x_offset + p.driver_x_offset, 50 / p.d + p.z_offset + p.driver_z_offset, p, transform);
  assert.deepEqual(arcs[0].args.slice(0, 2), [expected.x, expected.y]);
  assert.deepEqual(texts[0].args.slice(1), [expected.x, expected.y]);
});

test('drawDriversOnTrack defaults driver offsets to zero', () => {
  const env = withCanvas(createDashboard());
  const transform = { minX: 0, minY: 0, scale: 1, centerOffsetX: 0, centerOffsetY: 0 };
  env.set('currentTrack', 'japan'); // no offsets, no rotation
  env.set('trackData', { points: SQUARE, transformParams: transform });
  env.window.drawDriversOnTrack({ a: { name: 'Al', world_x: 25, world_z: 5 } });
  const arc = env.ctx2d.calls.find((c) => c.name === 'arc');
  assert.deepEqual(arc.args.slice(0, 2), [25 / 2.5 + 800, 5 / 2.5 + 400]);
});

test('drawDriversOnTrack bails out without canvas, context, data or track params', () => {
  const env = createDashboard();
  const w = env.window;
  const driver = { a: { world_x: 0, world_z: 0 } };
  const transform = { minX: 0, minY: 0, scale: 1, centerOffsetX: 0, centerOffsetY: 0 };
  w.drawDriversOnTrack(driver); // no canvas
  env.set('canvas', env.document.getElementById('trackCanvas'));
  w.drawDriversOnTrack(driver); // no ctx
  env.set('ctx', env.ctx2d);
  w.drawDriversOnTrack(driver); // no trackData
  env.set('trackData', { points: SQUARE });
  w.drawDriversOnTrack(driver); // no transform
  env.set('trackData', { points: SQUARE, transformParams: transform });
  env.set('currentTrack', 'nowhere');
  w.drawDriversOnTrack(driver); // unknown track
  assert.equal(env.ctx2d.calls.length, 0);
});

test('getLiveDriverColor prefers instance colours, then team colours', () => {
  const { window: w } = createDashboard();
  assert.equal(w.getLiveDriverColor({ instance_index: 1 }), '#FF8700');
  assert.equal(w.getLiveDriverColor({ instance_index: 2 }), '#1E78FF');
  assert.equal(w.getLiveDriverColor({ instance_index: -1, team: 'Williams Racing' }), '#005AFF');
  assert.equal(w.getLiveDriverColor({ team: 'nobody' }), '#a371f7');
});

test('track select falls back to a title-cased label for tracks without a display name', async () => {
  const env = createDashboard();
  env.get('TRACK_DICTIONARY').zz_new_circuit = { d: 2, x_offset: 800, z_offset: 400 };
  await env.window.loadTrackSelectOptions();
  const option = env.document.querySelector('[data-track="zz_new_circuit"]');
  assert.equal(option.textContent, 'Zz New Circuit');
});

test('track canvas backing store follows devicePixelRatio', () => {
  const env = withCanvas(createDashboard());
  const canvas = env.document.getElementById('trackCanvas');
  const setTransforms = () => env.ctx2d.calls.filter((c) => c.name === 'setTransform');
  env.set('currentTrack', 'japan');
  env.window.drawTrackOnCanvas({ points: SQUARE }, env.get('TRACK_DICTIONARY').japan);
  assert.deepEqual([canvas.width, canvas.height], [1200, 800]);
  assert.equal(setTransforms().length, 0);
  env.set('trackData', { points: SQUARE, transformParams: { minX: 0, minY: 0, scale: 1, centerOffsetX: 0, centerOffsetY: 0 } });

  // Browser zoom / moving to a HiDPI monitor is picked up on the next redraw.
  env.window.devicePixelRatio = 2;
  env.ctx2d.calls.length = 0;
  env.window.redrawCompleteTrack();
  assert.deepEqual([canvas.width, canvas.height], [2400, 1600]);
  assert.deepEqual(setTransforms().map((c) => c.args), [[2, 0, 0, 2, 0, 0]]);
  // Drawing stays in logical 1200x800 units.
  assert.deepEqual(env.ctx2d.calls[1].args, [0, 0, 1200, 800]);

  env.window.redrawCompleteTrack();
  assert.equal(setTransforms().length, 1, 'no resize when unchanged');
});
