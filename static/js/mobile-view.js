const MOBILE_REFRESH_MS = 3000;
let mobileRefreshInFlight = false;

async function refreshMobileView() {
  if (mobileRefreshInFlight) return;
  mobileRefreshInFlight = true;
  try {
    const track = await fetchJsonWithTimeout('/api/track', 3000);
    const trackKey = (track.name || '').toLowerCase();

    let records = [];
    if (trackKey) {
      const data = await fetchJsonWithTimeout(
        '/api/track/records?track=' + encodeURIComponent(trackKey), 3000
      );
      if (Array.isArray(data.lap_times)) records = data.lap_times;
    }

    // Title and rows change together, only once both requests succeeded.
    currentTrack = trackKey;
    document.getElementById('sessionTitle').textContent =
      TRACK_DISPLAY_NAMES[currentTrack] || track.name || 'No track selected';
    updateLeaderboard(buildDriversFromRecords(records));
  } catch (e) {
    console.error('Error refreshing mobile view:', e);
  } finally {
    mobileRefreshInFlight = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  refreshMobileView();
  setInterval(refreshMobileView, MOBILE_REFRESH_MS);
});
