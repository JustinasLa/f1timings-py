let displayDataInFlight = false;

function startDataFetching() {
  if (fetchDataInterval) clearInterval(fetchDataInterval);
  loadDisplayData();
  fetchDataInterval = setInterval(loadDisplayData, FETCH_INTERVAL_MS);
}

async function loadDisplayData() {
  if (displayDataInFlight) return;
  displayDataInFlight = true;
  try {
    await refreshDisplayData();
  } finally {
    displayDataInFlight = false;
  }
}

async function refreshDisplayData() {
  loadLiveDriverPositions();

  updateTrackConditions();

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
    const drivers = buildDriversFromRecords(records);
    updateLeaderboard(drivers);
    updateFastestLapPill(drivers);
    updatePoleLapCard(records);
  } catch (e) { console.error("Error loading display data:", e); }
}

async function loadLiveDriverPositions() {
  try {
    const liveDrivers = await fetchJsonWithTimeout("/api/drivers/live", 1500);
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
  }
}
