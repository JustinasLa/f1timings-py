let displayDataInFlight = false;
let displayDataPending = false;
let liveDriversInFlight = false;
let lastRecordsFetchAt = 0;
let lastLivePollOkAt = Date.now();
let displayedRecordsTrack = null;

function startDataFetching() {
  if (fetchDataInterval) clearInterval(fetchDataInterval);
  loadDisplayData();
  loadLiveDriverPositions();
  fetchDataInterval = setInterval(pollDisplayData, FETCH_INTERVAL_MS);
}

function updateConnectionBanner() {
  const banner = document.getElementById("connectionBanner");
  if (banner) banner.hidden = Date.now() - lastLivePollOkAt <= CONNECTION_STALE_MS;
}

function pollDisplayData() {
  updateConnectionBanner();
  loadLiveDriverPositions();
  if (typeof retryTrackVisualization === 'function') retryTrackVisualization();
  updateTrackConditions();
  if (Date.now() - lastRecordsFetchAt >= RECORDS_REFRESH_INTERVAL_MS) loadDisplayData();
}

async function loadDisplayData() {
  ensureDisplayedTrack();
  if (displayDataInFlight) {
    displayDataPending = true;
    return;
  }
  displayDataInFlight = true;
  lastRecordsFetchAt = Date.now();
  try {
    await refreshDisplayData();
  } finally {
    displayDataInFlight = false;
  }
  if (displayDataPending) {
    displayDataPending = false;
    loadDisplayData();
  }
}

function ensureDisplayedTrack() {
  if (displayedRecordsTrack !== null && displayedRecordsTrack !== currentTrack) {
    updateLeaderboard({});
    updateFastestLapPill({});
    updatePoleLapCard([]);
  }
  displayedRecordsTrack = currentTrack;
}

async function refreshDisplayData() {
  const requestedTrack = currentTrack;
  ensureDisplayedTrack();
  if (!currentTrack) {
    updateLeaderboard({});
    updateFastestLapPill({});
    updatePoleLapCard([]);
    return;
  }

  try {
    const url = "/api/track/records?track=" + encodeURIComponent(requestedTrack);
    const response = await fetchJsonWithTimeout(url, 1500);
    if (requestedTrack !== currentTrack) return;
    const records = Array.isArray(response?.lap_times) ? response.lap_times.filter(isUsableLapRecord) : [];
    updateEventDateOptions(records);
    const drivers = buildDriversFromRecords(filterRecordsByEventDate(records));
    updateLeaderboard(drivers);
    updateFastestLapPill(drivers);
    updatePoleLapCard(records);
  } catch (e) {
    if (requestedTrack === currentTrack) console.error("Error loading display data:", e);
  }
}

function isUsableLapRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record)
    && (typeof record.time === 'string' || typeof record.time === 'number')
    && Number.isFinite(parseTimeToSeconds(record.time)) && parseTimeToSeconds(record.time) > 0
    && (record.driver === undefined || typeof record.driver === 'string');
}

async function loadLiveDriverPositions() {
  if (liveDriversInFlight) return;
  liveDriversInFlight = true;
  try {
    const liveDrivers = await fetchJsonWithTimeout("/api/drivers/live", 1500);
    lastLivePollOkAt = Date.now();
    latestLiveDrivers = liveDrivers;
    if (typeof refreshMapDriverTooltip === 'function') refreshMapDriverTooltip();
    updateDriverAliasPanel(liveDrivers);
    const withPos = Object.entries(liveDrivers).filter(([, d]) =>
      hasLivePosition(d)
    );
    if (withPos.length > 0 && trackData) {
      drawDriversOnTrack(liveDrivers);
    } else if (trackData) {
      redrawCompleteTrack();
    }
  } catch {
    const tooltip = document.getElementById('mapDriverTooltip');
    if (tooltip) tooltip.hidden = true;
    if (trackData) redrawCompleteTrack();
  } finally {
    liveDriversInFlight = false;
  }
}
