// Throttle (top) and brake (bottom) over lap distance for the driver compared
// on the track map (solid) against the leader (faded).
const TRACE_CHART_WIDTH = 1200;
const TRACE_CHART_HEIGHT = 240;
const TRACE_CHART_PAD = 24;
let lastTraceChartKey = '';

function drawLapTraceChart(comparison) {
  const chart = document.getElementById('traceChart');
  if (!chart) return;
  chart.hidden = !comparison;
  if (!comparison) {
    lastTraceChartKey = '';
    return;
  }

  const dpr = window.devicePixelRatio;
  const key = [comparison.driver.name, comparison.driver.lap_times[0].time,
    comparison.leader.name, comparison.leader.lap_times[0].time, dpr].join('|');
  if (key === lastTraceChartKey) return;
  lastTraceChartKey = key;

  const chartCtx = chart.getContext('2d');
  chart.width = Math.round(TRACE_CHART_WIDTH * dpr);
  chart.height = Math.round(TRACE_CHART_HEIGHT * dpr);
  chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  chartCtx.clearRect(0, 0, TRACE_CHART_WIDTH, TRACE_CHART_HEIGHT);

  const bandHeight = (TRACE_CHART_HEIGHT - TRACE_CHART_PAD * 3) / 2;
  const brakeTop = TRACE_CHART_PAD * 2 + bandHeight;
  plotTraceSeries(chartCtx, comparison.leaderTrace, 3, TRACE_CHART_PAD, bandHeight, 'rgba(46,204,113,0.35)');
  plotTraceSeries(chartCtx, comparison.driverTrace, 3, TRACE_CHART_PAD, bandHeight, '#2ecc71');
  plotTraceSeries(chartCtx, comparison.leaderTrace, 4, brakeTop, bandHeight, 'rgba(231,76,60,0.35)');
  plotTraceSeries(chartCtx, comparison.driverTrace, 4, brakeTop, bandHeight, '#e74c3c');

  chartCtx.fillStyle = '#9aa3ad';
  chartCtx.font = 'bold 11px Inter, Arial';
  chartCtx.textAlign = 'left';
  chartCtx.textBaseline = 'bottom';
  chartCtx.fillText('Throttle', TRACE_CHART_PAD, TRACE_CHART_PAD - 4);
  chartCtx.fillText('Brake', TRACE_CHART_PAD, brakeTop - 4);
  chartCtx.textAlign = 'right';
  chartCtx.fillText(comparison.driver.name + ' (solid) vs ' + comparison.leader.name + ' (faded)',
    TRACE_CHART_WIDTH - TRACE_CHART_PAD, TRACE_CHART_PAD - 4);
}

// Samples are [distance_m, elapsed_ms, speed_kph, throttle, brake]; x is lap fraction.
function plotTraceSeries(chartCtx, samples, column, top, height, color) {
  const total = samples[samples.length - 1][0];
  const width = TRACE_CHART_WIDTH - TRACE_CHART_PAD * 2;
  chartCtx.strokeStyle = color;
  chartCtx.lineWidth = 1.5;
  chartCtx.beginPath();
  samples.forEach((sample, i) => {
    const x = TRACE_CHART_PAD + (sample[0] / total) * width;
    const y = top + height * (1 - sample[column]);
    if (i === 0) {
      chartCtx.moveTo(x, y);
    } else {
      chartCtx.lineTo(x, y);
    }
  });
  chartCtx.stroke();
}
