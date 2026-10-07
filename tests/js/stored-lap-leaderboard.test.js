'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard, jsonResponse, plain, SCRIPT_ORDER } = require('./harness.js');

function rec(driver, time, extra = {}) {
  return { driver, time, team: 'McLaren F1 Team', is_valid: true, ...extra };
}

function rows(document) {
  return Array.from(document.querySelectorAll('#timingTableBody tr.clickable-row'));
}

function cells(tr) {
  return Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
}

function filterControls(env) {
  const controls = {};
  for (const [id, type] of [['leaderboardSearch', 'search'], ['leaderboardValidOnly', 'checkbox']]) {
    const input = env.document.getElementById(id) || env.document.createElement('input');
    input.id = id;
    input.type = type;
    if (!input.isConnected) env.document.body.append(input);
    controls[id] = input;
  }
  return controls;
}

test('leaderboard search preserves original positions, leader gaps, preceding intervals and map data', () => {
  const env = createDashboard();
  const w = env.window;
  const { leaderboardSearch: search } = filterControls(env);
  w.initializeLeaderboardFilters();
  const drivers = w.buildDriversFromRecords([
    rec('Ann', '1:30.000', { team: 'Ferrari' }),
    rec('Bob', '1:30.500'), rec('Cat', '1:32.000'), rec('Dan', '1:33.000', { team: 'Ferrari' })
  ]);
  w.updateLeaderboard(drivers);
  search.value = '  CAT  ';
  search.dispatchEvent(new w.Event('input'));
  const filtered = rows(env.document);
  assert.deepEqual(filtered.map(row => row.dataset.driver), ['Cat']);
  assert.equal(filtered[0].querySelector('.col-pos').textContent, '3');
  assert.equal(filtered[0].querySelector('.col-gap').textContent, '+2.000s');
  assert.equal(filtered[0].querySelector('.col-interval').textContent, '+1.500s');
  assert.equal(env.get('latestLeaderboardDrivers'), drivers);
  assert.equal(env.document.getElementById('driverCount').textContent, '4');
  search.value = 'fErRaRi';
  search.dispatchEvent(new w.Event('input'));
  assert.deepEqual(rows(env.document).map(row => row.dataset.driver), ['Ann', 'Dan']);
  assert.equal(rows(env.document)[1].querySelector('.col-pos').textContent, '4');
  assert.equal(rows(env.document)[1].querySelector('.col-interval').textContent, '+1.000s');
  search.value = '<img src=x>';
  search.dispatchEvent(new w.Event('input'));
  assert.match(env.document.getElementById('timingTableBody').textContent, /No drivers match these filters/);
  assert.equal(env.document.querySelector('#timingTableBody img'), null);
  search.value = '';
  search.dispatchEvent(new w.Event('input'));
  assert.equal(rows(env.document).length, 4);
  assert.equal(w.localStorage.length, 0);
  assert.equal(env.fetchCalls.length, 0);
});

test('valid-only filters main rows and expanded recent laps while preserving expansion and combined search', () => {
  const env = createDashboard();
  const w = env.window;
  const { leaderboardSearch: search, leaderboardValidOnly: checkbox } = filterControls(env);
  w.initializeLeaderboardFilters();
  const drivers = w.buildDriversFromRecords([
    rec('Ann', '1:30.000'), rec('Ann', '1:29.000', { is_valid: false }),
    rec('Bob', '1:31.000'), rec('Invalid', '1:10.000', { is_valid: false })
  ]);
  w.updateLeaderboard(drivers);
  w.toggleDriverExpand('Ann');
  assert.equal(env.document.querySelectorAll('tr.lap-detail-row').length, 2);
  checkbox.checked = true;
  checkbox.dispatchEvent(new w.Event('change'));
  assert.deepEqual(rows(env.document).map(row => row.dataset.driver), ['Ann', 'Bob']);
  assert.equal(env.document.querySelectorAll('tr.lap-detail-row').length, 1);
  assert.equal(env.document.querySelector('tr.lap-detail-row .laptime-badge').textContent, '1:30.000');
  assert.ok(env.get('expandedDrivers').has('Ann'));
  assert.equal(drivers.Ann.recent_laps.length, 2);
  search.value = 'invalid';
  search.dispatchEvent(new w.Event('input'));
  assert.equal(rows(env.document).length, 0);
  checkbox.checked = false;
  checkbox.dispatchEvent(new w.Event('change'));
  assert.deepEqual(rows(env.document).map(row => row.dataset.driver), ['Invalid']);
  search.value = '';
  search.dispatchEvent(new w.Event('input'));
  assert.equal(env.document.querySelectorAll('tr.lap-detail-row').length, 2);
  checkbox.checked = true;
  checkbox.dispatchEvent(new w.Event('change'));
  assert.match(w.buildLapDetailRow({ name: 'A', recent_laps: [{ time: '1:10.000', is_valid: false }] }, 90), /No recent laps/);
});

test('leaderboard filter initialization tolerates missing controls and uses current input values', () => {
  const empty = createDashboard({ html: '<div></div>' });
  assert.doesNotThrow(() => empty.window.initializeLeaderboardFilters());
  const env = createDashboard();
  const { leaderboardSearch: search, leaderboardValidOnly: checkbox } = filterControls(env);
  search.value = ' Bob ';
  checkbox.checked = true;
  env.window.initializeLeaderboardFilters();
  const drivers = env.window.buildDriversFromRecords([
    rec('Ann', '1:30.000'), rec('Bob', '1:31.000'), rec('Bob invalid', '1:10.000', { is_valid: false })
  ]);
  env.window.updateLeaderboard(drivers);
  assert.deepEqual(rows(env.document).map(row => row.dataset.driver), ['Bob']);
  checkbox.remove();
  assert.doesNotThrow(() => env.window.initializeLeaderboardFilters());
  search.remove();
  assert.doesNotThrow(() => env.window.initializeLeaderboardFilters());
});

