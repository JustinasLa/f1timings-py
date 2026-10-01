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
