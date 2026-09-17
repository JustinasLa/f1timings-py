/* Bootstrap: wire up the canvas and start all subsystems once the DOM is ready. */

document.addEventListener("DOMContentLoaded", () => {
  canvas = document.getElementById("trackCanvas");
  // Guard against a missing canvas so one missing element can't throw and stop
  // the rest of the dashboard (websocket, polling, controls) from starting.
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
