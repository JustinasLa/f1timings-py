'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard, plain } = require('./harness.js');

function leaderboard(env) {
  env.set('latestLeaderboardDrivers', {
    Ghost: null,
    NoLaps: { name: 'NoLaps' },
    Ann: { lap_times: [{ time: '1:30.000', is_valid: true }, { time: '1:20.000', is_valid: false }] },
    Bob: { lap_times: [{ time: '1:32.000', is_valid: true }, { time: '1:33.000', is_valid: true }] }
  });
}

test('classifyLapForToast labels invalid, fastest, personal best and normal laps', () => {
  const env = createDashboard();
  const w = env.window;
  leaderboard(env);
  assert.deepEqual(plain(w.classifyLapForToast({ name: 'Ann', time: '1:00.000', is_valid: false })), { qualityClass: 'invalid', labelText: 'Invalid Lap' });
  assert.deepEqual(plain(w.classifyLapForToast({ name: 'Bob', time: '1:30.000' })), { qualityClass: 'fastest', labelText: 'Fastest Lap' });
  assert.deepEqual(plain(w.classifyLapForToast({ name: 'Bob', time: '1:31.000' })), { qualityClass: 'best', labelText: 'Personal Best' });
  assert.deepEqual(plain(w.classifyLapForToast({ name: 'Bob', time: '1:32.500' })), { qualityClass: 'normal', labelText: 'Lap' });
  // A driver's first valid lap has nothing to beat, so it is not a personal best.
  assert.deepEqual(plain(w.classifyLapForToast({ name: 'New', time: '1:40.000' })), { qualityClass: 'normal', labelText: 'Lap' });
  assert.deepEqual(plain(w.classifyLapForToast({ name: 'NoLaps', time: '1:40.000' })), { qualityClass: 'normal', labelText: 'Lap' });
});

test('buildToastSectorsHtml renders coloured sectors only when any sector is known', () => {
  const env = createDashboard();
  const w = env.window;
  assert.equal(w.buildToastSectorsHtml({ name: 'A' }), '');
  assert.equal(w.buildToastSectorsHtml({ name: 'A', sector_1_ms: 0, sector_2_ms: -1, sector_3_ms: null }), '');

  env.set('leaderboardPersonalBestSectors', { A: { s1: 30000, s2: 30000, s3: 30000 } });
  env.set('leaderboardOverallBestSectors', { s1: 29000, s2: 29000, s3: 29000 });
  assert.equal(
    w.buildToastSectorsHtml({ name: 'A', sector_1_ms: 31000, sector_2_ms: 28000, sector_3_ms: 30000 }),
    '<div class="lap-toast-sectors"><span class="sector-box sector-yellow">31.000</span>' +
      '<span class="sector-box sector-purple">28.000</span><span class="sector-box sector-green">30.000</span></div>'
  );
  assert.match(w.buildToastSectorsHtml({ name: 'B', sector_2_ms: 40000 }), /sector-none">—.*sector-green">40\.000.*sector-none">—/);
  assert.match(w.buildToastSectorsHtml({ name: 'B', sector_3_ms: 40000, is_valid: false }), /^(?:(?!sector-green).)*sector-invalid">40\.000/);
});

test('showLapToast prepends a toast that fades and is removed', () => {
  const env = createDashboard();
  const w = env.window;
  const container = env.document.getElementById('lap-toast-container');
  w.showLapToast({ name: 'A<b>', time: '1:30.000', sector_1_ms: 30000 });
  w.showLapToast({ name: 'Second', time: '1:29.000', is_valid: false });

  const toasts = container.querySelectorAll('.lap-toast');
  assert.equal(toasts.length, 2);
  assert.equal(toasts[0].className, 'lap-toast invalid');
  assert.match(toasts[0].querySelector('.lap-toast-label').textContent, /Invalid Lap/);
  const first = toasts[1];
  assert.equal(first.className, 'lap-toast fastest');
  assert.equal(first.querySelector('.lap-toast-driver').textContent.trim(), 'A<b>');
  assert.equal(first.querySelector('.lap-toast-time').textContent, '1:30.000');
  assert.ok(first.querySelector('.lap-toast-sectors'));
  assert.equal(toasts[0].querySelector('.lap-toast-sectors'), null);

  env.clock.advance(7999);
  assert.ok(!first.classList.contains('fading'));
  env.clock.advance(1);
  assert.ok(first.classList.contains('fading'));
  assert.equal(container.children.length, 2);
  first.dispatchEvent(new w.Event('animationend'));
  assert.equal(container.children.length, 1);
});

test('showInfoToast appends info and error toasts that fade out', () => {
  const env = createDashboard();
  const w = env.window;
  const container = env.document.getElementById('toast-container');
  w.showInfoToast('Hello <x>', 'World & co', false);
  w.showInfoToast('Oops', 'Bad', true);
  const toasts = container.children;
  assert.equal(toasts[0].className, 'info-toast');
  assert.equal(toasts[0].querySelector('.toast-driver').textContent, 'Hello <x>');
  assert.equal(toasts[0].querySelector('.info-toast-message').textContent, 'World & co');
  assert.equal(toasts[1].className, 'info-toast error');

  env.clock.advance(3000);
  assert.ok(toasts[0].classList.contains('fading'));
  toasts[0].dispatchEvent(new w.Event('animationend'));
  assert.equal(container.children.length, 1);
});

test('showInfoToast without a container does nothing', () => {
  const env = createDashboard({ html: '<div></div>' });
  env.window.showInfoToast('a', 'b', false);
  assert.equal(env.clock.pending().length, 0);
});
