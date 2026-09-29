document.addEventListener("DOMContentLoaded", () => {
  canvas = document.getElementById("trackCanvas");
  if (canvas) {
    ctx = canvas.getContext("2d");
  }
  initializeColumnSettings();
  initializeLayoutDivider();
  initializeWebSocket();
  loadCurrentTrack();
  loadTrackSelectOptions();
  loadDriverAliases();
  initializeTelemetryControls();
  startDataFetching();
});
