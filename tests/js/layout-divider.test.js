'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard } = require('./harness.js');

// jsdom does no layout, so give the elements fixed geometry.
function withGeometry(env, { width = 1000, left = 50, tableWidth = 400 } = {}) {
  const layout = env.document.querySelector('.main-layout');
  Object.defineProperty(layout, 'clientWidth', { configurable: true, get: () => width });
  layout.getBoundingClientRect = () => ({ left, top: 0, right: left + width, bottom: 0, width, height: 0 });
  const table = env.document.querySelector('.timing-table');
  if (table) {
    Object.defineProperty(table, 'offsetWidth', {
      configurable: true,
      get: () => (table.style.width === 'max-content' ? tableWidth : 123)
    });
  }
  return layout;
}

const leftWidth = (layout) => layout.style.getPropertyValue('--left-width');

test('applyLayoutLeftWidth clamps to the minimum and maximum widths', () => {
  const env = createDashboard();
  const layout = withGeometry(env);
  const w = env.window;
  assert.equal(w.applyLayoutLeftWidth(100), 240);
  assert.equal(leftWidth(layout), '240px');
  assert.equal(w.applyLayoutLeftWidth(5000), 1000 - 6 - 320);
  assert.equal(leftWidth(layout), '674px');
  assert.equal(w.applyLayoutLeftWidth(500), 500);
});

test('layout helpers are no-ops without the layout or table', () => {
  const env = createDashboard({ html: '<div></div>' });
  const w = env.window;
  assert.equal(w.applyLayoutLeftWidth(500), undefined);
  assert.doesNotThrow(() => w.autoFitLayoutToColumns());
  assert.doesNotThrow(() => w.resizeFromPointer(10));
});

test('autoFitLayoutToColumns sizes the left panel to the natural table width', () => {
  const env = createDashboard();
  const layout = withGeometry(env, { tableWidth: 400 });
  const table = env.document.querySelector('.timing-table');
  table.style.width = '50%';
  env.window.autoFitLayoutToColumns();
  assert.equal(leftWidth(layout), '418px');
  assert.equal(table.style.width, '50%', 'original width restored');
});

test('dragging the divider resizes the panels', () => {
  const env = createDashboard();
  const w = env.window;
  const doc = env.document;
  const layout = withGeometry(env, { left: 50 });
  w.initializeLayoutDivider();
  const divider = doc.getElementById('layoutDivider');

  doc.dispatchEvent(new w.Event('pointermove'));
  doc.dispatchEvent(new w.Event('pointerup'));
  assert.equal(leftWidth(layout), '', 'moves before dragging are ignored');

  const down = new w.MouseEvent('pointerdown', { clientX: 450, cancelable: true, bubbles: true });
  divider.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  assert.ok(divider.classList.contains('dragging'));
  assert.ok(doc.body.classList.contains('layout-resizing'));
  assert.equal(leftWidth(layout), '400px');

  doc.dispatchEvent(new w.MouseEvent('pointermove', { clientX: 550 }));
  assert.equal(leftWidth(layout), '500px');

  doc.dispatchEvent(new w.Event('pointerup'));
  assert.ok(!divider.classList.contains('dragging'));
  assert.ok(!doc.body.classList.contains('layout-resizing'));
  assert.equal(env.get('isDraggingDivider'), false);

  doc.dispatchEvent(new w.MouseEvent('pointermove', { clientX: 650 }));
  assert.equal(leftWidth(layout), '500px');
});

test('pointer handlers work when the divider element disappears', () => {
  const env = createDashboard();
  const w = env.window;
  const layout = withGeometry(env, { left: 0 });
  env.document.getElementById('layoutDivider').remove();
  let prevented = false;
  w.onDividerPointerDown({ clientX: 300, preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.equal(leftWidth(layout), '300px');
  w.onDividerPointerUp();
  assert.equal(env.get('isDraggingDivider'), false);
  assert.ok(!env.document.body.classList.contains('layout-resizing'));
});

test('window resize re-clamps the stored width', () => {
  const env = createDashboard();
  const w = env.window;
  let width = 1000;
  const layout = env.document.querySelector('.main-layout');
  Object.defineProperty(layout, 'clientWidth', { configurable: true, get: () => width });
  w.initializeLayoutDivider();

  w.dispatchEvent(new w.Event('resize'));
  assert.equal(leftWidth(layout), '', 'nothing stored yet');

  w.applyLayoutLeftWidth(600);
  width = 800;
  w.dispatchEvent(new w.Event('resize'));
  assert.equal(leftWidth(layout), '474px');

  layout.remove();
  assert.doesNotThrow(() => w.dispatchEvent(new w.Event('resize')));
});

test('initializeLayoutDivider without a divider registers nothing', () => {
  const env = createDashboard({ html: '<div class="main-layout"></div>' });
  const layout = withGeometry(env);
  env.window.initializeLayoutDivider();
  env.window.applyLayoutLeftWidth(600);
  Object.defineProperty(layout, 'clientWidth', { configurable: true, get: () => 700 });
  env.window.dispatchEvent(new env.window.Event('resize'));
  assert.equal(leftWidth(layout), '600px', 'no resize handler installed');
});
