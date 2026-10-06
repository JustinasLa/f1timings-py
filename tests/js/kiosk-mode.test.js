'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard } = require('./harness.js');

function kiosk(query) {
  const env = createDashboard({ url: 'http://localhost:8000/' + query });
  const layout = env.document.querySelector('.main-layout');
  Object.defineProperty(layout, 'clientWidth', { configurable: true, get: () => 1000 });
  env.window.initializeKioskMode();
  return { env, body: env.document.body, leftWidth: () => layout.style.getPropertyValue('--left-width') };
}

test('without ?kiosk=1 nothing changes', () => {
  const { env, body } = kiosk('?kiosk=0&cycle=5');
  assert.equal(body.className, '');
  assert.equal(env.clock.pending().length, 0);
});

test('kiosk mode hides the cursor after inactivity and shows it on mouse move', () => {
  const { env, body, leftWidth } = kiosk('?kiosk=1');
  assert.ok(body.classList.contains('kiosk'));
  assert.ok(!body.classList.contains('kiosk-idle'));
  env.clock.advance(3000);
  assert.ok(body.classList.contains('kiosk-idle'));

  env.document.dispatchEvent(new env.window.Event('mousemove'));
  assert.ok(!body.classList.contains('kiosk-idle'));
  env.clock.advance(2999);
  assert.ok(!body.classList.contains('kiosk-idle'), 'timer restarted on move');
  env.clock.advance(1);
  assert.ok(body.classList.contains('kiosk-idle'));

  assert.equal(leftWidth(), '', 'no cycling without ?cycle');
  assert.ok(env.clock.pending().every((t) => t.interval === null));
});

test('invalid cycle values do not cycle', () => {
  for (const query of ['?kiosk=1&cycle=abc', '?kiosk=1&cycle=0', '?kiosk=1&cycle=-5']) {
    const { env, leftWidth } = kiosk(query);
    assert.equal(leftWidth(), '', query);
    assert.ok(env.clock.pending().every((t) => t.interval === null), query);
  }
});

test('?cycle=N alternates leaderboard and map views every N seconds', () => {
  const { env, leftWidth } = kiosk('?kiosk=1&cycle=20');
  assert.equal(leftWidth(), '674px', 'starts leaderboard-focused');
  env.clock.advance(20000);
  assert.equal(leftWidth(), '240px', 'then map-focused');
  env.clock.advance(20000);
  assert.equal(leftWidth(), '674px');
});
