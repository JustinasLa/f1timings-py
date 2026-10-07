let displayDataInFlight = false;
let displayDataPending = false;
let liveDriversInFlight = false;
let lastRecordsFetchAt = 0;
let lastLivePollOkAt = Date.now();

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

async function refreshDisplayData() {
  if (!currentTrack) {
    updateLeaderboard({});
    updateFastestLapPill({});
    updatePoleLapCard([]);
    return;
  }

  try {
    const url = "/api/track/records?track=" + encodeURIComponent(currentTrack);
    const response = await fetchJsonWithTimeout(url, 1500);
    const records = Array.isArray(response.lap_times) ? response.lap_times : [];
    updateEventDateOptions(records);
    const drivers = buildDriversFromRecords(filterRecordsByEventDate(records));
    updateLeaderboard(drivers);
    updateFastestLapPill(drivers);
    updatePoleLapCard(records);
  } catch (e) { console.error("Error loading display data:", e); }
}

async function loadLiveDriverPositions() {
  if (liveDriversInFlight) return;
  liveDriversInFlight = true;
  try {
    const liveDrivers = await fetchJsonWithTimeout("/api/drivers/live", 1500);
    lastLivePollOkAt = Date.now();
    latestLiveDrivers = liveDrivers;
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
    if (trackData) redrawCompleteTrack();
  } finally {
    liveDriversInFlight = false;
  }
}
