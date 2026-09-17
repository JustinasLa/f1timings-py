/* WebSocket connection: live lap-time and track-change push updates. */

function initializeWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/ws`);
  socket.onopen = () => console.log('WS connected');
  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'laptime_update') {
        // Pop a toast for meaningful laps (fastest / personal best), then
        // refresh the leaderboard from the saved records.
        if (msg.data) {
          showLapToast(msg.data);
        }
        loadDisplayData();
      }
      if (msg.type === 'track_update' && msg.data?.name) {
        const newTrack = msg.data.name.toLowerCase();
        // Ignore an update for the track we are already showing so we don't do a
        // redundant full reload (e.g. when this same client just set the track).
        if (newTrack !== currentTrack) {
          currentTrack = newTrack;
          updateTrackUI();
          updateTrackSelectValue();
          loadTrackVisualization(currentTrack);
          loadDisplayData();
        }
      }
      if (msg.type === 'telemetry_update') {
        refreshTelemetryStatus();
      }
    } catch {}
  };
  socket.onclose = () => setTimeout(initializeWebSocket, 2000);
  socket.onerror = () => socket.close();
}
