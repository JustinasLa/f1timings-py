'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard, jsonResponse, SCRIPT_ORDER } = require('./harness.js');

function interactions(beforeInitialize) {
  const env = createDashboard();
  const map = env.document.getElementById('trackCanvas');
  const wrap = map.parentElement;
  const tooltip = env.document.getElementById('mapDriverTooltip');
  Object.defineProperties(map, { offsetWidth: { configurable: true, value: 600 }, offsetHeight: { configurable: true, value: 400 } });
  Object.defineProperties(tooltip, { offsetWidth: { value: 180 }, offsetHeight: { value: 100 } });
  wrap.getBoundingClientRect = () => ({ left: 10, top: 20, width: map.offsetWidth, height: map.offsetHeight });
  map.getBoundingClientRect = () => {
    const { x, y, zoom } = transform(map);
    return { left: 10 + 300 * (1 - zoom) + x, top: 20 + 200 * (1 - zoom) + y, width: 600 * zoom, height: 400 * zoom };
  };
  env.captures = [];
  map.setPointerCapture = id => env.captures.push(id);
  env.map = map;
  env.tooltip = tooltip;
  if (beforeInitialize) beforeInitialize(env);
  env.window.initializeMapInteractions();
  return env;
}

function transform(map) {
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(map.style.transform);
  return match ? { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) } : { x: 0, y: 0, zoom: 1 };
}
function pointer(env, type, options = {}) {
  const event = new env.window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ pointerId: 1, button: 0, clientX: 310, clientY: 220, ...options })) Object.defineProperty(event, key, { value });
  env.map.dispatchEvent(event);
  return event;
}
function wheel(env, deltaY, clientX = 310, clientY = 220) {
  return pointer(env, 'wheel', { deltaY, clientX, clientY });
}
const button = (env, name) => env.document.getElementById(name);
function live(env, drivers, track = 'japan') {
  env.set('currentTrack', track);
  env.set('trackData', { transformParams: { minX: 800, minY: 400, scale: 1, centerOffsetX: 0, centerOffsetY: 0 } });
  env.set('latestLiveDrivers', drivers);
}
const driver = (extra = {}) => ({ world_x: 1500, world_z: 1000, name: 'Alice', team: 'Aurora', live_lap_active: true, live_sector_1_ms: 26000, live_sector_2_ms: 27000, ...extra });

test('map controls initialize once, expose reset and keep zoom state accessible', () => {
  const env = interactions();
  assert.deepEqual(transform(env.map), { x: 0, y: 0, zoom: 1 });
  assert.equal(button(env, 'mapZoomReset').textContent, '100%');
  assert.equal(button(env, 'mapZoomReset').getAttribute('aria-label'), 'Reset map zoom (100%)');
  assert.equal(button(env, 'mapZoomOut').disabled, true);
  env.window.initializeMapInteractions();
  button(env, 'mapZoomIn').click();
  assert.deepEqual(transform(env.map), { x: 0, y: 0, zoom: 1.25 });
  assert.equal(button(env, 'mapZoomReset').textContent, '125%');
  assert.equal(button(env, 'mapZoomOut').disabled, false);
  env.window.resetMapInteractions();
  assert.equal(transform(env.map).zoom, 1);
});

test('initialization tolerates each missing required element and reset before initialization', () => {
  for (const id of ['trackCanvas', 'mapZoomIn', 'mapZoomOut', 'mapZoomReset', 'mapDriverTooltip']) {
    const env = createDashboard({ scripts: ['map-interaction-controls.js'] });
    env.document.getElementById(id).remove();
    assert.doesNotThrow(() => env.window.resetMapInteractions());
    assert.doesNotThrow(() => env.window.initializeMapInteractions());
    assert.equal(env.get('mapInteractionController'), null);
  }
});

test('zoom controls clamp at 100 and 400 percent and wheel prevents page scrolling', () => {
  const env = interactions();
  for (let i = 0; i < 10; i++) button(env, 'mapZoomIn').click();
  assert.equal(transform(env.map).zoom, 4);
  assert.equal(button(env, 'mapZoomIn').disabled, true);
  assert.equal(wheel(env, -1).defaultPrevented, true);
  assert.equal(transform(env.map).zoom, 4);
  for (let i = 0; i < 10; i++) button(env, 'mapZoomOut').click();
  assert.equal(transform(env.map).zoom, 1);
  assert.equal(button(env, 'mapZoomOut').disabled, true);
  wheel(env, 1);
  assert.equal(transform(env.map).zoom, 1);
  wheel(env, -1, NaN, 220);
  assert.equal(transform(env.map).zoom, 1.25);
  wheel(env, -1, 310, NaN);
  assert.equal(transform(env.map).zoom, 1.5625);
});

