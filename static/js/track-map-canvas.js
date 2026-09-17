/* Track map canvas: loading track data, rendering the circuit and live driver dots. */

async function loadCurrentTrack() {
  try {
    const r = await fetch('/api/track');
    if (r.ok) {
      const data = await r.json();
      if (data.name) {
        currentTrack = data.name.toLowerCase();
        updateTrackUI();
        updateTrackSelectValue();
        loadTrackVisualization(currentTrack);
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
    // The supported tracks are exactly the ones in TRACK_DICTIONARY (keyed by
    // country), so build the menu straight from those keys. Each key is also the
    // name of its data files, so selecting it always works.
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

  // Tell the backend which track is selected so newly driven laps are saved to
  // this track's file. Without this the backend never knows the track and no
  // laps get saved.
  saveCurrentTrackToBackend(currentTrack);
}

/* Send the selected track name to the backend so auto-saved laps are written to
   the right track file. Failures are non-fatal for the display, so we only log. */
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
  try {
    const params = TRACK_DICTIONARY[trackName.toLowerCase()];
    if (!params) { showTrackPlaceholder(`No map data for ${trackName}`); return; }

    const r = await fetch(`/api/track/data?track=${encodeURIComponent(trackName.toLowerCase())}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const newData = await r.json();
    if (!newData.points || newData.points.length === 0) { showTrackPlaceholder('No track points available'); return; }

    trackData = newData;
    canvas.style.display = 'block';
    document.getElementById('trackPlaceholder').style.display = 'none';
    drawTrackOnCanvas(trackData, params);
  } catch (e) { console.error('Error loading track:', e); showTrackPlaceholder('Track data unavailable'); }
}

function showTrackPlaceholder(msg) {
  canvas.style.display = 'none';
  const ph = document.getElementById('trackPlaceholder');
  ph.style.display = 'flex';
  ph.querySelector('div:last-child').textContent = msg;
}

/* Rotate a point around the origin by the given angle in degrees. Positive
   angles turn the map clockwise on screen (canvas y points downwards). A zero
   or missing angle leaves the point unchanged, so tracks without a rotation
   behave exactly as before. */
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

/* The single shared world->canvas step. Every layer (track outline, markers,
   pit lane and driver dots) goes through here, so they all rotate, scale and
   centre together and stay lined up. The inputs are "world-plane" coordinates
   (already divided by d and shifted by the track's offsets); we rotate them by
   the track's rotation, then scale and centre them to fit the canvas.

   Because the rotation happens here, after the per-track driver offsets have
   already been added in the world plane, those offsets rotate along with the
   track and do not need re-tuning when a rotation is set. */
function planeToCanvas(planeX, planeY, params, transform) {
  const rotation = params.rotation || 0;
  const rotated = rotatePlanePoint(planeX, planeY, rotation);
  return {
    x: (rotated.x - transform.minX) * transform.scale + transform.centerOffsetX,
    y: (rotated.y - transform.minY) * transform.scale + transform.centerOffsetY
  };
}

/* Work out how to fit the (possibly rotated) track outline onto the canvas. We
   rotate every outline point first, then size and centre the result, so the
   rotated track always fits neatly. */
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

  // Guard against a zero-width or zero-height range (e.g. a degenerate track
  // with all points in a line), which would otherwise divide by zero and make
  // the whole map render as NaN (a blank canvas).
  let rangeX = maxX - minX;
  let rangeY = maxY - minY;
  if (rangeX <= 0) rangeX = 1;
  if (rangeY <= 0) rangeY = 1;

  const scale = Math.min((canvas.width - pad * 2) / rangeX, (canvas.height - pad * 2) / rangeY);
  const centerOffsetX = (canvas.width - rangeX * scale) / 2;
  const centerOffsetY = (canvas.height - rangeY * scale) / 2;
  return { minX: minX, minY: minY, scale: scale, centerOffsetX: centerOffsetX, centerOffsetY: centerOffsetY };
}

/* Build the canvas positions of every track outline point. */
function buildTrackCanvasPoints(td, params, transform) {
  const canvasPoints = [];
  for (const point of td.points) {
    const planeX = (point.pos_z / params.d) + params.x_offset;
    const planeY = (point.pos_x / params.d) + params.z_offset;
    canvasPoints.push(planeToCanvas(planeX, planeY, params, transform));
  }
  return canvasPoints;
}

/* Stroke the white track outline: a faint wide glow first, then the bright line
   on top. Used by both the first render and every redraw. */
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

function drawTrackOnCanvas(td, params) {
  if (td.points.length < 2) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const transform = computeTrackTransform(td, params);
  td.transformParams = transform;

  // Draw the pit lane first so the white track outline paints over it where they
  // meet, letting the gray tuck neatly under the white line.
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

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw the pit lane first so the white track outline paints over it where they meet.
  drawPitlane();

  const canvasPoints = buildTrackCanvasPoints(trackData, params, trackData.transformParams);
  strokeTrackOutline(canvasPoints);

  // Redraw the markings so they stay visible behind the moving driver dots.
  drawTrackMarkers();
}

/* Turn a local track coordinate (pos_x, pos_z) into a canvas position, using
   the same maths (including rotation) as the track outline. */
function localToCanvas(posX, posZ, params, transform) {
  const planeX = (posZ / params.d) + params.x_offset;
  const planeY = (posX / params.d) + params.z_offset;
  return planeToCanvas(planeX, planeY, params, transform);
}

/* Find the index of the track point closest to a target canvas position. */
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

/* Work out a direction that points across the track at the given point, by
   looking at the point before and after and turning that 90 degrees. */
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

/* Draw one marking line across the track with its label. The start/finish line
   is white, the sector splits are yellow. */
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

/* Draw the pit lane alongside the track. It is a separate polyline (not a closed
   loop) painted in gray so it reads clearly as the pit road rather than the
   racing line. The pit lane points come from the backend in the same local track
   space as the outline, so they line up with it. */
function drawPitlane() {
  if (!trackData || !trackData.transformParams) return;
  if (!Array.isArray(trackData.pitlane) || trackData.pitlane.length < 2) return;
  const params = TRACK_DICTIONARY[currentTrack.toLowerCase()];
  if (!params) return;
  const transform = trackData.transformParams;

  // Work out the canvas position of every pit lane point. The pit lane points
  // come from real telemetry that already starts and ends on the racing line
  // (the backend trims the ends to where the path meets the track), so we can
  // draw the polyline as-is and it joins the track the way a car actually drives.
  const pathPoints = [];
  for (const point of trackData.pitlane) {
    pathPoints.push(localToCanvas(point.pos_x, point.pos_z, params, transform));
  }

  // Faint wide backing line so the gray pit road stands out from the dark map.
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

  // The pit lane itself, in gray.
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

/* Draw the start/finish and sector-split markings on the current track. Each
   marking is a line painted across the track at the marked spot, plus a label.
   The marker positions come from the backend (converted from real-world
   latitude/longitude), so they line up with the real track. */
function drawTrackMarkers() {
  if (!trackData || !trackData.transformParams) return;
  if (!Array.isArray(trackData.markers) || trackData.markers.length === 0) return;
  const params = TRACK_DICTIONARY[currentTrack.toLowerCase()];
  if (!params) return;
  const transform = trackData.transformParams;

  // Work out the canvas position of every track point once, so we can find the
  // nearest point to each marking and the direction the track runs there.
  const trackCanvasPoints = [];
  for (const point of trackData.points) {
    trackCanvasPoints.push(localToCanvas(point.pos_x, point.pos_z, params, transform));
  }

  for (const marker of trackData.markers) {
    const markerPos = localToCanvas(marker.pos_x, marker.pos_z, params, transform);

    // Snap the marking onto the nearest point of the drawn track so the line
    // sits neatly across the track.
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

    // Add the per-track driver nudge in the world plane (before rotation), then
    // run it through the same shared transform as the track so the dot lines up
    // and rotates with the map.
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

    // Build initials from the name's words, skipping empty pieces so names with
    // leading/double spaces (or an all-spaces name) don't produce blank labels.
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
