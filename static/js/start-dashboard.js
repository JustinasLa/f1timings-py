document.addEventListener("DOMContentLoaded", () => {
  const steps = [
    () => {
      canvas = document.getElementById("trackCanvas");
      if (canvas) {
        ctx = canvas.getContext("2d");
      }
    },
    () => initializeColumnSettings(),
    () => initializeEventDateFilter(),
    () => initializeLayoutDivider(),
    () => initializeKioskMode(),
    () => initializeWebSocket(),
    () => loadCurrentTrack(),
    () => loadTrackSelectOptions(),
    () => loadDriverAliases(),
    () => initializeTelemetryControls(),
    () => startDataFetching()
  ];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      console.error("Dashboard init step failed:", error);
    }
  }
});
