'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard, jsonResponse, plain } = require('./harness.js');

function aliasRows(env) {
  return Array.from(env.document.querySelectorAll('.driver-alias-row')).map((row) => ({
    raw: row.querySelector('.driver-alias-raw').textContent,
    value: row.querySelector('.driver-alias-input').value,
    color: row.querySelector('.driver-alias-dot').style.background
  }));
}

test('loadDriverAliases fetches aliases and renders the panel', async () => {
  const env = createDashboard({ fetch: () => jsonResponse({ 'p1 raw': 'Alice' }) });
  env.set('latestLiveDrivers', { 0: { telemetry_name: 'P1 Raw', name: 'Whatever', instance_index: 0 } });
  await env.window.loadDriverAliases();
  assert.equal(env.fetchCalls[0].url, '/api/telemetry/driver_aliases');
  assert.deepEqual(plain(env.get('driverAliases')), { 'p1 raw': 'Alice' });
  assert.deepEqual(aliasRows(env), [{ raw: 'P1 Raw', value: 'Alice', color: 'rgb(30, 120, 255)' }]);
});

test('loadDriverAliases falls back to no aliases on error', async () => {
  const env = createDashboard({ fetch: () => jsonResponse({}, 500) });
  env.set('driverAliases', { x: 'y' });
  await env.window.loadDriverAliases();
  assert.deepEqual(plain(env.get('driverAliases')), {});
  assert.match(env.document.getElementById('driverAliasList').textContent, /Waiting for live drivers/);
});

test('updateDriverAliasPanel de-duplicates names and picks colours/display names', () => {
  const env = createDashboard();
  env.set('driverAliases', { bob: 'Bobby' });
  env.window.updateDriverAliasPanel({
    a: { name: 'Ann', instance_index: 1 },
    b: { telemetry_name: 'BOB', name: 'Bob', instance_index: 2 },
    c: { telemetry_name: ' bob ', name: 'dupe' },
    d: { name: '' },
    e: { telemetry_name: 'raw<x>', instance_index: -1 },
    f: { telemetry_name: 'nameless', instance_index: 'x' }
  });
  assert.deepEqual(aliasRows(env), [
    { raw: 'Ann', value: 'Ann', color: 'rgb(255, 135, 0)' },
    { raw: 'BOB', value: 'Bobby', color: 'rgb(30, 120, 255)' },
    { raw: 'raw<x>', value: 'raw<x>', color: 'rgb(163, 113, 247)' },
    { raw: 'nameless', value: 'nameless', color: 'rgb(30, 120, 255)' }
  ]);
  assert.equal(env.document.querySelector('.driver-alias-save').dataset.telemetryName, 'Ann');
});

test('updateDriverAliasPanel shows waiting state and skips while editing', () => {
  const env = createDashboard();
  const w = env.window;
  const list = env.document.getElementById('driverAliasList');
  w.updateDriverAliasPanel(null);
  assert.match(list.textContent, /Waiting for live drivers/);
  w.updateDriverAliasPanel(undefined);
  assert.match(list.textContent, /Waiting for live drivers/);

  w.updateDriverAliasPanel({ a: { name: 'Ann' } });
  const input = list.querySelector('.driver-alias-input');
  input.focus();
  input.value = 'typing...';
  w.updateDriverAliasPanel({ a: { name: 'Changed' } });
  assert.equal(list.querySelector('.driver-alias-input'), input, 'focused input not replaced');
  assert.equal(input.value, 'typing...');
});

test('updateDriverAliasPanel without a list element does nothing', () => {
  const env = createDashboard({ html: '<div></div>' });
  assert.doesNotThrow(() => env.window.updateDriverAliasPanel({ a: { name: 'A' } }));
});

