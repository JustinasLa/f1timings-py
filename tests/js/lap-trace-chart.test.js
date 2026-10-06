'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboard } = require('./harness.js');

function comparison(leaderTime = '1:20.000') {
  return {
    driver: { name: 'Lewis', lap_times: [{ time: '1:21.000' }] },
    leader: { name: 'Max', lap_times: [{ time: leaderTime }] },
    driverTrace: [[0, 0, 280, 1, 0], [200, 2000, 120, 0, 1]],
    leaderTrace: [[0, 0, 285, 1, 0], [100, 900, 130, 0.5, 0.5]]
  };
}

test('trace chart plots throttle and brake for driver and leader over lap fraction', () => {
  const env = createDashboard();
  const chart = env.document.getElementById('traceChart');
  env.window.devicePixelRatio = 2;
  env.window.drawLapTraceChart(comparison());

  assert.equal(chart.hidden, false);
  assert.deepEqual([chart.width, chart.height], [2400, 480]);
  const calls = env.ctx2d.calls;
  assert.deepEqual(calls[0].args, [2, 0, 0, 2, 0, 0]);
  assert.deepEqual(
    calls.filter((c) => c.name === 'stroke').map((c) => c.state.strokeStyle),
    ['rgba(46,204,113,0.35)', '#2ecc71', 'rgba(231,76,60,0.35)', '#e74c3c']
  );
  // Leader throttle: full at the start (top of band), half at the end (lap fraction 1).
  const leaderThrottle = calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo').slice(0, 2);
  assert.deepEqual(leaderThrottle.map((c) => c.args), [[24, 24], [1176, 24 + 84 * 0.5]]);
  assert.deepEqual(
    calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]),
    ['Throttle', 'Brake', 'Lewis (solid) vs Max (faded)']
  );
});

test('trace chart redraws only when the comparison changes and hides without one', () => {
  const env = createDashboard();
  const chart = env.document.getElementById('traceChart');
  env.window.drawLapTraceChart(comparison());
  const drawn = env.ctx2d.calls.length;

  env.window.drawLapTraceChart(comparison());
  assert.equal(env.ctx2d.calls.length, drawn);

  env.window.drawLapTraceChart(comparison('1:19.000'));
  assert.ok(env.ctx2d.calls.length > drawn);

  env.window.drawLapTraceChart(null);
  assert.equal(chart.hidden, true);
  assert.equal(env.get('lastTraceChartKey'), '');
});

test('trace chart tolerates a page without the chart canvas', () => {
  const env = createDashboard({ html: '<body></body>' });
  env.window.drawLapTraceChart(comparison());
  assert.equal(env.ctx2d.calls.length, 0);
});
