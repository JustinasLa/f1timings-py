// Logical drawing size; the backing store is scaled by devicePixelRatio so
// the map stays sharp on HiDPI screens.
const TRACK_CANVAS_WIDTH = 1200;
const TRACK_CANVAS_HEIGHT = 800;
let trackMapRequestId = 0;
let trackMapInFlight = null;
let trackMapRetry = { track: '', failures: 0, nextAt: 0 };
const DATA_RETRY_MIN_MS = 2000;
const DATA_RETRY_MAX_MS = 30000;

async function loadCurrentTrack() {
  try {
    const r = await fetch('/api/track');
    if (r.ok) {
      const data = await r.json();
      if (data.name) {
        const track = data.name.toLowerCase();
        if (track !== currentTrack) {
          currentTrack = track;
          updateTrackUI();
          updateTrackSelectValue();
          loadTrackVisualization(currentTrack);
        }
        retryTrackVisualization();
        loadDisplayData();
      }
    }
  } catch (e) { console.error('Error loading track:', e); }
}

function updateTrackUI() {
  const name = TRACK_DISPLAY_NAMES[currentTrack] || currentTrack.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());
  setTrackNameWithFlag(document.getElementById("sessionTitle"), name, currentTrack);
  document.getElementById("sessionLocation").textContent = 'Grand Prix Circuit';
  setTrackNameWithFlag(document.getElementById("trackHeaderName"), name + ' - Track Map', currentTrack);
  document.title = `F1 Timings - ${name}`;
}

async function loadTrackSelectOptions() {
  const toggle = document.getElementById('trackSelectToggle');
  const menu = document.getElementById('trackSelectMenu');
  if (!toggle || !menu) return;

  try {
    const trackKeys = Object.keys(TRACK_DICTIONARY).sort();

    menu.replaceChildren();
    trackKeys.forEach(value => {
      const label = TRACK_DISPLAY_NAMES[value] || value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'track-select-option';
      option.dataset.track = value;
      option.textContent = label;
      option.onclick = () => {
        closeTrackSelectMenu();
        switchDisplayTrack(value);
      };
      menu.appendChild(option);
    });

    toggle.onclick = (event) => {
      event.stopPropagation();
      const isOpen = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(isOpen));
    };
    document.addEventListener('click', closeTrackSelectMenu);
    updateTrackSelectValue();
  } catch (e) {
    console.error('Error loading track options:', e);
  }
}

function updateTrackSelectValue() {
  document.querySelectorAll('.track-select-option').forEach(option => {
    option.classList.toggle('active', option.dataset.track === currentTrack);
  });
}

function closeTrackSelectMenu() {
  const toggle = document.getElementById('trackSelectToggle');
  const menu = document.getElementById('trackSelectMenu');
  if (!toggle || !menu) return;

  menu.classList.remove('open');
  toggle.setAttribute('aria-expanded', 'false');
}

function switchDisplayTrack(trackName) {
  if (!trackName || trackName === currentTrack) return;

  currentTrack = trackName.toLowerCase();
  trackData = null;
  trackRendered = false;
  updateTrackUI();
  updateTrackSelectValue();
  loadTrackVisualization(currentTrack);
  loadDisplayData();

  saveCurrentTrackToBackend(currentTrack);
}

function saveCurrentTrackToBackend(trackName) {
  fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: trackName })
  }).catch(e => console.error('Error setting track:', e));
}

