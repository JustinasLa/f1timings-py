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
    rec('Ann', '1:24.000', { team: undefined }),
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
  assert.equal(cells(r[0])[7], '1');

  assert.ok(r[1].querySelector('.td-pos').classList.contains('p2'));
  assert.equal(r[1].querySelector('.team-dot').style.background, 'rgb(220, 0, 0)');
  assert.equal(cells(r[1])[6], '+0.500s');
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
  assert.deepEqual(r[4].className.trim().split(/\s+/), ['clickable-row']);

  // Invalid rows: no position, no gap, red sectors.
  assert.ok(r[5].classList.contains('invalid-row'));
  assert.equal(cells(r[5])[0], '');
  assert.equal(cells(r[5])[6], '—');
  assert.ok(r[5].querySelector('.laptime-badge').classList.contains('invalid'));
  assert.equal(r[5].querySelectorAll('.sector-invalid').length, 3);
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
  assert.equal(details[0].querySelector('.lap-detail-when').textContent, 'yesterday');
  assert.ok(details[0].querySelector('.laptime-badge').classList.contains('invalid'));
  assert.equal(details[0].querySelector('.col-gap').textContent, '—');
  assert.equal(details[0].querySelector('.lap-delete-btn').dataset.recordedAt, 'yesterday');
  assert.equal(details[1].querySelector('.lap-detail-when').textContent, '10:02:00');
  assert.equal(details[1].querySelector('.col-gap').textContent, '+1.000s');
  assert.equal(details[1].querySelector('.col-topspeed').textContent, '300 km/h');
  assert.equal(details[2].querySelector('.lap-detail-when').textContent, '10:00:00');
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
