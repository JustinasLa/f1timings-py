'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard, plain, breakLocalStorage, SCRIPT_ORDER } = require('./harness.js');

const KEY = 'leaderboardColumns';

function hiddenColumns(env) {
  return Array.from(env.document.querySelector('.timing-table').classList).filter((c) => c.startsWith('hide-col-'));
}

function switches(env) {
  const out = {};
  for (const input of env.document.querySelectorAll('#columnSettingsMenu input[data-column]')) {
    out[input.dataset.column] = input.checked;
  }
  return out;
}

test('initializeColumnSettings applies defaults when nothing is saved', () => {
  const env = createDashboard();
  env.window.initializeColumnSettings();
  assert.deepEqual(hiddenColumns(env), ['hide-col-potential', 'hide-col-consistency']);
  assert.deepEqual(switches(env), {
    pos: true, topspeed: true, bestlap: true, potential: false, sectors: true, gap: true, interval: true,
    consistency: false, laps: true
  });
});

test('saved settings are loaded, ignoring non-boolean values', () => {
  const env = createDashboard();
  env.window.localStorage.setItem(KEY, JSON.stringify({ pos: false, potential: true, consistency: true, gap: 'no', bogus: false }));
  env.window.initializeColumnSettings();
  assert.deepEqual(hiddenColumns(env), ['hide-col-pos']);
  assert.equal(switches(env).potential, true);
  assert.equal(switches(env).gap, true);
  assert.equal(env.get('columnVisibility').bogus, undefined);
});

test('corrupt saved settings are logged and defaults kept', () => {
  const env = createDashboard();
  env.window.localStorage.setItem(KEY, '{not json');
  env.window.loadColumnSettings();
  assert.equal(env.logs.error[0][0], 'Could not read column settings:');
  assert.equal(env.get('columnVisibility').pos, true);
});

test('saveColumnSettings persists and logs storage failures', () => {
  const env = createDashboard();
  env.window.saveColumnSettings();
  assert.deepEqual(JSON.parse(env.window.localStorage.getItem(KEY)), plain(env.get('columnVisibility')));
  breakLocalStorage(env.window);
  env.window.saveColumnSettings();
  assert.equal(env.logs.error[0][0], 'Could not save column settings:');
});

test('toggling a switch hides the column, saves and refits the layout', () => {
  const env = createDashboard();
  const w = env.window;
  let refits = 0;
  w.initializeColumnSettings();
  env.set('autoFitLayoutToColumns', () => { refits++; });

  const gap = env.document.querySelector('input[data-column="gap"]');
  gap.click();
  assert.equal(gap.checked, false);
  assert.deepEqual(hiddenColumns(env), ['hide-col-potential', 'hide-col-consistency', 'hide-col-gap']);
  assert.equal(JSON.parse(w.localStorage.getItem(KEY)).gap, false);
  assert.equal(refits, 1);

  gap.click();
  assert.deepEqual(hiddenColumns(env), ['hide-col-potential', 'hide-col-consistency']);
  assert.equal(refits, 2);
});

test('toggling a switch works without the layout module', () => {
  const env = createDashboard({
    scripts: SCRIPT_ORDER.filter((s) => s !== 'layout-divider.js' && s !== 'start-dashboard.js')
  });
  env.window.initializeColumnSettings();
  env.document.querySelector('input[data-column="laps"]').click();
  assert.ok(hiddenColumns(env).includes('hide-col-laps'));
});

test('settings menu opens with the toggle and closes on outside clicks', () => {
  const env = createDashboard();
  const doc = env.document;
  const docListeners = [];
  const original = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, fn, opts) => { docListeners.push(fn); return original(type, fn, opts); };
  env.window.initializeColumnSettings();

  const toggle = doc.getElementById('columnSettingsToggle');
  const menu = doc.getElementById('columnSettingsMenu');
  toggle.click();
  assert.ok(menu.classList.contains('open'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');

  menu.querySelector('.column-settings-head').click();
  assert.ok(menu.classList.contains('open'), 'clicks inside the menu keep it open');

  // The toggle stops propagation, but the document handler must also
  // ignore a click whose target is the toggle itself.
  docListeners[0]({ target: toggle });
  assert.ok(menu.classList.contains('open'));

  doc.body.click();
  assert.ok(!menu.classList.contains('open'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');

  toggle.click();
  toggle.click();
  assert.ok(!menu.classList.contains('open'));
});

test('missing table or menu elements are tolerated', () => {
  const noTable = createDashboard({ html: '<div id="columnSettingsMenu"></div>' });
  assert.doesNotThrow(() => noTable.window.initializeColumnSettings());

  const noMenu = createDashboard({ html: '<table class="timing-table"></table><button id="columnSettingsToggle"></button>' });
  noMenu.window.initializeColumnSettings();
  assert.equal(noMenu.document.getElementById('columnSettingsToggle').onclick, null);
  assert.ok(noMenu.document.querySelector('.timing-table').classList.contains('hide-col-potential'));
});
