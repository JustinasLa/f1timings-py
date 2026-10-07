let lastConditionsFetchTime = 0;
const CONDITIONS_FETCH_GAP_MS = 1000;
let conditionsInFlight = false;

function formatTemperature(degreesCelsius) {
  if (degreesCelsius === null || degreesCelsius === undefined) {
    return "--°C";
  }
  return Math.round(degreesCelsius) + "°C";
}

async function updateTrackConditions() {
  const now = Date.now();
  if (conditionsInFlight || now - lastConditionsFetchTime < CONDITIONS_FETCH_GAP_MS) {
    return;
  }
  lastConditionsFetchTime = now;

  const container = document.getElementById("mapConditions");
  if (!container) {
    return;
  }

  conditionsInFlight = true;
  const requestedTrack = currentTrack;
  try {
    const conditions = await fetchJsonWithTimeout("/api/telemetry/session", 1500);
    if (requestedTrack !== currentTrack) return;

    if (!conditions || !conditions.available) {
      container.style.display = "none";
      return;
    }

    container.style.display = "flex";

    const trackTempEl = document.getElementById("conditionTrackTemp");
    const airTempEl = document.getElementById("conditionAirTemp");

    if (trackTempEl) {
      trackTempEl.textContent = formatTemperature(conditions.trackTemperature);
    }
    if (airTempEl) {
      airTempEl.textContent = formatTemperature(conditions.airTemperature);
    }
  } catch (e) {
    if (requestedTrack === currentTrack) {
      container.style.display = 'none';
      console.error("Error loading track conditions:", e);
    }
  } finally {
    conditionsInFlight = false;
  }
}