function getTwemojiFlagUrl(countryCode) {
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => (char.charCodeAt(0) + 127397).toString(16))
    .join('-');
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${codePoints}.svg`;
}

function setTrackNameWithFlag(element, text, trackName) {
  if (!element) return;

  element.replaceChildren();
  const countryCode = TRACK_COUNTRY_CODES[trackName];
  if (countryCode) {
    const flag = document.createElement('img');
    flag.className = 'track-country-flag';
    flag.src = getTwemojiFlagUrl(countryCode);
    flag.alt = countryCode;
    flag.decoding = 'async';
    element.appendChild(flag);
  }
  element.appendChild(document.createTextNode(text));
}

async function loadTrackVisualization(trackName) {
  const track = trackName.toLowerCase();
  if (trackMapInFlight && trackMapInFlight.track === track) return;
  const requestId = ++trackMapRequestId;
  const selectedTrack = currentTrack;
  trackMapInFlight = { track, requestId };
  if (trackMapRetry.track !== track) trackMapRetry = { track, failures: 0, nextAt: 0 };
  trackData = null;
  trackRendered = false;
  const isCurrent = () => requestId === trackMapRequestId && currentTrack === selectedTrack;
  try {
    const params = TRACK_DICTIONARY[track];
    if (!params) {
      trackMapRetry.nextAt = Infinity;
      showTrackPlaceholder(`No map data for ${trackName}`);
      return;
    }

    const newData = await fetchJsonWithTimeout(`/api/track/data?track=${encodeURIComponent(track)}`, 1500);
    if (!isCurrent()) return;
    if (!Array.isArray(newData.points) || newData.points.length < 2) {
      deferTrackMapRetry();
      showTrackPlaceholder('No track points available');
      return;
    }

    trackData = newData;
    trackMapRetry = { track, failures: 0, nextAt: 0 };
    if (typeof resetMapInteractions === 'function') resetMapInteractions();
    canvas.style.display = 'block';
    document.getElementById('trackPlaceholder').style.display = 'none';
    drawTrackOnCanvas(trackData, params);
  } catch (e) {
    if (!isCurrent()) return;
    deferTrackMapRetry();
    console.error('Error loading track:', e);
    showTrackPlaceholder('Track data unavailable');
  } finally {
    if (trackMapInFlight?.requestId === requestId) trackMapInFlight = null;
  }
}

function deferTrackMapRetry() {
  trackMapRetry.failures++;
  trackMapRetry.nextAt = Date.now() + Math.min(DATA_RETRY_MAX_MS,
    DATA_RETRY_MIN_MS * 2 ** Math.min(trackMapRetry.failures - 1, 4));
}

function retryTrackVisualization() {
  if (!canvas || !ctx || !currentTrack || (trackData && trackRendered) || trackMapInFlight) return;
  if (trackMapRetry.track === currentTrack && Date.now() < trackMapRetry.nextAt) return;
  return loadTrackVisualization(currentTrack);
}

function showTrackPlaceholder(msg) {
  canvas.style.display = 'none';
  const ph = document.getElementById('trackPlaceholder');
  ph.style.display = 'flex';
  ph.querySelector('div:last-child').textContent = msg;
}

function rotatePlanePoint(x, y, rotationDegrees) {
  if (!rotationDegrees) return { x: x, y: y };
  const radians = rotationDegrees * Math.PI / 180;
  const cosAngle = Math.cos(radians);
  const sinAngle = Math.sin(radians);
  return {
    x: x * cosAngle - y * sinAngle,
    y: x * sinAngle + y * cosAngle
  };
}

function planeToCanvas(planeX, planeY, params, transform) {
  const rotation = params.rotation || 0;
  const rotated = rotatePlanePoint(planeX, planeY, rotation);
  return {
    x: (rotated.x - transform.minX) * transform.scale + transform.centerOffsetX,
    y: (rotated.y - transform.minY) * transform.scale + transform.centerOffsetY
  };
}

function computeTrackTransform(td, params) {
  const d = params.d;
  const x_offset = params.x_offset;
  const z_offset = params.z_offset;
  const rotation = params.rotation || 0;
  const pad = 40;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of td.points) {
    const planeX = (point.pos_z / d) + x_offset;
    const planeY = (point.pos_x / d) + z_offset;
    const rotated = rotatePlanePoint(planeX, planeY, rotation);
    if (rotated.x < minX) minX = rotated.x;
    if (rotated.x > maxX) maxX = rotated.x;
    if (rotated.y < minY) minY = rotated.y;
    if (rotated.y > maxY) maxY = rotated.y;
  }

  let rangeX = maxX - minX;
  let rangeY = maxY - minY;
  if (rangeX <= 0) rangeX = 1;
  if (rangeY <= 0) rangeY = 1;

  const scale = Math.min((TRACK_CANVAS_WIDTH - pad * 2) / rangeX, (TRACK_CANVAS_HEIGHT - pad * 2) / rangeY);
  const centerOffsetX = (TRACK_CANVAS_WIDTH - rangeX * scale) / 2;
  const centerOffsetY = (TRACK_CANVAS_HEIGHT - rangeY * scale) / 2;
  return { minX: minX, minY: minY, scale: scale, centerOffsetX: centerOffsetX, centerOffsetY: centerOffsetY };
}

function buildTrackCanvasPoints(td, params, transform) {
  const canvasPoints = [];
  for (const point of td.points) {
    const planeX = (point.pos_z / params.d) + params.x_offset;
    const planeY = (point.pos_x / params.d) + params.z_offset;
    canvasPoints.push(planeToCanvas(planeX, planeY, params, transform));
  }
  return canvasPoints;
}

function strokeTrackOutline(canvasPoints) {
  if (canvasPoints.length === 0) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.lineWidth = 14;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  for (let i = 0; i < canvasPoints.length; i++) {
    if (i === 0) {
      ctx.moveTo(canvasPoints[i].x, canvasPoints[i].y);
    } else {
      ctx.lineTo(canvasPoints[i].x, canvasPoints[i].y);
    }
  }
  ctx.lineTo(canvasPoints[0].x, canvasPoints[0].y);
  ctx.stroke();

  ctx.lineWidth = 5;
  ctx.strokeStyle = '#e6edf3';
  ctx.beginPath();
  for (let i = 0; i < canvasPoints.length; i++) {
    if (i === 0) {
      ctx.moveTo(canvasPoints[i].x, canvasPoints[i].y);
    } else {
      ctx.lineTo(canvasPoints[i].x, canvasPoints[i].y);
    }
  }
  ctx.lineTo(canvasPoints[0].x, canvasPoints[0].y);
  ctx.stroke();
}

// Re-checked on every redraw so browser zoom or moving to another monitor
// (both change devicePixelRatio) is picked up on the next telemetry tick.
function matchCanvasToDevicePixels() {
  const dpr = window.devicePixelRatio;
  const width = Math.round(TRACK_CANVAS_WIDTH * dpr);
  if (canvas.width === width) return;
  canvas.width = width;
  canvas.height = Math.round(TRACK_CANVAS_HEIGHT * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawTrackOnCanvas(td, params) {
  if (td.points.length < 2) return;

  matchCanvasToDevicePixels();
  ctx.clearRect(0, 0, TRACK_CANVAS_WIDTH, TRACK_CANVAS_HEIGHT);

  const transform = computeTrackTransform(td, params);
  td.transformParams = transform;

  drawPitlane();

  const canvasPoints = buildTrackCanvasPoints(td, params, transform);
  strokeTrackOutline(canvasPoints);

  trackRendered = true;

  drawTrackMarkers();
}

function redrawCompleteTrack() {
  if (!trackData || !trackData.transformParams) return;
  const params = TRACK_DICTIONARY[currentTrack.toLowerCase()];
  if (!params) return;

  matchCanvasToDevicePixels();
  ctx.clearRect(0, 0, TRACK_CANVAS_WIDTH, TRACK_CANVAS_HEIGHT);

  drawPitlane();

  const canvasPoints = buildTrackCanvasPoints(trackData, params, trackData.transformParams);
  strokeTrackOutline(canvasPoints);
  strokeGainLossOverlay(canvasPoints);
  drawLapTraceChart(findTraceComparison());

  drawTrackMarkers();
}

// Gain/loss colouring: the most recently expanded leaderboard driver against
// the leader, from each one's best-lap trace ([distance_m, elapsed_ms, ...]).
const GAIN_COLOR = '#2ecc71';
const LOSS_COLOR = '#e74c3c';
const lapTraceCache = {};
const lapTraceRequests = {};
let gainLossCache = { key: '', track: null, colors: [] };

function getLapTrace(driver) {
  const lap = driver.lap_times[0];
  const key = currentTrack + '|' + driver.name + '|' + lap.time;
  const request = lapTraceRequests[key];
  if (!lapTraceCache[key] && (!request || (!request.inFlight && Date.now() >= request.nextAt))) {
    lapTraceCache[key] = null;
    const state = request || { inFlight: false, failures: 0, nextAt: 0 };
    lapTraceRequests[key] = state;
    state.inFlight = true;
    const url = '/api/track/trace?track=' + encodeURIComponent(currentTrack) +
      '&driver=' + encodeURIComponent(driver.name);
    fetchJsonWithTimeout(url, 1500)
      .then((trace) => {
        // A trace from an older or deleted lap must not colour this one.
        if (trace.time === lap.time && Array.isArray(trace.samples) && trace.samples.length > 1) {
          lapTraceCache[key] = trace.samples;
        }
      })
      .catch(() => {})
      .finally(() => {
        state.inFlight = false;
        if (!lapTraceCache[key]) {
          state.failures++;
          state.nextAt = Date.now() + Math.min(DATA_RETRY_MAX_MS,
            DATA_RETRY_MIN_MS * 2 ** Math.min(state.failures - 1, 4));
        }
      });
  }
  return lapTraceCache[key];
}

function findTraceComparison() {
  const leader = Object.values(latestLeaderboardDrivers).find((d) => d.lap_times[0].is_fastest);
  if (!leader) return null;
  const driver = [...expandedDrivers].reverse()
    .map((name) => latestLeaderboardDrivers[name])
    .find((d) => d && d !== leader && d.lap_times[0].is_valid);
  if (!driver) return null;
  const driverTrace = getLapTrace(driver);
  const leaderTrace = getLapTrace(leader);
  if (!driverTrace || !leaderTrace) return null;
  return { driver: driver, leader: leader, driverTrace: driverTrace, leaderTrace: leaderTrace };
}

// Elapsed ms at a fraction of the lap, interpolated between samples.
function traceTimeAt(samples, fraction) {
  const target = fraction * samples[samples.length - 1][0];
  let i = 1;
  while (i < samples.length - 1 && samples[i][0] < target) i++;
  const [d0, t0] = samples[i - 1];
  const [d1, t1] = samples[i];
  return t0 + (t1 - t0) * (target - d0) / (d1 - d0);
}

// Map points carry cumulative distance from the start line, so each point's
// lap fraction lines up with the same fraction of the trace.
function computeGainLossColors(points, driverTrace, leaderTrace) {
  const total = points[points.length - 1].dist;
  const deltas = points.map((point) =>
    traceTimeAt(driverTrace, point.dist / total) - traceTimeAt(leaderTrace, point.dist / total));
  const colors = [];
  for (let k = 0; k < points.length - 1; k++) {
    colors.push(deltas[k + 1] - deltas[k] <= 0 ? GAIN_COLOR : LOSS_COLOR);
  }
  return colors;
}

function strokeGainLossOverlay(canvasPoints) {
  const comparison = findTraceComparison();
  if (!comparison) return;
  const key = [comparison.driver.name, comparison.driver.lap_times[0].time,
    comparison.leader.name, comparison.leader.lap_times[0].time].join('|');
  if (gainLossCache.key !== key || gainLossCache.track !== trackData) {
    gainLossCache = {
      key: key,
      track: trackData,
      colors: computeGainLossColors(trackData.points, comparison.driverTrace, comparison.leaderTrace)
    };
  }

  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  gainLossCache.colors.forEach((color, k) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(canvasPoints[k].x, canvasPoints[k].y);
    ctx.lineTo(canvasPoints[k + 1].x, canvasPoints[k + 1].y);
    ctx.stroke();
  });

  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 12px Inter, Arial';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(comparison.driver.name + ' vs ' + comparison.leader.name +
    ': green gains, red loses', 16, TRACK_CANVAS_HEIGHT - 16);
}

function localToCanvas(posX, posZ, params, transform) {
  const planeX = (posZ / params.d) + params.x_offset;
  const planeY = (posX / params.d) + params.z_offset;
  return planeToCanvas(planeX, planeY, params, transform);
}

function findNearestPointIndex(canvasPoints, target) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < canvasPoints.length; i++) {
    const dx = canvasPoints[i].x - target.x;
    const dy = canvasPoints[i].y - target.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function trackDirectionAcross(canvasPoints, index) {
  let before = index - 1;
  if (before < 0) before = canvasPoints.length - 1;
  let after = index + 1;
  if (after > canvasPoints.length - 1) after = 0;

  let dx = canvasPoints[after].x - canvasPoints[before].x;
  let dy = canvasPoints[after].y - canvasPoints[before].y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return { x: 0, y: 0 };
  dx = dx / length;
  dy = dy / length;
  return { x: -dy, y: dx };
}

function drawMarkingLine(center, across, label) {
  const halfWidth = 11;

  let color = '#f1c40f';
  if (label === 'S/F') {
    color = '#ffffff';
  }

  ctx.beginPath();
  ctx.moveTo(center.x - across.x * halfWidth, center.y - across.y * halfWidth);
  ctx.lineTo(center.x + across.x * halfWidth, center.y + across.y * halfWidth);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'butt';
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = 'bold 10px Inter, Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, center.x + across.x * (halfWidth + 9), center.y + across.y * (halfWidth + 9));
}

function drawPitlane() {
  if (!trackData || !trackData.transformParams) return;
  if (!Array.isArray(trackData.pitlane) || trackData.pitlane.length < 2) return;
  const params = TRACK_DICTIONARY[currentTrack.toLowerCase()];
  if (!params) return;
  const transform = trackData.transformParams;

  const pathPoints = [];
  for (const point of trackData.pitlane) {
    pathPoints.push(localToCanvas(point.pos_x, point.pos_z, params, transform));
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 9;
  ctx.strokeStyle = 'rgba(160,160,160,0.18)';
  ctx.beginPath();
  for (let i = 0; i < pathPoints.length; i++) {
    if (i === 0) {
      ctx.moveTo(pathPoints[i].x, pathPoints[i].y);
    } else {
      ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
    }
  }
  ctx.stroke();

  ctx.lineWidth = 4;
  ctx.strokeStyle = '#9aa3ad';
  ctx.beginPath();
  for (let i = 0; i < pathPoints.length; i++) {
    if (i === 0) {
      ctx.moveTo(pathPoints[i].x, pathPoints[i].y);
    } else {
      ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
    }
  }
  ctx.stroke();
}

function drawTrackMarkers() {
  if (!trackData || !trackData.transformParams) return;
  if (!Array.isArray(trackData.markers) || trackData.markers.length === 0) return;
  const params = TRACK_DICTIONARY[currentTrack.toLowerCase()];
  if (!params) return;
  const transform = trackData.transformParams;

  const trackCanvasPoints = [];
  for (const point of trackData.points) {
    trackCanvasPoints.push(localToCanvas(point.pos_x, point.pos_z, params, transform));
  }

  for (const marker of trackData.markers) {
    const markerPos = localToCanvas(marker.pos_x, marker.pos_z, params, transform);

    const nearestIndex = findNearestPointIndex(trackCanvasPoints, markerPos);
    const center = trackCanvasPoints[nearestIndex];
    const across = trackDirectionAcross(trackCanvasPoints, nearestIndex);

    drawMarkingLine(center, across, marker.label);
  }
}

function drawDriversOnTrack(driversData) {
  if (!canvas || !ctx || !trackData || !trackData.transformParams) return;
  const params = TRACK_DICTIONARY[currentTrack.toLowerCase()];
  if (!params) return;

  redrawCompleteTrack();

  const { d, x_offset, z_offset, driver_x_offset = 0, driver_z_offset = 0 } = params;
  const transform = trackData.transformParams;

  for (const [name, driver] of Object.entries(driversData)) {
    if (!hasLivePosition(driver)) continue;

    const planeX = (Number(driver.world_x) / d) + x_offset + driver_x_offset;
    const planeY = (Number(driver.world_z) / d) + z_offset + driver_z_offset;
    const driverCanvas = planeToCanvas(planeX, planeY, params, transform);
    const canvasX = driverCanvas.x;
    const canvasY = driverCanvas.y;

    const color = getLiveDriverColor(driver);

    ctx.beginPath();
    ctx.arc(canvasX, canvasY, DRIVER_DOT_RADIUS + 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(canvasX, canvasY, DRIVER_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(canvasX, canvasY, DRIVER_DOT_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    const displayName = (driver.name || name || '').trim();
    const nameParts = displayName.split(' ');
    let initials = '';
    for (let p = 0; p < nameParts.length; p++) {
      if (nameParts[p].length > 0) {
        initials = initials + nameParts[p][0];
      }
    }
    initials = initials.toUpperCase().slice(0, 3);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px Inter, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, canvasX, canvasY);
  }
}

function getLiveDriverColor(driver) {
  const index = Number(driver.instance_index);
  if (Number.isInteger(index) && index >= 0) {
    return INSTANCE_COLORS[index % INSTANCE_COLORS.length];
  }
  return TEAM_COLORS[driver.team] || TEAM_COLORS['DEFAULT'];
}