test('save button posts the alias, refreshes live drivers and shows a toast', async () => {
  let aliasResponse = () => jsonResponse({ ann: 'Alice' });
  const env = createDashboard({
    fetch: (url) => url === '/api/telemetry/driver_alias' ? aliasResponse() : jsonResponse({ 0: { name: 'Ann' } })
  });
  const w = env.window;
  w.updateDriverAliasPanel({ 0: { name: 'Ann' } });
  const list = env.document.getElementById('driverAliasList');
  const toasts = env.document.getElementById('toast-container');

  const mousedownOnSave = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  list.querySelector('.driver-alias-save').dispatchEvent(mousedownOnSave);
  assert.equal(mousedownOnSave.defaultPrevented, true, 'keeps focus in the input');
  const mousedownElsewhere = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  list.querySelector('.driver-alias-raw').dispatchEvent(mousedownElsewhere);
  assert.equal(mousedownElsewhere.defaultPrevented, false);

  list.querySelector('.driver-alias-raw').click();
  await env.flush();
  assert.equal(env.fetchCalls.length, 0);

  list.querySelector('.driver-alias-input').value = '  Alice  ';
  list.querySelector('.driver-alias-save').click();
  await env.flush();
  const post = env.callsTo('/api/telemetry/driver_alias')[0];
  assert.equal(post.init.method, 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { telemetry_name: 'Ann', display_name: 'Alice' });
  assert.deepEqual(plain(env.get('driverAliases')), { ann: 'Alice' });
  assert.equal(env.callsTo('/api/drivers/live').length, 1);
  assert.match(toasts.lastElementChild.textContent, /Player name set[\s\S]*Ann → Alice/);
  assert.equal(list.querySelector('.driver-alias-input').value, 'Alice');

  list.querySelector('.driver-alias-input').value = '   ';
  aliasResponse = () => jsonResponse({});
  list.querySelector('.driver-alias-save').click();
  await env.flush();
  assert.match(toasts.lastElementChild.textContent, /Player name cleared[\s\S]*Now using Ann/);

  aliasResponse = () => jsonResponse({}, 500);
  list.querySelector('.driver-alias-save').click();
  await env.flush();
  assert.equal(env.logs.error[0][0], 'Error saving driver alias:');
  assert.equal(toasts.lastElementChild.className, 'info-toast error');
  assert.match(toasts.lastElementChild.textContent, /Could not save name[\s\S]*Try again for Ann/);
});

test('saveDriverAlias with an unknown name does nothing; panel binds clicks once', async () => {
  const env = createDashboard();
  env.window.updateDriverAliasPanel({ 0: { name: 'Ann' } });
  env.window.updateDriverAliasPanel({ 0: { name: 'Ann' } });
  await env.window.saveDriverAlias('Nobody');
  assert.equal(env.fetchCalls.length, 0);
  env.document.querySelector('.driver-alias-save').click();
  await env.flush();
  assert.equal(env.callsTo('/api/telemetry/driver_alias').length, 1, 'one listener only');
  assert.equal(env.window.normalizeAliasKey(undefined), '');
  assert.equal(env.window.normalizeAliasKey('  MiXed '), 'mixed');
});

test('polling preserves unchanged nodes, blurred drafts, cleared drafts and focused Save buttons', () => {
  const env = createDashboard();
  const w = env.window;
  const drivers = { 0: { telemetry_name: 'Raw', name: 'Raw' } };
  const list = env.document.getElementById('driverAliasList');
  w.updateDriverAliasPanel(drivers);
  const original = list.querySelector('.driver-alias-input');
  w.updateDriverAliasPanel(drivers);
  assert.equal(list.querySelector('.driver-alias-input'), original);
  original.focus();
  original.value = 'Unsaved draft';
  original.blur();
  w.updateDriverAliasPanel(drivers);
  assert.equal(list.querySelector('input').value, 'Unsaved draft');
  const draftInput = list.querySelector('input');
  w.updateDriverAliasPanel(drivers);
  assert.equal(list.querySelector('input'), draftInput, 'unchanged draft is stable');
  draftInput.value = '';
  w.updateDriverAliasPanel(drivers);
  assert.equal(list.querySelector('input').value, '', 'empty draft is preserved');
  list.querySelector('input').value = 'Raw';
  w.updateDriverAliasPanel(drivers);
  assert.equal(list.querySelector('input').value, 'Raw', 'reverting the draft clears it');
  const button = list.querySelector('button');
  button.focus();
  w.updateDriverAliasPanel({ ...drivers, 1: { name: 'New arrival' } });
  assert.equal(list.querySelector('button'), button);
  assert.equal(env.document.activeElement, button);
  button.blur();
  w.updateDriverAliasPanel({ ...drivers, 1: { name: 'New arrival' } });
  assert.equal(list.querySelectorAll('input').length, 2);
});

