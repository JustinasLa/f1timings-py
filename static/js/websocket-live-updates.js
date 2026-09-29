function initializeWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/ws`);
  socket.onopen = () => {
    console.log('WS connected');
    loadDisplayData();
  };
  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'laptime_update') {
        if (msg.data) {
          showLapToast(msg.data);
        }
        loadDisplayData();
      }
      if (msg.type === 'track_update' && msg.data?.name) {
        const newTrack = msg.data.name.toLowerCase();
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