test('wheel zoom anchors the cursor and reset button or double click restores the view', () => {
  const env = interactions();
  wheel(env, -1, 460, 320);
  assert.deepEqual(transform(env.map), { x: -37.5, y: -25, zoom: 1.25 });
  wheel(env, 1, 460, 320);
  assert.deepEqual(transform(env.map), { x: 0, y: 0, zoom: 1 });
  wheel(env, -1, 460, 320);
  button(env, 'mapZoomReset').click();
  assert.deepEqual(transform(env.map), { x: 0, y: 0, zoom: 1 });
  button(env, 'mapZoomIn').click();
  pointer(env, 'dblclick');
  assert.deepEqual(transform(env.map), { x: 0, y: 0, zoom: 1 });
});

test('drag panning captures only the primary pointer, clamps boundaries and hides tooltips', () => {
  const env = interactions();
  pointer(env, 'pointerdown');
  assert.deepEqual(env.captures, []);
  button(env, 'mapZoomIn').click();
  pointer(env, 'pointerdown', { button: 2 });
  assert.deepEqual(env.captures, []);
  env.tooltip.hidden = false;
  const down = pointer(env, 'pointerdown', { pointerId: 7 });
  assert.equal(down.defaultPrevented, true);
  assert.deepEqual(env.captures, [7]);
  assert.equal(env.map.classList.contains('map-dragging'), true);
  assert.equal(env.tooltip.hidden, true);
  pointer(env, 'pointermove', { pointerId: 99, clientX: 1000 });
  assert.deepEqual(transform(env.map), { x: 0, y: 0, zoom: 1.25 });
  pointer(env, 'pointermove', { pointerId: 7, clientX: 330, clientY: 210 });
  assert.deepEqual(transform(env.map), { x: 20, y: -10, zoom: 1.25 });
  pointer(env, 'pointermove', { pointerId: 7, clientX: 1000, clientY: 1000 });
  assert.deepEqual(transform(env.map), { x: 75, y: 50, zoom: 1.25 });
  pointer(env, 'pointermove', { pointerId: 7, clientX: -1000, clientY: -1000 });
  assert.deepEqual(transform(env.map), { x: -75, y: -50, zoom: 1.25 });
  pointer(env, 'pointerup', { pointerId: 99 });
  assert.equal(env.map.classList.contains('map-dragging'), true);
  pointer(env, 'pointerup', { pointerId: 7 });
  assert.equal(env.map.classList.contains('map-dragging'), false);
  pointer(env, 'pointerup', { pointerId: 7 });
});

test('cancelled and lost pointer capture gestures terminate; reset terminates an active drag', () => {
  const env = interactions();
  button(env, 'mapZoomIn').click();
  for (const end of ['pointercancel', 'lostpointercapture']) {
    pointer(env, 'pointerdown', { pointerId: 5 });
    pointer(env, end, { pointerId: 5 });
    assert.equal(env.map.classList.contains('map-dragging'), false);
  }
  pointer(env, 'pointerdown');
  env.window.resetMapInteractions();
  assert.equal(env.map.classList.contains('map-dragging'), false);
  assert.deepEqual(transform(env.map), { x: 0, y: 0, zoom: 1 });
});

test('wheel during a drag preserves zoom and the original pan anchor', () => {
  const env = interactions();
  button(env, 'mapZoomIn').click();
  pointer(env, 'pointerdown');
  pointer(env, 'pointermove', { clientX: 330 });
  assert.equal(wheel(env, -1).defaultPrevented, false);
  assert.deepEqual(transform(env.map), { x: 20, y: 0, zoom: 1.25 });
  pointer(env, 'pointermove', { clientX: 340 });
  assert.deepEqual(transform(env.map), { x: 30, y: 0, zoom: 1.25 });
});

test('horizontal-only and zero-delta wheel events do not zoom the map', () => {
  const env = interactions();
  button(env, 'mapZoomIn').click();
  assert.equal(pointer(env, 'wheel', { deltaX: 100, deltaY: 0 }).defaultPrevented, false);
  assert.equal(transform(env.map).zoom, 1.25);
  assert.equal(wheel(env, 0).defaultPrevented, false);
  assert.equal(transform(env.map).zoom, 1.25);
});