test('failed alias save retains the draft through polling and a successful retry releases it', async () => {
  let failure = true;
  const drivers = { 0: { telemetry_name: 'Raw', name: 'Raw' } };
  const env = createDashboard({ fetch: url => url === '/api/telemetry/driver_alias' ?
    jsonResponse({ raw: 'Saved player' }, failure ? 500 : 200) : jsonResponse(drivers) });
  const w = env.window;
  w.updateDriverAliasPanel(drivers);
  env.document.querySelector('.driver-alias-input').value = 'Saved player';
  await w.saveDriverAlias('Raw');
  w.updateDriverAliasPanel(drivers);
  assert.equal(env.document.querySelector('.driver-alias-input').value, 'Saved player');
  failure = false;
  await w.saveDriverAlias('Raw');
  await env.flush();
  env.set('driverAliases', { raw: 'Later server value' });
  w.updateDriverAliasPanel(drivers);
  assert.equal(env.document.querySelector('.driver-alias-input').value, 'Later server value');
});

test('typing during an alias save keeps the newer draft after the earlier save succeeds', async () => {
  let complete;
  const drivers = { 0: { name: 'Raw' } };
  const env = createDashboard({ fetch: url => url === '/api/telemetry/driver_alias' ?
    new Promise(resolve => { complete = resolve; }) : jsonResponse(drivers) });
  const w = env.window;
  w.updateDriverAliasPanel(drivers);
  const input = env.document.querySelector('.driver-alias-input');
  input.value = 'First draft';
  const pending = w.saveDriverAlias('Raw');
  await env.flush();
  input.value = 'Newer draft';
  complete(jsonResponse({ raw: 'First draft' }));
  await pending;
  await env.flush();
  assert.equal(env.document.querySelector('.driver-alias-input').value, 'Newer draft');
});

test('alias lookups ignore prototype properties and support an own __proto__ alias safely', () => {
  const env = createDashboard();
  const drivers = { 0: { name: '__proto__' }, 1: { name: 'constructor' }, 2: { name: 'bad alias' } };
  env.set('driverAliases', { 'bad alias': 42 });
  env.window.updateDriverAliasPanel(drivers);
  assert.deepEqual(aliasRows(env).map(row => row.value), ['__proto__', 'constructor', 'bad alias']);
  env.set('driverAliases', JSON.parse('{"__proto__":"Safe player"}'));
  env.window.updateDriverAliasPanel(drivers);
  assert.deepEqual(aliasRows(env).map(row => row.value), ['Safe player', 'constructor', 'bad alias']);
  assert.equal({}.polluted, undefined);
});

test('each alias input and Save button names its driver accessibly and escapes that name', () => {
  const env = createDashboard();
  const name = 'Driver "quoted" <name>';
  env.window.updateDriverAliasPanel({ 0: { name }, 1: { name: 'Other driver' } });
  const rows = [...env.document.querySelectorAll('.driver-alias-row')];
  assert.equal(rows[0].querySelector('input').getAttribute('aria-label'), 'Player name for ' + name);
  assert.equal(rows[0].querySelector('button').getAttribute('aria-label'), 'Save player name for ' + name);
  assert.equal(rows[0].querySelector('button').type, 'button');
  assert.equal(rows[1].querySelector('input').getAttribute('aria-label'), 'Player name for Other driver');
  assert.equal(rows[1].querySelector('button').getAttribute('aria-label'), 'Save player name for Other driver');
  assert.equal(env.document.querySelectorAll('name').length, 0);
});

