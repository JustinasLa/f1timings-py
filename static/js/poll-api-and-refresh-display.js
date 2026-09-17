/* Polling loop that fetches driver/lap data and live positions, then dispatches to the UI. */

// True while a loadDisplayData call is still waiting on the network. The poll
// runs every 100ms, so without this guard a slow fetch would let several calls
// stack up and their responses could arrive out of order and clobber the table.
let displayDataInFlight = false;

function startDataFetching() {
  if (fetchDataInterval) clearInterval(fetchDataInterval);
  loadDisplayData();
  fetchDataInterval = setInterval(loadDisplayData, FETCH_INTERVAL_MS);
}

async function loadDisplayData() {
  // Skip this tick if the previous one has not finished yet.
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

  // Refresh the top-right track-condition markers (track/air temp, time of day,
  // weather). This call throttles itself, so it is safe to fire every poll.
  updateTrackConditions();

  // The leaderboard shows the saved lap times for the selected track,
  // read from that track's file in the track_times directory. If no track
  // has been selected yet, there is nothing to show.
  if (!currentTrack) {
    updateLeaderboard({});
    updateFastestLapPill({});
    updatePoleLapCard([]);
    return;
  }

  try {
    // Track data and saved lap times are stored under the same country key the
    // dashboard uses, so the current track key is the file name directly.
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