test('formatTopSpeed, formatPotentialTime and formatLeaderboardSectorMs', () => {
  const { window: w } = createDashboard();
  assert.equal(w.formatTopSpeed(null), '—');
  assert.equal(w.formatTopSpeed(undefined), '—');
  assert.equal(w.formatTopSpeed(301.6), '302 km/h');

  assert.equal(w.formatPotentialTime({}), '—');
  assert.equal(w.formatPotentialTime({ best_sectors: { s1: 1, s2: 0, s3: 1 } }), '—');
  assert.equal(w.formatPotentialTime({ best_sectors: { s1: 30000, s2: 30000, s3: 23456 } }), '1:23.456');

  assert.equal(w.formatLeaderboardSectorMs(null), '—');
  assert.equal(w.formatLeaderboardSectorMs(undefined), '—');
  assert.equal(w.formatLeaderboardSectorMs(0), '—');
  assert.equal(w.formatLeaderboardSectorMs(-5), '—');
  assert.equal(w.formatLeaderboardSectorMs(28123), '28.123');
});

test('formatTyreTag renders an escaped compound badge or nothing', () => {
  const { window: w } = createDashboard();
  assert.equal(w.formatTyreTag(null), '');
  assert.equal(w.formatTyreTag(undefined), '');
  assert.equal(
    w.formatTyreTag('Soft'),
    '<span class="tyre-tag tyre-soft" title="Soft">S</span>'
  );
  assert.equal(
    w.formatTyreTag('<x"'),
    '<span class="tyre-tag tyre-&lt;x&quot;" title="&lt;x&quot;">&lt;</span>'
  );
});

test('formatAssistsTag renders an escaped assists badge or nothing', () => {
  const { window: w } = createDashboard();
  assert.equal(w.formatAssistsTag(undefined), '');
  assert.equal(w.formatAssistsTag([]), '');
  assert.equal(
    w.formatAssistsTag(['TC', 'RL']),
    '<span class="assists-tag" title="Assists: TC RL">TC RL</span>'
  );
  assert.equal(
    w.formatAssistsTag(['<x"']),
    '<span class="assists-tag" title="Assists: &lt;x&quot;">&lt;x"</span>'
  );
});

test('buildPotentialTitle shows time left on the table vs the best lap', () => {
  const { window: w } = createDashboard();
  const best = { best_sectors: { s1: 30000, s2: 30000, s3: 23456 } };
  assert.equal(w.buildPotentialTitle(best, { time: '1:23.700', is_valid: true }), ' title="0.244s left on the table vs best lap"');
  assert.equal(w.buildPotentialTitle(best, { time: '1:23.456', is_valid: true }), '');
  assert.equal(w.buildPotentialTitle(best, { time: '1:23.700', is_valid: false }), '');
  assert.equal(w.buildPotentialTitle(best, { time: '', is_valid: true }), '');
  assert.equal(w.buildPotentialTitle({}, { time: '1:23.700', is_valid: true }), '');
});

test('minSector ignores unset values and returns the smaller one', () => {
  const { window: w } = createDashboard();
  assert.equal(w.minSector(0, null), 0);
  assert.equal(w.minSector(0, 5), 5);
  assert.equal(w.minSector(7, -1), 7);
  assert.equal(w.minSector(3, 5), 3);
  assert.equal(w.minSector(5, 3), 3);
  assert.equal(w.minSector(4, 4), 4);
});

test('getDisplaySectors falls back to best sectors and tracks validity', () => {
  const { window: w } = createDashboard();
  assert.deepEqual(
    plain(w.getDisplaySectors({}, { sector_1_ms: null, sector_2_ms: 0, sector_3_ms: -1 })),
    { s1: 0, s2: 0, s3: 0, isValid: true }
  );
  assert.deepEqual(
    plain(w.getDisplaySectors(
      { best_sectors: { s1: 10, s2: 20, s3: 30 } },
      { sector_1_ms: 11, sector_2_ms: null, sector_3_ms: 33, is_valid: false }
    )),
    { s1: 11, s2: 20, s3: 33, isValid: false }
  );
});

test('sectorColorClass and buildOneSectorBox colour sectors', () => {
  const { window: w } = createDashboard();
  assert.equal(w.sectorColorClass(100, 0, 0, false), 'sector-invalid');
  assert.equal(w.sectorColorClass(0, 0, 0, true), 'sector-none');
  assert.equal(w.sectorColorClass(-1, 0, 0, true), 'sector-none');
  assert.equal(w.sectorColorClass(100, 200, 100, true), 'sector-purple');
  assert.equal(w.sectorColorClass(150, 0, 100, true), 'sector-green');
  assert.equal(w.sectorColorClass(150, 150, 0, true), 'sector-green');
  assert.equal(w.sectorColorClass(160, 150, 100, true), 'sector-yellow');
  assert.equal(w.buildOneSectorBox(28123, 0, 0, true), '<span class="sector-box sector-green">28.123</span>');
});

test('buildLeaderboardLiveLapSectors only includes active live laps', () => {
  const env = createDashboard();
  env.set('latestLiveDrivers', {
    a: null,
    b: { name: 'B', live_lap_active: false },
    c: { name: 'C', live_lap_active: true, live_sector_1_ms: 100, live_lap_invalid: true },
    d: { name: 'D', live_lap_active: true, live_sector_1_ms: 1, live_sector_2_ms: 2, live_sector_3_ms: 3 },
    e: { name: 'E', live_lap_active: true }
  });
  assert.deepEqual(plain(env.window.buildLeaderboardLiveLapSectors()), {
    C: { s1: 100, s2: 0, s3: 0, isValid: false },
    D: { s1: 1, s2: 2, s3: 3, isValid: true },
    E: { s1: 0, s2: 0, s3: 0, isValid: true }
  });
});

test('addLiveOnlyDrivers adds placeholder rows for new active live drivers', () => {
  const env = createDashboard();
  env.set('latestLiveDrivers', {
    a: null,
    b: { name: 'Inactive', live_lap_active: false },
    c: { live_lap_active: true },
    d: { name: 'Stored', live_lap_active: true, team: 'X' },
    e: { name: 'Newbie', live_lap_active: true },
    f: { name: 'Teamed', live_lap_active: true, team: 'Scuderia Ferrari' }
  });
  const stored = { name: 'Stored', lap_times: [] };
  const merged = env.window.addLiveOnlyDrivers({ Stored: stored });
  assert.deepEqual(Object.keys(merged), ['Stored', 'Newbie', 'Teamed']);
  assert.equal(merged.Stored, stored);
  assert.equal(merged.Newbie.team, 'Unknown Team');
  assert.equal(merged.Newbie.is_live_only, true);
  assert.equal(merged.Newbie.lap_times[0].time, '');
  assert.equal(merged.Teamed.team, 'Scuderia Ferrari');
});

