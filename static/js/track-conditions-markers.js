/* Live track-condition markers (track temp, air temp). Fetches the session
   conditions from the telemetry API and writes them into the markers pinned to
   the top-right of the map. The markers stay hidden until a session packet has
   arrived. */

// The conditions change slowly, so we do not need to fetch them on every 100ms
// poll. We remember when we last fetched and only fetch again after this gap.
let lastConditionsFetchTime = 0;
const CONDITIONS_FETCH_GAP_MS = 1000;

/* Format a whole-degree Celsius temperature, e.g. 42 -> "42°C". */
function formatTemperature(degreesCelsius) {
  if (degreesCelsius === null || degreesCelsius === undefined) {
    return "--°C";
  }
  return Math.round(degreesCelsius) + "°C";
}

/* Fetch the latest session conditions and update the markers. Throttled so it
   only actually fetches once per CONDITIONS_FETCH_GAP_MS. */
async function updateTrackConditions() {
  const now = Date.now();
  if (now - lastConditionsFetchTime < CONDITIONS_FETCH_GAP_MS) {
    return;
  }
  lastConditionsFetchTime = now;

  const container = document.getElementById("mapConditions");
  if (!container) {
    return;
  }

  try {
    const conditions = await fetchJsonWithTimeout("/api/telemetry/session", 1500);

    // Until a session packet has arrived there is nothing to show, so keep the
    // whole marker row hidden.
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
    // A failed fetch (e.g. listener not running) just leaves the markers as they
    // are; we do not hide them on a transient error.
    console.error("Error loading track conditions:", e);
  }
}