test('secondary pointers and additional pointerdowns cannot replace the primary drag', () => {
  const env = interactions();
  button(env, 'mapZoomIn').click();
  pointer(env, 'pointerdown', { isPrimary: false, pointerId: 2 });
  assert.deepEqual(env.captures, []);
  pointer(env, 'pointerdown', { pointerId: 7 });
  pointer(env, 'pointerdown', { pointerId: 8, clientX: 600 });
  assert.deepEqual(env.captures, [7]);
  pointer(env, 'pointermove', { pointerId: 7, clientX: 330 });
  assert.deepEqual(transform(env.map), { x: 20, y: 0, zoom: 1.25 });
  pointer(env, 'pointerup', { pointerId: 7 });
  live(env, { alice: driver() });
  pointer(env, 'pointermove', { isPrimary: false });
  assert.equal(env.tooltip.hidden, true);
});

test('divider resize observation clamps panning to the new map size while preserving zoom', () => {
  const env = interactions(before => {
    before.observed = [];
    before.window.ResizeObserver = class {
      constructor(callback) { before.resizeMap = callback; }
      observe(target) { before.observed.push(target); }
    };
  });
  assert.deepEqual(env.observed, [env.map, env.map.parentElement]);
  button(env, 'mapZoomIn').click();
  pointer(env, 'pointerdown');
  pointer(env, 'pointermove', { clientX: 1000, clientY: 1000 });
  pointer(env, 'pointerup');
  assert.deepEqual(transform(env.map), { x: 75, y: 50, zoom: 1.25 });
  Object.defineProperties(env.map, { offsetWidth: { value: 300 }, offsetHeight: { value: 200 } });
  env.tooltip.hidden = false;
  env.resizeMap();
  assert.deepEqual(transform(env.map), { x: 37.5, y: 25, zoom: 1.25 });
  assert.equal(env.tooltip.hidden, true);
  assert.equal(button(env, 'mapZoomReset').textContent, '125%');
  Object.defineProperties(env.map, { offsetWidth: { value: 160 }, offsetHeight: { value: 80 } });
  env.window.dispatchEvent(new env.window.Event('resize'));
  assert.deepEqual(transform(env.map), { x: 20, y: 10, zoom: 1.25 });
});

test('window resize clamps map pan when ResizeObserver is unavailable', () => {
  const env = interactions();
  assert.equal(typeof env.window.ResizeObserver, 'undefined');
  button(env, 'mapZoomIn').click();
  pointer(env, 'pointerdown');
  pointer(env, 'pointermove', { clientX: -1000, clientY: -1000 });
  pointer(env, 'pointerup');
  Object.defineProperties(env.map, { offsetWidth: { value: 200 }, offsetHeight: { value: 160 } });
  env.window.dispatchEvent(new env.window.Event('resize'));
  assert.deepEqual(transform(env.map), { x: -25, y: -20, zoom: 1.25 });
  assert.equal(button(env, 'mapZoomOut').disabled, false);
});

test('pan limits use the wrapper viewport when a letterboxed canvas is smaller', () => {
  const env = interactions();
  const wrap = env.map.parentElement;
  wrap.getBoundingClientRect = () => ({ left: 10, top: 20, width: 900, height: 500 });
  button(env, 'mapZoomIn').click();
  pointer(env, 'pointerdown');
  pointer(env, 'pointermove', { clientX: 1000, clientY: 1000 });
  assert.deepEqual(transform(env.map), { x: 0, y: 0, zoom: 1.25 });
  pointer(env, 'pointerup');
  button(env, 'mapZoomIn').click();
  pointer(env, 'pointerdown');
  pointer(env, 'pointermove', { clientX: 1000, clientY: 1000 });
  assert.deepEqual(transform(env.map), { x: 18.75, y: 62.5, zoom: 1.5625 });
  pointer(env, 'pointermove', { clientX: -1000, clientY: -1000 });
  assert.deepEqual(transform(env.map), { x: -18.75, y: -62.5, zoom: 1.5625 });
});

test('hover handles missing map data, transform, track, dimensions or nearby live positions', () => {
  const env = interactions();
  pointer(env, 'pointermove');
  assert.equal(env.tooltip.hidden, true);
  env.set('trackData', {});
  pointer(env, 'pointermove');
  assert.equal(env.tooltip.hidden, true);
  live(env, {}, 'unknown');
  pointer(env, 'pointermove');
  assert.equal(env.tooltip.hidden, true);
  live(env, { invalid: { world_x: null, world_z: 2 }, far: driver({ world_x: -10000 }) });
  pointer(env, 'pointermove');
  assert.equal(env.tooltip.hidden, true);
  const bounds = env.map.getBoundingClientRect;
  for (const rect of [{ width: 0, height: 400 }, { width: 600, height: 0 }]) {
    env.map.getBoundingClientRect = () => rect;
    pointer(env, 'pointermove');
    assert.equal(env.tooltip.hidden, true);
  }
  env.map.getBoundingClientRect = bounds;
});