test('buildSectorBoxesHtml prefers live sectors and uses personal/overall bests', () => {
  const env = createDashboard();
  const w = env.window;
  env.set('leaderboardLiveLapSectors', { Live: { s1: 1000, s2: 0, s3: 0, isValid: true } });
  env.set('leaderboardPersonalBestSectors', { Stored: { s1: 1000, s2: 2000, s3: 3000 } });
  env.set('leaderboardOverallBestSectors', { s1: 900, s2: 2000, s3: 0 });

  const live = w.buildSectorBoxesHtml({ name: 'Live' }, {});
  assert.match(live, /sector-green">1\.000<\/span><span class="sector-box sector-none">—/);

  const stored = w.buildSectorBoxesHtml(
    { name: 'Stored' },
    { sector_1_ms: 1100, sector_2_ms: 2000, sector_3_ms: 3000 }
  );
  assert.equal(
    stored,
    '<div class="sector-box-row"><span class="sector-box sector-yellow">1.100</span>' +
      '<span class="sector-box sector-purple">2.000</span><span class="sector-box sector-green">3.000</span></div>'
  );
});

test('buildSectorBoxesHtml appends a live delta to the personal best lap', () => {
  const env = createDashboard();
  const w = env.window;
  const best = { is_valid: true, sector_1_ms: 30000, sector_2_ms: 25000, sector_3_ms: 20000 };
  env.set('leaderboardLiveLapSectors', {
    Ahead: { s1: 29800, s2: 0, s3: 0, isValid: true },
    Behind: { s1: 29800, s2: 25500, s3: 0, isValid: true },
    Waiting: { s1: 0, s2: 0, s3: 0, isValid: true }
  });

  assert.match(
    w.buildSectorBoxesHtml({ name: 'Ahead' }, best),
    /<\/div><span class="live-delta delta-ahead" title="Live delta to personal best">-0\.200s<\/span>$/
  );
  assert.match(w.buildSectorBoxesHtml({ name: 'Behind' }, best), /delta-behind"[^>]*>\+0\.300s</);
  assert.doesNotMatch(w.buildSectorBoxesHtml({ name: 'Waiting' }, best), /live-delta/);
  assert.doesNotMatch(w.buildSectorBoxesHtml({ name: 'Ahead' }, { ...best, is_valid: false }), /live-delta/);
  assert.doesNotMatch(w.buildSectorBoxesHtml({ name: 'Ahead' }, { is_valid: true }), /live-delta/);
  assert.doesNotMatch(w.buildSectorBoxesHtml({ name: 'Stored' }, best), /live-delta/);

  assert.equal(w.liveDeltaMs({ s1: 30000, s2: 1000 }, { sector_1_ms: 30000 }), 0, 'falls back to S1 when best has no S2');
});

test('recomputeBestSectors computes personal and overall bests', () => {
  const env = createDashboard();
  env.window.recomputeBestSectors([
    { driver: { name: 'A', best_sectors: { s1: 10, s2: 0, s3: 30 } } },
    { driver: { name: 'B', best_sectors: { s1: 12, s2: 20, s3: 25 } } },
    { driver: { name: 'C' } }
  ]);
  assert.deepEqual(plain(env.get('leaderboardOverallBestSectors')), { s1: 10, s2: 20, s3: 25 });
  assert.deepEqual(plain(env.get('leaderboardPersonalBestSectors')), {
    A: { s1: 10, s2: 0, s3: 30 },
    B: { s1: 12, s2: 20, s3: 25 },
    C: { s1: 0, s2: 0, s3: 0 }
  });
});

test('isBetterLap prefers valid laps then faster times', () => {
  const { window: w } = createDashboard();
  assert.equal(w.isBetterLap({ is_valid: true, time: '1:30.000' }, { is_valid: false, time: '1:20.000' }), true);
  assert.equal(w.isBetterLap({ is_valid: false, time: '1:10.000' }, { is_valid: true, time: '1:20.000' }), false);
  assert.equal(w.isBetterLap({ is_valid: true, time: '1:10.000' }, { is_valid: true, time: '1:20.000' }), true);
  assert.equal(w.isBetterLap({ is_valid: true, time: '1:30.000' }, { is_valid: true, time: '1:20.000' }), false);
});

test('getDriverDotColor uses team colour or default', () => {
  const { window: w } = createDashboard();
  assert.equal(w.getDriverDotColor({ team: 'Scuderia Ferrari' }), '#DC0000');
  assert.equal(w.getDriverDotColor({ team: 'Nobody' }), '#a371f7');
  assert.equal(w.getDriverDotColor({ team: 'toString' }), '#a371f7');
});

test('buildDriversFromRecords groups laps, picks best lap and marks the fastest', () => {
  const { window: w } = createDashboard();
  const drivers = w.buildDriversFromRecords([
    { driver: 'Pole', time: '1:00.000', is_pole_reference: true },
    rec('Ann', '1:30.000', { recorded_at: '2026-01-01T10:00:00', sector_1_ms: 30000, sector_2_ms: 30000, sector_3_ms: 30000 }),
    rec('Ann', '1:25.000', { recorded_at: '2026-01-01T10:05:00', team: 'Scuderia Ferrari', sector_1_ms: 29000, sector_2_ms: 31000, sector_3_ms: 25000 }),
    rec('Ann', '1:28.000', { recorded_at: '2026-01-01T10:05:00' }),
    rec('Ann', '1:20.000', { is_valid: false, sector_1_ms: 1, recorded_at: '2026-01-01T09:00:00' }),
    rec('Ann', '1:24.000', { team: undefined, tyre: 'Medium', assists: ['ABS'] }),
    { time: '1:40.000' },
    rec('Bob', '1:50.000', { is_valid: false }),
    rec('Bob', '1:45.000')
  ]);

  assert.deepEqual(Object.keys(drivers), ['Ann', 'Unknown', 'Bob']);
  const ann = drivers.Ann;
  assert.equal(ann.lap_count, 5);
  assert.equal(ann.lap_times[0].time, '1:24.000');
  assert.equal(ann.team, 'Scuderia Ferrari', 'team kept when better record has no team');
  assert.equal(ann.lap_times[0].is_fastest, true);
  assert.deepEqual(plain(ann.best_sectors), { s1: 29000, s2: 30000, s3: 25000 });
  assert.deepEqual(
    plain(ann.recent_laps.map((l) => l.time)),
    ['1:25.000', '1:28.000', '1:30.000', '1:20.000', '1:24.000']
  );
  assert.equal(ann.recent_laps[4].recorded_at, '');
  assert.equal(ann.lap_times[0].tyre, 'Medium');
  assert.equal(ann.recent_laps[4].tyre, 'Medium');
  assert.deepEqual(ann.lap_times[0].assists, ['ABS']);
  assert.deepEqual(ann.recent_laps[4].assists, ['ABS']);

  assert.equal(drivers.Unknown.team, 'Unknown Team');
  assert.equal(drivers.Unknown.lap_times[0].is_fastest, false);
  assert.equal(drivers.Bob.lap_times[0].time, '1:45.000', 'valid lap replaces invalid lap');
  assert.equal(drivers.Bob.team, 'McLaren F1 Team');
});

test('buildDriversFromRecords keeps only the 5 most recent laps', () => {
  const { window: w } = createDashboard();
  const records = [];
  for (let i = 0; i < 7; i++) records.push(rec('Ann', `1:3${i}.000`, { recorded_at: `2026-01-01T10:0${i}:00` }));
  const drivers = w.buildDriversFromRecords(records);
  assert.equal(drivers.Ann.lap_count, 7);
  assert.deepEqual(plain(drivers.Ann.recent_laps.map((l) => l.time)), ['1:36.000', '1:35.000', '1:34.000', '1:33.000', '1:32.000']);
});

test('buildDriversFromRecords with no valid laps marks nothing fastest', () => {
  const { window: w } = createDashboard();
  const drivers = w.buildDriversFromRecords([rec('Ann', '1:30.000', { is_valid: false })]);
  assert.equal(drivers.Ann.lap_times[0].is_fastest, false);
  assert.deepEqual(plain(drivers.Ann.best_sectors), { s1: 0, s2: 0, s3: 0 });
});

test('updateLeaderboard shows an empty-state row and caches the HTML', () => {
  const env = createDashboard();
  const tbody = env.document.getElementById('timingTableBody');
  env.window.updateLeaderboard({});
  assert.match(tbody.innerHTML, /No timing data recorded for this track/);
  assert.equal(env.document.getElementById('driverCount').textContent, '0');
  tbody.innerHTML = 'tampered';
  env.window.updateLeaderboard({});
  assert.equal(tbody.innerHTML, 'tampered', 'unchanged HTML is not rewritten');
});

test('updateLeaderboard renders sorted rows with positions, gaps and badges', () => {
  const env = createDashboard();
  const w = env.window;
  env.set('latestLiveDrivers', {
    1: { name: 'Livey', live_lap_active: true, live_sector_1_ms: 20000 },
    2: { name: 'Dee', live_lap_active: true, live_sector_1_ms: 28000, live_sector_2_ms: 1 }
  });
  const drivers = w.buildDriversFromRecords([
    rec('Cee', '1:31.000', { recorded_at: '2026-01-01T10:00:00' }),
    rec('Ann', '1:30.000', { sector_1_ms: 30000, sector_2_ms: 30000, sector_3_ms: 30000, fastest_speed_kph: 310.2 }),
    rec('Inv', '1:10.000', { is_valid: false }),
    rec('Bob', '1:30.500', { team: 'Scuderia Ferrari' }),
    rec('Dee', '1:32.000'),
    rec('Eve', '1:29.000', { is_valid: false })
  ]);
  w.updateLeaderboard(drivers);

  assert.equal(env.get('latestLeaderboardDrivers'), drivers);
  assert.equal(env.document.getElementById('driverCount').textContent, '7');
  const r = rows(env.document);
  assert.deepEqual(r.map((tr) => tr.dataset.driver), ['Ann', 'Bob', 'Cee', 'Dee', 'Livey', 'Inv', 'Eve']);

  assert.ok(r[0].classList.contains('fastest-row'));
  assert.ok(r[0].querySelector('.td-pos').classList.contains('p1'));
  assert.ok(r[0].querySelector('.laptime-badge').classList.contains('fastest'));
  assert.equal(cells(r[0])[2], '310 km/h');
  assert.equal(cells(r[0])[4], '1:30.000');
  assert.equal(cells(r[0])[6], '—');
  assert.equal(cells(r[0])[7], '—', 'leader has no interval');
  assert.equal(cells(r[0])[8], '—', 'fewer than 3 valid laps has no consistency');
  assert.equal(cells(r[0])[9], '1');

  assert.ok(r[1].querySelector('.td-pos').classList.contains('p2'));
  assert.equal(r[1].querySelector('.team-dot').style.background, 'rgb(220, 0, 0)');
  assert.equal(cells(r[1])[6], '+0.500s');
  assert.equal(cells(r[1])[7], '+0.500s');
  assert.equal(cells(r[2])[6], '+1.000s');
  assert.equal(cells(r[2])[7], '+0.500s', 'interval is to the car ahead, not the leader');
  assert.equal(cells(r[3])[7], '+1.000s');
  assert.ok(r[1].querySelector('.laptime-badge').classList.contains('normal'));
  assert.ok(r[2].querySelector('.td-pos').classList.contains('p3'));
  assert.equal(r[3].querySelector('.td-pos').className.trim(), 'td-pos col-pos');
  assert.equal(cells(r[3])[0], '4');
  // Dee is mid-lap -> live sectors override the stored ones.
  assert.match(r[3].querySelector('.sectors-cell').innerHTML, /28\.000/);

  // Live-only row: no position, time, gap or lap count.
  const live = cells(r[4]);
  assert.equal(live[0], '');
  assert.equal(live[3], '—');
  assert.equal(live[6], '—');
  assert.equal(live[7], '—');
  assert.equal(live[8], '—');
  assert.equal(live[9], '—');
  assert.deepEqual(r[4].className.trim().split(/\s+/), ['clickable-row']);

  // Invalid rows: no position, no gap, red sectors.
  assert.ok(r[5].classList.contains('invalid-row'));
  assert.equal(cells(r[5])[0], '');
  assert.equal(cells(r[5])[6], '—');
  assert.equal(cells(r[5])[7], '—');
  assert.ok(r[5].querySelector('.laptime-badge').classList.contains('invalid'));
  assert.equal(r[5].querySelectorAll('.sector-invalid').length, 3);
});

test('formatConsistency is the std dev of valid, parseable stored laps', () => {
  const { window: w } = createDashboard();
  const lap = (time, is_valid = true) => ({ time, is_valid });
  assert.equal(w.formatConsistency({}), '—');
  assert.equal(w.formatConsistency({ all_laps: [lap('1:30.000'), lap('1:31.000'), lap('1:20.000', false), lap('bad')] }), '—');
  assert.equal(w.formatConsistency({ all_laps: [lap('1:30.000'), lap('1:31.000'), lap('1:32.000'), lap('1:00.000', false)] }), '±0.816s');
});

test('updateLeaderboard renders the consistency column from stored laps', () => {
  const env = createDashboard();
  const w = env.window;
  w.updateLeaderboard(w.buildDriversFromRecords([
    rec('Ann', '1:30.000'), rec('Ann', '1:30.500'), rec('Ann', '1:31.000'), rec('Bob', '1:35.000')
  ]));
  const r = rows(env.document);
  assert.equal(r[0].querySelector('.col-consistency').textContent, '±0.408s');
  assert.equal(r[1].querySelector('.col-consistency').textContent, '—');
});

test('updateLeaderboard handles missing lap counts and unparseable fastest times', () => {
  const env = createDashboard();
  const lap = (time) => ({ time, is_valid: true, is_fastest: false });
  env.window.updateLeaderboard({
    A: { name: 'A', team: 'x', lap_times: [lap('bad')] },
    B: { name: 'B<i>', team: 'x', lap_times: [lap('worse')] }
  });
  const r = rows(env.document);
  assert.equal(r.length, 2);
  assert.equal(r[1].querySelector('.col-gap').textContent, '—');
  assert.equal(r[1].querySelector('.col-laps').textContent, '1');
  assert.equal(r[1].querySelector('.driver-name').textContent.trim().replace(/\s+/g, ''), '+B<i>');
});

test('clicking a row expands it with recent lap details; clicking again collapses', () => {
  const env = createDashboard();
  const w = env.window;
  w.updateLeaderboard(w.buildDriversFromRecords([
    rec('Ann', '1:30.000', { recorded_at: '2026-01-01T10:00:00.123', sector_1_ms: 30000 }),
    rec('Ann', '1:31.000', { recorded_at: '2026-01-01T10:02:00', fastest_speed_kph: 300 }),
    rec('Ann', '1:20.000', { recorded_at: 'yesterday', is_valid: false }),
    rec('Bob', '1:32.000')
  ]));
  const tbody = env.document.getElementById('timingTableBody');

  rows(env.document)[0].querySelector('.driver-name').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok(env.get('expandedDrivers').has('Ann'));
  const details = Array.from(tbody.querySelectorAll('tr.lap-detail-row'));
  assert.equal(details.length, 3);
  assert.ok(details[0].classList.contains('detail-light'));
  assert.ok(details[1].classList.contains('detail-dark'));
  assert.equal(details[0].querySelector('.lap-detail-when > span').textContent, 'yesterday');
  assert.ok(details[0].querySelector('.laptime-badge').classList.contains('invalid'));
  assert.equal(details[0].querySelector('.col-gap').textContent, '—');
  assert.equal(details[0].querySelector('.lap-delete-btn').dataset.recordedAt, 'yesterday');
  assert.equal(details[1].querySelector('.lap-detail-when > span').textContent, '10:02:00');
  assert.equal(details[1].querySelector('.col-gap').textContent, '+1.000s');
  assert.equal(details[1].querySelector('.col-topspeed').textContent, '300 km/h');
  assert.equal(details[2].querySelector('.lap-detail-when > span').textContent, '10:00:00');
  assert.equal(details[2].querySelector('.col-gap').textContent, '—', 'fastest lap has no gap');
  assert.equal(rows(env.document)[0].querySelector('.expand-toggle').textContent, '−');

  // Clicking on the table outside any row does nothing.
  tbody.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok(env.get('expandedDrivers').has('Ann'));

  rows(env.document)[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(env.get('expandedDrivers').has('Ann'), false);
  assert.equal(tbody.querySelectorAll('tr.lap-detail-row').length, 0);
});

test('bindLeaderboardClicks ignores missing tbody and binds only once', () => {
  const env = createDashboard();
  const w = env.window;
  assert.doesNotThrow(() => w.bindLeaderboardClicks(null));
  const tbody = env.document.getElementById('timingTableBody');
  w.bindLeaderboardClicks(tbody);
  w.bindLeaderboardClicks(tbody);
  tbody.innerHTML = '<tr data-driver="Z"><td>z</td></tr>';
  tbody.querySelector('td').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok(env.get('expandedDrivers').has('Z'), 'toggled exactly once');
});

test('buildLapDetailRow and helpers cover empty and edge inputs', () => {
  const env = createDashboard();
  const w = env.window;
  assert.match(w.buildLapDetailRow({ name: 'A' }, 80), /No recent laps/);
  assert.match(w.buildLapDetailRow({ name: 'A', recent_laps: [] }, 80), /No recent laps/);
  const html = w.buildLapDetailRow({ name: 'A', recent_laps: [{ time: '1:30.000' }] }, Infinity);
  assert.match(html, /data-recorded-at=""/);
  assert.match(html, /<td class="td-laps col-gap">—<\/td>/);

  assert.equal(w.formatRecordedClock(''), '');
  assert.equal(w.formatRecordedClock(null), '');
  assert.equal(w.formatRecordedClock('2026-01-01T12:34:56.789Z'), '12:34:56');
  assert.equal(w.formatRecordedClock(123), '123');

  assert.equal(
    w.buildDetailSectorBoxesHtml({ name: 'nobody' }, { sector_1_ms: 1000, is_valid: false }),
    '<div class="sector-box-row"><span class="sector-box sector-invalid">1.000</span>' +
      '<span class="sector-box sector-invalid">—</span><span class="sector-box sector-invalid">—</span></div>'
  );
});

test('expanded row shows a PB progression chart of valid laps in recorded order', () => {
  const env = createDashboard();
  const w = env.window;
  w.updateLeaderboard(w.buildDriversFromRecords([
    rec('Ann', '1:31.000', { recorded_at: '2026-01-01T10:00:00' }),
    rec('Ann', '1:32.000', { recorded_at: '2026-01-01T10:01:00' }),
    rec('Ann', '1:10.000', { recorded_at: '2026-01-01T10:02:00', is_valid: false }),
    rec('Ann', '1:30.000', { recorded_at: '2026-01-01T10:03:00' }),
    rec('Bob', '1:33.000', { recorded_at: '2026-01-01T10:00:00' })
  ]));
  w.toggleDriverExpand('Ann');
  w.toggleDriverExpand('Bob');
  const charts = env.document.querySelectorAll('#timingTableBody tr.pb-chart-row svg.pb-chart');
  assert.equal(charts.length, 1, 'Bob has a single valid lap so no chart');
  const points = charts[0].querySelector('polyline').getAttribute('points').split(' ');
  assert.deepEqual(points, ['4.0,20.0', '100.0,36.0', '196.0,4.0']);
  const pbs = Array.from(charts[0].querySelectorAll('circle.pb-chart-pb'));
  assert.deepEqual(pbs.map((c) => c.textContent), ['PB 1:31.000', 'PB 1:30.000']);
  assert.equal(pbs[1].getAttribute('cx'), '196.0');

  assert.equal(w.buildPbProgressionRow({ name: 'A' }), '');
  const flat = w.buildPbProgressionRow({ all_laps: [{ time: '1:30.000' }, { time: '1:30.000' }, { time: '' }] });
  assert.match(flat, /points="4\.0,4\.0 196\.0,4\.0"/);
  assert.equal((flat.match(/<circle/g) || []).length, 1, 'equal time is not a new PB');
});

test('delete button asks for confirmation and posts the delete', async () => {
  const env = createDashboard({
    fetch: (url) => url.startsWith('/api/track/records?') ? jsonResponse({ lap_times: [] }) : jsonResponse({ ok: true })
  });
  const w = env.window;
  const prompts = [];
  let answer = false;
  w.confirm = (msg) => { prompts.push(msg); return answer; };
  env.set('currentTrack', 'monza');
  w.updateLeaderboard(w.buildDriversFromRecords([rec('Ann', '1:30.000', { recorded_at: '2026-01-01T10:00:00' })]));
  w.toggleDriverExpand('Ann');
  const button = env.document.querySelector('.lap-delete-btn');

  button.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await env.flush();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Delete this lap for Ann \(1:30\.000\)\?/);
  assert.equal(env.fetchCalls.length, 0, 'cancelled delete makes no request');
  assert.ok(env.get('expandedDrivers').has('Ann'), 'delete click does not toggle the row');

  answer = true;
  button.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await env.flush();
  const del = env.callsTo('/api/track/records/delete');
  assert.equal(del.length, 1);
  assert.equal(del[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(del[0].init.body), {
    track: 'monza', driver: 'Ann', time: '1:30.000', recorded_at: '2026-01-01T10:00:00'
  });
  assert.equal(env.callsTo('/api/track/records?track=monza').length, 1, 'reloads records afterwards');
  assert.match(env.document.getElementById('timingTableBody').textContent, /No timing data/);
});

test('deleteSavedLap does nothing without a current track', async () => {
  const env = createDashboard();
  let asked = false;
  env.window.confirm = () => { asked = true; return true; };
  await env.window.deleteSavedLap('A', '1:00.000', '');
  assert.equal(asked, false);
  assert.equal(env.fetchCalls.length, 0);
});

test('deleteSavedLap reports failures with a toast', async () => {
  const env = createDashboard({ fetch: () => jsonResponse({}, 500) });
  env.window.confirm = () => true;
  env.set('currentTrack', 'monza');
  await env.window.deleteSavedLap('A', '1:00.000', '');
  assert.equal(env.logs.error[0][0], 'Could not delete lap:');
  assert.match(String(env.logs.error[0][1]), /HTTP 500/);
  const toast = env.document.querySelector('#toast-container .info-toast.error');
  assert.match(toast.textContent, /Delete failed/);
});

test('deleteSavedLap failure without the toast module only logs', async () => {
  const env = createDashboard({
    scripts: SCRIPT_ORDER.filter((s) => s !== 'lap-notification-toasts.js' && s !== 'start-dashboard.js'),
    fetch: () => { throw new Error('offline'); }
  });
  env.window.confirm = () => true;
  env.set('currentTrack', 'monza');
  await env.window.deleteSavedLap('A', '1:00.000', '');
  assert.equal(env.logs.error.length, 1);
  assert.equal(env.document.querySelector('#toast-container').children.length, 0);
});

test('updatePoleLapCard shows the pole reference lap', () => {
  const env = createDashboard();
  const w = env.window;
  const card = env.document.getElementById('poleLapCard');
  w.updatePoleLapCard([rec('Ann', '1:30.000')]);
  assert.equal(card.style.display, 'none');

  w.updatePoleLapCard([
    rec('Ann', '1:30.000'),
    { driver: 'Max', time: '1:20.123', team: 'Oracle Red Bull Racing', fastest_speed_kph: 330.4, is_pole_reference: true }
  ]);
  assert.equal(card.style.display, 'block');
  assert.equal(env.document.getElementById('poleLapDriver').textContent, 'Max');
  assert.equal(env.document.getElementById('poleLapTime').textContent, '1:20.123');
  assert.equal(env.document.getElementById('poleLapDot').style.background, 'rgb(6, 0, 239)');
  assert.equal(env.document.getElementById('poleLapMeta').textContent, 'Oracle Red Bull Racing  •  330 km/h');

  w.updatePoleLapCard([{ time: '1:20.000', is_pole_reference: true, fastest_speed_kph: null }]);
  assert.equal(env.document.getElementById('poleLapDriver').textContent, 'Unknown');
  assert.equal(env.document.getElementById('poleLapDot').style.background, 'rgb(163, 113, 247)');
  assert.equal(env.document.getElementById('poleLapMeta').textContent, '');

  w.updatePoleLapCard([{ time: '1:20.000', is_pole_reference: true }]);
  assert.equal(env.document.getElementById('poleLapMeta').textContent, '');
});

test('updatePoleLapCard is a no-op without the card element', () => {
  const env = createDashboard({ html: '<body></body>' });
  assert.doesNotThrow(() => env.window.updatePoleLapCard([{ is_pole_reference: true }]));
});

test('updateFastestLapPill shows the fastest lap or hides', () => {
  const env = createDashboard();
  const w = env.window;
  const pill = env.document.getElementById('fastestLapPill');
  w.updateFastestLapPill({
    A: { lap_times: [{ time: '1:31.000', is_fastest: false }] },
    B: { lap_times: [{ time: '1:30.000', is_fastest: true }] }
  });
  assert.equal(pill.textContent, '1:30.000');
  assert.equal(pill.style.display, 'inline-block');
  w.updateFastestLapPill({ A: { lap_times: [] } });
  assert.equal(pill.style.display, 'none');
});

function dateOptions(document) {
  return Array.from(document.querySelectorAll('#eventDateFilter option')).map((o) => o.value);
}

test('event date filter lists distinct dates, newest first, and filters records', () => {
  const env = createDashboard();
  const w = env.window;
  const records = [
    rec('Ann', '1:30.000', { recorded_at: '2026-01-01T10:00:00' }),
    rec('Bob', '1:31.000', { recorded_at: '2026-02-01T10:00:00' }),
    rec('Cat', '1:32.000'),
    { driver: 'Pole', time: '1:20.000', is_pole_reference: true, recorded_at: '2024-01-01T00:00:00' }
  ];
  w.initializeEventDateFilter();
  w.updateEventDateOptions(records);
  assert.deepEqual(dateOptions(env.document), ['', '2026-02-01', '2026-01-01']);
  assert.equal(w.filterRecordsByEventDate(records), records);

  const select = env.document.getElementById('eventDateFilter');
  let reloads = 0;
  env.set('loadDisplayData', () => { reloads++; });
  select.value = '2026-01-01';
  select.dispatchEvent(new w.Event('change'));
  assert.equal(reloads, 1);
  assert.equal(w.localStorage.getItem('leaderboardEventDate'), '2026-01-01');
  assert.deepEqual(w.filterRecordsByEventDate(records).map((r) => r.driver), ['Ann', 'Pole']);

  // An unchanged option list keeps the existing <option> nodes.
  const first = select.options[1];
  w.updateEventDateOptions(records);
  assert.equal(select.options[1], first);
  assert.equal(select.value, '2026-01-01');
});

test('a saved event date is restored and kept even with no laps on that day', () => {
  const env = createDashboard();
  const w = env.window;
  w.localStorage.setItem('leaderboardEventDate', '2025-05-05');
  w.initializeEventDateFilter();
  assert.deepEqual(dateOptions(env.document), ['', '2025-05-05']);
  assert.equal(env.document.getElementById('eventDateFilter').value, '2025-05-05');
  assert.deepEqual(plain(w.filterRecordsByEventDate([rec('Ann', '1:30.000')])), []);
});

test('event date filter is a no-op without the select element', () => {
  const env = createDashboard({ html: '<div></div>' });
  assert.doesNotThrow(() => env.window.initializeEventDateFilter());
});

test('prototype names remain ordinary saved and live drivers with isolated sector dictionaries', () => {
  const env = createDashboard();
  const w = env.window;
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
  const drivers = w.buildDriversFromRecords(names.map((name, index) => rec(name, `1:2${index}.000`, {
    sector_1_ms: 1000 + index, sector_2_ms: 2000, sector_3_ms: 3000
  })));
  assert.equal(Object.getPrototypeOf(drivers), null);
  env.set('latestLiveDrivers', Object.fromEntries(names.map((name, index) => [index, {
    name, live_lap_active: true, live_sector_1_ms: 900 + index
  }])));
  w.updateLeaderboard(drivers);
  assert.deepEqual(rows(env.document).map(row => row.dataset.driver), names);
  assert.equal(Object.getPrototypeOf(env.get('leaderboardPersonalBestSectors')), null);
  assert.equal(Object.getPrototypeOf(env.get('leaderboardLiveLapSectors')), null);
  assert.equal(env.get('leaderboardPersonalBestSectors').__proto__.s1, 1000);
  assert.equal(w.addLiveOnlyDrivers({}).__proto__.name, '__proto__');
  assert.equal(w.buildLeaderboardLiveLapSectors().__proto__.s1, 900);
  assert.equal(env.run('Object.prototype.lap_count'), undefined);
  const inherited = Object.create({ Ghost: drivers.constructor });
  assert.deepEqual(Object.keys(w.addLiveOnlyDrivers(inherited)).sort(), names.slice().sort());
});

test('malformed records cannot hide valid laps, win best lap selection, or earn ranks', async () => {
  const env = createDashboard();
  const w = env.window;
  const records = [null, false, 10, [], rec('Ann', 'bad'), rec('Ann', '1:23.000'),
    rec('Broken', {}), rec('Broken', -1), rec('Invalid', 'bad'), rec('Invalid', '1:25.000', { is_valid: false })];
  w.updateEventDateOptions(records);
  assert.equal(w.recordDate(null), '');
  assert.equal(w.recordDate(undefined), '');
  env.set('eventDateFilter', '2026-01-01');
  assert.deepEqual(plain(w.filterRecordsByEventDate(records)), []);
  env.set('eventDateFilter', '');
  const drivers = w.buildDriversFromRecords(records);
  assert.equal(drivers.Ann.lap_times[0].time, '1:23.000');
  assert.equal(drivers.Invalid.lap_times[0].time, '1:25.000');
  assert.equal(w.isBetterLap({ time: 'bad', is_valid: true }, { time: '1:23.000', is_valid: true }), false);
  assert.equal(w.isBetterLap({ time: '1:23.000', is_valid: true }, { time: 'bad', is_valid: true }), true);
  w.updateLeaderboard(drivers);
  const broken = rows(env.document).find(row => row.dataset.driver === 'Broken');
  assert.equal(broken.querySelector('.col-pos').textContent, '');
  assert.equal(broken.querySelector('.col-pos').className.trim(), 'td-pos col-pos');
  assert.equal(broken.querySelector('.col-gap').textContent, '—');
  assert.equal(broken.querySelector('.col-interval').textContent, '—');
  assert.equal(broken.querySelector('.laptime-badge').textContent, 'N/A');
  assert.equal(broken.querySelector('.laptime-badge').classList.contains('fastest'), false);
  assert.equal(broken.classList.contains('invalid-row'), true);
  assert.equal(w.formatTopSpeed(NaN), '—');
  assert.equal(w.formatTopSpeed({}), '—');
  assert.equal(w.formatTopSpeed(-1), '—');
  env.set('currentTrack', 'japan');
  env.fetchHandler = () => jsonResponse({ lap_times: records });
  await w.refreshDisplayData();
  assert.equal(env.logs.error.length, 0);
  assert.deepEqual(rows(env.document).map(row => row.dataset.driver), ['Ann', 'Invalid']);
});

test('sector calculations normalize numeric strings and reject malformed or nonfinite values', () => {
  const { window: w } = createDashboard();
  assert.equal(w.potentialMs({ best_sectors: { s1: '1000', s2: '2000', s3: '3000' } }), 6000);
  assert.equal(w.potentialMs({ best_sectors: { s1: 1e308, s2: 1e308, s3: 1e308 } }), 0);
  assert.equal(w.formatPotentialTime({ best_sectors: { s1: '1000', s2: '2000', s3: '3000' } }), '0:06.000');
  for (const value of [true, {}, [], Infinity, NaN, 'bad', '', -1]) {
    assert.equal(w.sectorMs(value), 0);
    assert.equal(w.formatLeaderboardSectorMs(value), '—');
    assert.equal(w.sectorColorClass(value, 1000, 1000, true), 'sector-none');
    assert.equal(w.potentialMs({ best_sectors: { s1: value, s2: 2000, s3: 3000 } }), 0);
  }
  assert.equal(w.minSector('1000', '900'), 900);
  assert.equal(w.liveDeltaMs({ s1: '1000', s2: '2000' }, { sector_1_ms: '1100', sector_2_ms: '2200' }), -300);
  assert.equal(w.formatTopSpeed(NaN), '—');
  assert.equal(w.formatTopSpeed({}), '—');
  assert.equal(w.formatTopSpeed(-1), '—');
});

test('recent lap chronology compares parsed instants including timezone offsets', () => {
  const { window: w } = createDashboard();
  const drivers = w.buildDriversFromRecords([
    rec('Ann', '1:21.000', { recorded_at: '2026-01-01T10:00:00+02:00' }),
    rec('Ann', '1:22.000', { recorded_at: '2026-01-01T09:30:00Z' })
  ]);
  assert.deepEqual(plain(drivers.Ann.recent_laps.map(lap => lap.time)), ['1:22.000', '1:21.000']);
});

test('historical event dates show recorded sectors and exclude current flying drivers', () => {
  const env = createDashboard();
  const w = env.window;
  env.clock.set(Date.parse('2026-10-07T12:00:00'));
  const drivers = w.buildDriversFromRecords([rec('Ann', '1:23.000', { sector_1_ms: 1000 })]);
  env.set('latestLiveDrivers', { a: { name: 'Ann', live_lap_active: true, live_sector_1_ms: 900 },
    b: { name: 'LiveOnly', live_lap_active: true, live_sector_1_ms: 800 } });
  env.set('eventDateFilter', '2026-10-06');
  w.updateLeaderboard(drivers);
  assert.deepEqual(rows(env.document).map(row => row.dataset.driver), ['Ann']);
  assert.equal(env.document.getElementById('driverCount').textContent, '1');
  assert.equal(rows(env.document)[0].querySelector('.sector-box').textContent, '1.000');
  assert.equal(Object.keys(env.get('leaderboardLiveLapSectors')).length, 0);
  env.set('eventDateFilter', '2026-10-07');
  w.updateLeaderboard(drivers);
  assert.equal(rows(env.document).length, 2);
  assert.equal(rows(env.document)[0].querySelector('.sector-box').textContent, '0.900');
});

test('expansion buttons expose native keyboard semantics and keep focus through redraws', () => {
  const env = createDashboard();
  const w = env.window;
  const name = '__proto__ " [ ] < >';
  const drivers = w.buildDriversFromRecords([rec(name, '1:23.000')]);
  w.updateLeaderboard(drivers);
  let button = env.document.querySelector('.expand-toggle');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.type, 'button');
  assert.equal(button.getAttribute('aria-label'), 'Expand laps for ' + name);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  button.focus();
  button.click();
  button = env.document.querySelector('.expand-toggle');
  assert.equal(env.document.activeElement, button);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Collapse laps for ' + name);
  env.set('latestLiveDrivers', { a: { name, live_lap_active: true, live_sector_1_ms: 1234 } });
  w.updateLeaderboard(drivers);
  button = env.document.querySelector('.expand-toggle');
  assert.equal(env.document.activeElement, button);
  button.click();
  assert.equal(env.document.querySelectorAll('.lap-detail-row').length, 0);
  assert.equal(env.document.activeElement.getAttribute('aria-expanded'), 'false');
  env.set('leaderboardSearchQuery', 'missing');
  w.updateLeaderboard(drivers);
  assert.equal(env.document.querySelector('.expand-toggle'), null);
});

test('PB chart spans all ten leaderboard columns', () => {
  const env = createDashboard();
  const w = env.window;
  w.updateLeaderboard(w.buildDriversFromRecords([rec('Ann', '1:23.000'), rec('Ann', '1:24.000')]));
  w.toggleDriverExpand('Ann');
  assert.equal(env.document.querySelector('.pb-chart-row td').colSpan, 10);
});

test('hiding the position column keeps lap deletion in the visible name cell', () => {
  const env = createDashboard();
  const w = env.window;
  w.updateLeaderboard(w.buildDriversFromRecords([rec('Ann', '1:23.000'), rec('Ann', '1:24.000')]));
  w.toggleDriverExpand('Ann');
  env.get('columnVisibility').pos = false;
  w.applyColumnSettings();
  assert.equal(env.document.querySelector('.timing-table').classList.contains('hide-col-pos'), true);
  const buttons = Array.from(env.document.querySelectorAll('.lap-delete-btn'));
  assert.equal(buttons.length, 2);
  for (const button of buttons) {
    assert.equal(button.closest('td').className, 'lap-detail-when');
    assert.equal(button.closest('.col-pos'), null);
    assert.equal(button.closest('tr').cells.length, 10);
  }
});

test('valid-only expanded history finds older valid laps before applying the five-lap limit', () => {
  const env = createDashboard();
  const w = env.window;
  const records = Array.from({ length: 8 }, (_, index) => rec('Ann', `1:2${index}.000`, {
    is_valid: index < 2, recorded_at: `2026-01-01T10:0${index}:00`
  }));
  w.updateLeaderboard(w.buildDriversFromRecords(records));
  env.set('leaderboardValidOnly', true);
  w.toggleDriverExpand('Ann');
  const details = Array.from(env.document.querySelectorAll('.lap-detail-row .laptime-badge'));
  assert.deepEqual(details.map(lap => lap.textContent), ['1:21.000', '1:20.000']);
});
