/* UDP listener controls in the display header. */

let telemetryStatusInterval = null;
let telemetryStatusPending = false;

function initializeTelemetryControls() {
  const startButton = document.getElementById("udpStartBtn");
  const stopButton = document.getElementById("udpStopBtn");
  const portInput = document.getElementById("udpPortInput");

  if (!startButton || !stopButton || !portInput) return;

  const savedPort = localStorage.getItem("udpTelemetryPort");
  if (savedPort) portInput.value = savedPort;

  startButton.addEventListener("click", startUdpTelemetry);
  stopButton.addEventListener("click", stopUdpTelemetry);
  portInput.addEventListener("change", () => {
    localStorage.setItem("udpTelemetryPort", getUdpPort());
  });

  refreshTelemetryStatus();
  if (telemetryStatusInterval) clearInterval(telemetryStatusInterval);
  telemetryStatusInterval = setInterval(refreshTelemetryStatus, 2000);
}

function getUdpPort() {
  const portInput = document.getElementById("udpPortInput");
  const parsedPort = parseInt(portInput?.value, 10);
  if (Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535) {
    return String(parsedPort);
  }
  return "20777";
}

async function refreshTelemetryStatus(force = false) {
  if (telemetryStatusPending && !force) return;

  try {
    const status = await fetchJsonWithTimeout("/api/telemetry/status", 1500);
    updateTelemetryControls(status);
  } catch {
    updateTelemetryControls({
      running: false,
      active_drivers: 0,
      error: "Status unavailable"
    });
  }
}

async function startUdpTelemetry() {
  const port = getUdpPort();
  localStorage.setItem("udpTelemetryPort", port);
  setTelemetryPending("Starting");

  try {
    await fetchJsonWithTimeout(`/api/telemetry/start?port=${encodeURIComponent(port)}`, 3000, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    telemetryStatusPending = false;
    await refreshTelemetryStatus(true);
  } catch (error) {
    console.error("Error starting UDP telemetry:", error);
    updateTelemetryControls({
      running: false,
      active_drivers: 0,
      error: "Start failed"
    });
  } finally {
    telemetryStatusPending = false;
  }
}

async function stopUdpTelemetry() {
  setTelemetryPending("Stopping");

  try {
    await fetchJsonWithTimeout("/api/telemetry/stop", 3000, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    telemetryStatusPending = false;
    await refreshTelemetryStatus(true);
  } catch (error) {
    console.error("Error stopping UDP telemetry:", error);
    updateTelemetryControls({
      running: true,
      active_drivers: 0,
      error: "Stop failed"
    });
  } finally {
    telemetryStatusPending = false;
  }
}

function setTelemetryPending(label) {
  telemetryStatusPending = true;
  const panel = document.getElementById("udpPanel");
  const statusText = document.getElementById("udpStatusText");
  const startButton = document.getElementById("udpStartBtn");
  const stopButton = document.getElementById("udpStopBtn");
  const portInput = document.getElementById("udpPortInput");

  panel?.classList.remove("running");
  panel?.classList.add("pending");
  if (statusText) statusText.textContent = label;
  if (startButton) startButton.disabled = true;
  if (stopButton) stopButton.disabled = true;
  if (portInput) portInput.disabled = true;
}

function updateTelemetryControls(status) {
  const panel = document.getElementById("udpPanel");
  const statusText = document.getElementById("udpStatusText");
  const driverCount = document.getElementById("udpDriverCount");
  const startButton = document.getElementById("udpStartBtn");
  const stopButton = document.getElementById("udpStopBtn");
  const portInput = document.getElementById("udpPortInput");

  if (!panel || !statusText || !driverCount || !startButton || !stopButton || !portInput) return;

  const isRunning = status?.running === true;
  const activeDrivers = Number.isInteger(status?.active_drivers) ? status.active_drivers : 0;

  panel.classList.toggle("running", isRunning);
  panel.classList.remove("pending");
  statusText.textContent = status?.error ? status.error : (isRunning ? "UDP On" : "UDP Off");
  driverCount.textContent = `${activeDrivers} driver${activeDrivers === 1 ? "" : "s"}`;
  startButton.disabled = isRunning;
  stopButton.disabled = !isRunning;
  portInput.disabled = isRunning;

  if (status?.port) {
    portInput.value = status.port;
    localStorage.setItem("udpTelemetryPort", String(status.port));
  }
}
