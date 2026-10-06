const MOBILE_REFRESH_MS = 3000;

async function refreshMobileView() {
  try {
    const track = await fetchJsonWithTimeout('/api/track', 3000);
    currentTrack = (track.name || '').toLowerCase();
    document.getElementById('sessionTitle').textContent =
      TRACK_DISPLAY_NAMES[currentTrack] || track.name || 'No track selected';

    let records = [];
    if (currentTrack) {
      const data = await fetchJsonWithTimeout(
        '/api/track/records?track=' + encodeURIComponent(currentTrack), 3000
      );
      if (Array.isArray(data.lap_times)) records = data.lap_times;
    }
    updateLeaderboard(buildDriversFromRecords(records));
  } catch (e) {
    console.error('Error refreshing mobile view:', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  refreshMobileView();
  setInterval(refreshMobileView, MOBILE_REFRESH_MS);
});
