let mapInteractionController = null;

function resetMapInteractions() {
  if (mapInteractionController) mapInteractionController.reset();
}

function initializeMapInteractions() {
  const map = document.getElementById('trackCanvas');
  const zoomIn = document.getElementById('mapZoomIn');
  const zoomOut = document.getElementById('mapZoomOut');
  const reset = document.getElementById('mapZoomReset');
  const tooltip = document.getElementById('mapDriverTooltip');
  if (!map || !zoomIn || !zoomOut || !reset || !tooltip || mapInteractionController) return;
  const wrap = map.parentElement;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let drag = null;

  function apply() {
    const limitX = (zoom - 1) * map.offsetWidth / 2;
    const limitY = (zoom - 1) * map.offsetHeight / 2;
    panX = Math.max(-limitX, Math.min(limitX, panX));
    panY = Math.max(-limitY, Math.min(limitY, panY));
    map.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    reset.textContent = Math.round(zoom * 100) + '%';
    reset.setAttribute('aria-label', 'Reset map zoom (' + reset.textContent + ')');
    zoomIn.disabled = zoom >= 4;
    zoomOut.disabled = zoom <= 1;
    tooltip.hidden = true;
  }
  function changeZoom(next, clientX, clientY) {
    next = Math.max(1, Math.min(4, next));
    const bounds = wrap.getBoundingClientRect();
    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      const x = clientX - bounds.left - bounds.width / 2;
      const y = clientY - bounds.top - bounds.height / 2;
      panX = x - (x - panX) * next / zoom;
      panY = y - (y - panY) * next / zoom;
    }
    zoom = next;
    apply();
  }
  function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
    drag = null;
    map.classList.remove('map-dragging');
    apply();
  }
  function showDriver(event) {
    tooltip.hidden = true;
    if (!trackData || !trackData.transformParams) return;
    const params = TRACK_DICTIONARY[currentTrack];
    if (!params) return;
    const bounds = map.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = (event.clientX - bounds.left) * TRACK_CANVAS_WIDTH / bounds.width;
    const y = (event.clientY - bounds.top) * TRACK_CANVAS_HEIGHT / bounds.height;
    let nearest = null;
    let distance = Math.max(DRIVER_DOT_RADIUS + 4, 14 * TRACK_CANVAS_WIDTH / bounds.width);
    for (const [key, driver] of Object.entries(latestLiveDrivers)) {
      if (!hasLivePosition(driver)) continue;
      const position = planeToCanvas(
        driver.world_x / params.d + params.x_offset + (params.driver_x_offset || 0),
        driver.world_z / params.d + params.z_offset + (params.driver_z_offset || 0),
        params, trackData.transformParams
      );
      const gap = Math.hypot(x - position.x, y - position.y);
      if (gap <= distance) { nearest = { key, driver }; distance = gap; }
    }
    if (!nearest) return;
    const driver = nearest.driver;
    const title = document.createElement('strong');
    title.textContent = driver.name || nearest.key;
    const team = document.createElement('span');
    team.textContent = driver.team || 'Unknown team';
    const state = document.createElement('span');
    state.textContent = driver.live_lap_invalid === true ? 'Invalid lap' : driver.live_lap_active === true ? 'Flying lap' : 'Between laps';
    const sectors = document.createElement('span');
    sectors.textContent = 'S1 ' + formatLeaderboardSectorMs(driver.live_sector_1_ms) + ' · S2 ' + formatLeaderboardSectorMs(driver.live_sector_2_ms);
    tooltip.replaceChildren(title, team, state, sectors);
    tooltip.hidden = false;
    const parent = wrap.getBoundingClientRect();
    tooltip.style.left = Math.max(8, Math.min(event.clientX - parent.left + 16, parent.width - tooltip.offsetWidth - 8)) + 'px';
    tooltip.style.top = Math.max(8, Math.min(event.clientY - parent.top + 16, parent.height - tooltip.offsetHeight - 8)) + 'px';
  }
  zoomIn.addEventListener('click', () => changeZoom(zoom * 1.25));
  zoomOut.addEventListener('click', () => changeZoom(zoom / 1.25));
  reset.addEventListener('click', resetView);
  map.addEventListener('dblclick', resetView);
  map.addEventListener('wheel', event => {
    event.preventDefault();
    changeZoom(zoom * (event.deltaY < 0 ? 1.25 : 0.8), event.clientX, event.clientY);
  }, { passive: false });
  map.addEventListener('pointerdown', event => {
    if (event.button !== 0 || zoom <= 1) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY };
    map.setPointerCapture(event.pointerId);
    map.classList.add('map-dragging');
    tooltip.hidden = true;
    event.preventDefault();
  });
  map.addEventListener('pointermove', event => {
    if (drag) {
      if (event.pointerId !== drag.id) return;
      panX = drag.panX + event.clientX - drag.x;
      panY = drag.panY + event.clientY - drag.y;
      apply();
    } else showDriver(event);
  });
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    map.classList.remove('map-dragging');
  }
  map.addEventListener('pointerup', endDrag);
  map.addEventListener('pointercancel', endDrag);
  map.addEventListener('lostpointercapture', endDrag);
  map.addEventListener('pointerleave', () => { tooltip.hidden = true; });
  // The original layout divider can change the map's size without a window resize.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(apply).observe(map);
  }
  window.addEventListener('resize', apply);
  mapInteractionController = { reset: resetView };
  apply();
}
