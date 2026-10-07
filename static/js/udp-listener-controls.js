let telemetryStatusInterval = null;
let telemetryStatusPending = false;

function initializeTelemetryControls() {
  const startButton = document.getElementById("udpStartBtn");
  const stopButton = document.getElementById("udpStopBtn");
  const portInput = document.getElementById("udpPortInput");

  if (!startButton || !stopButton || !portInput) return;

  const savedPort = readStoredValue("udpTelemetryPort");
  if (savedPort) portInput.value = savedPort;

  startButton.addEventListener("click", startUdpTelemetry);
  stopButton.addEventListener("click", stopUdpTelemetry);
  portInput.addEventListener("input", updateTelemetryPortValidation);
  portInput.addEventListener("change", () => {
    updateTelemetryPortValidation();
    const port = getUdpPort();
    if (port) writeStoredValue("udpTelemetryPort", port);
  });
  updateTelemetryPortValidation();

  refreshTelemetryStatus();
  if (telemetryStatusInterval) clearInterval(telemetryStatusInterval);
  telemetryStatusInterval = setInterval(refreshTelemetryStatus, 2000);
}

function getUdpPort() {
  const portInput = document.getElementById("udpPortInput");
  const parsedPort = Number(portInput?.value);
  if (Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535) {
    return String(parsedPort);
  }
  return null;
}

function updateTelemetryPortValidation() {
  const input = document.getElementById('udpPortInput');
  const start = document.getElementById('udpStartBtn');
  const panel = document.getElementById('udpPanel');
  const status = document.getElementById('udpStatusText');
  if (!input || !start || !panel || !status) return;
  const valid = getUdpPort() !== null;
  const message = 'Enter a port from 1024 to 65535';
  input.setCustomValidity(valid ? '' : message);
  input.setAttribute('aria-invalid', String(!valid));
  start.disabled = !valid || telemetryStatusPending || panel.classList.contains('running');
  if (!telemetryStatusPending && !panel.classList.contains('running')) {
    if (!valid) status.textContent = message;
    else if (status.textContent === message) status.textContent = 'UDP Off';
  }
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
  if (!port) {
    updateTelemetryPortValidation();
    return;
  }
  writeStoredValue("udpTelemetryPort", port);
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
    updateTelemetryPortValidation();
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
    updateTelemetryPortValidation();
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
    writeStoredValue("udpTelemetryPort", String(status.port));
  }
  updateTelemetryPortValidation();
}