test('hover selects the nearest live driver and renders name, team, lap state and sectors as text', () => {
  const env = interactions();
  live(env, { farther: driver({ world_x: 1540, name: 'Farther' }), alice: driver({ name: '<img src=x onerror=alert(1)>', team: '<script>alert(1)</script>' }) });
  pointer(env, 'pointermove');
  assert.equal(env.tooltip.hidden, false);
  assert.equal(env.tooltip.querySelector('strong').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(env.tooltip.querySelector('img,script'), null);
  assert.match(env.tooltip.textContent, /Flying lap/);
  assert.match(env.tooltip.textContent, /S1 26\.000.*S2 27\.000/);
  assert.equal(env.tooltip.style.left, '316px');
  assert.equal(env.tooltip.style.top, '216px');
  pointer(env, 'pointerleave');
  assert.equal(env.tooltip.hidden, true);
  live(env, { fallback: driver({ name: '', team: '', live_lap_active: false }) });
  pointer(env, 'pointermove');
  assert.match(env.tooltip.textContent, /fallbackUnknown teamBetween laps/);
  live(env, { invalid: driver({ live_lap_active: true, live_lap_invalid: true }) });
  pointer(env, 'pointermove');
  assert.match(env.tooltip.textContent, /Invalid lap/);
  button(env, 'mapZoomIn').click();
  assert.equal(env.tooltip.hidden, true);
});

test('hover uses the same rotated driver offsets as the rendered map and transformed canvas dimensions', () => {
  const env = interactions();
  live(env, { alice: driver() }, 'austria');
  const point = env.run('planeToCanvas(1500 / TRACK_DICTIONARY.austria.d + TRACK_DICTIONARY.austria.x_offset + TRACK_DICTIONARY.austria.driver_x_offset, 1000 / TRACK_DICTIONARY.austria.d + TRACK_DICTIONARY.austria.z_offset + TRACK_DICTIONARY.austria.driver_z_offset, TRACK_DICTIONARY.austria, trackData.transformParams)');
  let bounds = env.map.getBoundingClientRect();
  pointer(env, 'pointermove', { clientX: bounds.left + point.x / 1200 * bounds.width, clientY: bounds.top + point.y / 800 * bounds.height });
  assert.equal(env.tooltip.hidden, false);
  button(env, 'mapZoomIn').click();
  bounds = env.map.getBoundingClientRect();
  pointer(env, 'pointermove', { clientX: bounds.left + point.x / 1200 * bounds.width, clientY: bounds.top + point.y / 800 * bounds.height });
  assert.equal(env.tooltip.hidden, false);
});

test('hover tooltip clamps inside the viewport at every edge', () => {
  const env = interactions();
  live(env, { edge: driver({ world_x: 2975, world_z: 1975 }) });
  pointer(env, 'pointermove', { clientX: 605, clientY: 415 });
  assert.equal(env.tooltip.hidden, false);
  assert.equal(env.tooltip.style.left, '412px');
  assert.equal(env.tooltip.style.top, '292px');
  live(env, { edge: driver({ world_x: -100, world_z: -100 }) });
  pointer(env, 'pointermove', { clientX: -10, clientY: 0 });
  assert.equal(env.tooltip.hidden, false);
  assert.equal(env.tooltip.style.left, '8px');
  assert.equal(env.tooltip.style.top, '8px');
});

test('track reload resets initialized interactions and optional reset helper absence is supported', async () => {
  const env = interactions();
  env.set('canvas', env.map);
  env.set('ctx', env.ctx2d);
  env.set('currentTrack', 'japan');
  env.fetchHandler = () => jsonResponse({ points: [{ pos_x: 0, pos_z: 0 }, { pos_x: 100, pos_z: 100 }] });
  button(env, 'mapZoomIn').click();
  await env.window.loadTrackVisualization('japan');
  assert.equal(transform(env.map).zoom, 1);
  const optional = createDashboard({ scripts: SCRIPT_ORDER.filter(name => !['map-interaction-controls.js', 'start-dashboard.js'].includes(name)), fetch: env.fetchHandler });
  optional.set('canvas', optional.document.getElementById('trackCanvas'));
  optional.set('ctx', optional.ctx2d);
  await optional.window.loadTrackVisualization('japan');
  assert.equal(optional.document.getElementById('trackCanvas').style.display, 'block');
});
