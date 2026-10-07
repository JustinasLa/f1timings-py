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

test('narrow layouts never receive a negative width or exceed available space', () => {
  for (const width of [526, 300, 6, 0]) {
    const env = createDashboard();
    const layout = withGeometry(env, { width });
    const applied = env.window.applyLayoutLeftWidth(1000);
    assert.ok(applied >= 0);
    assert.ok(applied <= Math.max(0, width - 6));
    assert.equal(parseFloat(leftWidth(layout)), applied);
  }
});

test('cancel, blur and lost capture finish dragging and stop subsequent moves', () => {
  const env = createDashboard();
  const layout = withGeometry(env);
  const doc = env.document;
  const w = env.window;
  w.initializeLayoutDivider();
  const divider = doc.getElementById('layoutDivider');
  for (const [target, type] of [[doc, 'pointercancel'], [w, 'blur'], [divider, 'lostpointercapture']]) {
    divider.dispatchEvent(new w.MouseEvent('pointerdown', { clientX: 450, bubbles: true }));
    target.dispatchEvent(new w.Event(type));
    doc.dispatchEvent(new w.MouseEvent('pointermove', { clientX: 700 }));
    assert.equal(leftWidth(layout), '400px');
    assert.equal(env.get('isDraggingDivider'), false);
    assert.ok(!doc.body.classList.contains('layout-resizing'));
  }
  divider.dispatchEvent(new w.MouseEvent('pointerdown', { button: 2, clientX: 800, bubbles: true }));
  assert.equal(leftWidth(layout), '400px', 'secondary button does not resize');
});

test('pointer capture follows only the active pointer and releases on completion', () => {
  const env = createDashboard();
  const layout = withGeometry(env);
  const divider = env.document.getElementById('layoutDivider');
  const w = env.window;
  let captured = null;
  divider.setPointerCapture = id => { captured = id; };
  divider.hasPointerCapture = id => captured === id;
  divider.releasePointerCapture = () => { captured = null; };
  w.onDividerPointerDown({ button: 0, pointerId: 7, clientX: 450, preventDefault() {} });
  assert.equal(captured, 7);
  w.onDividerPointerDown({ pointerId: 8, clientX: 800, preventDefault() {} });
  w.onDividerPointerUp({ pointerId: 8 });
  assert.equal(captured, 7, 'another pointer cannot replace or finish the drag');
  w.onDividerPointerMove({ pointerId: 8, clientX: 800 });
  assert.equal(leftWidth(layout), '400px');
  w.onDividerPointerMove({ pointerId: 7, clientX: 500 });
  assert.equal(leftWidth(layout), '450px');
  w.onDividerPointerUp({ pointerId: 7 });
  assert.equal(captured, null);

  // A browser can notify us after it has already released capture.
  w.onDividerPointerDown({ pointerId: 7, clientX: 450, preventDefault() {} });
  captured = null;
  w.onDividerPointerUp({ type: 'blur' });
  assert.equal(env.get('dividerPointerId'), null);
  w.onDividerPointerDown({ pointerId: 7, clientX: 450, preventDefault() {} });
  delete divider.hasPointerCapture;
  w.onDividerPointerUp();
  w.onDividerPointerDown({ clientX: 450, preventDefault() {} });
  w.onDividerPointerUp();
});

test('keyboard resizing updates separator accessibility values and honours bounds', () => {
  const env = createDashboard();
  const layout = withGeometry(env);
  const divider = env.document.getElementById('layoutDivider');
  env.document.querySelector('.timing-area').getBoundingClientRect = () => ({ width: parseFloat(leftWidth(layout)) || 400 });
  const w = env.window;
  w.initializeLayoutDivider();
  assert.equal(divider.getAttribute('aria-valuenow'), '400');
  for (const [key, shiftKey, expected] of [['ArrowLeft', false, 390], ['ArrowRight', true, 440], ['Home', false, 240], ['End', false, 674]]) {
    const event = new w.KeyboardEvent('keydown', { key, shiftKey, cancelable: true });
    divider.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(leftWidth(layout), expected + 'px');
    assert.equal(divider.getAttribute('aria-valuenow'), String(expected));
  }
  assert.equal(divider.getAttribute('aria-valuemin'), '240');
  assert.equal(divider.getAttribute('aria-valuemax'), '674');
  assert.equal(divider.getAttribute('aria-valuetext'), 'Timing panel 674 pixels wide');
  const unrelated = new w.KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
  divider.dispatchEvent(unrelated);
  assert.equal(unrelated.defaultPrevented, false);
  layout.remove();
  assert.doesNotThrow(() => w.onDividerKeyDown({ key: 'Home' }));
});

test('divider initialization tolerates a missing layout', () => {
  const env = createDashboard({ html: '<div id="layoutDivider"></div>' });
  assert.doesNotThrow(() => env.window.initializeLayoutDivider());
});

test('auto fit reserves room for toolbar controls even with very few columns', () => {
  const env = createDashboard();
  const layout = withGeometry(env, { tableWidth: 180 });
  const header = env.document.querySelector('.section-title');
  header.style.width = '75%';
  Object.defineProperty(header, 'offsetWidth', { get: () => header.style.width === 'max-content' ? 480 : 100 });
  env.window.autoFitLayoutToColumns();
  assert.equal(leftWidth(layout), '480px');
  assert.equal(header.style.width, '75%');
  header.remove();
  env.window.autoFitLayoutToColumns();
  assert.equal(leftWidth(layout), '240px');
});
