/* "Player Names" panel: mapping raw telemetry names to display names. */

async function loadDriverAliases() {
  try {
    driverAliases = await fetchJsonWithTimeout("/api/telemetry/driver_aliases", 1500);
  } catch {
    driverAliases = {};
  }
  updateDriverAliasPanel(latestLiveDrivers);
}

function updateDriverAliasPanel(liveDrivers) {
  const list = document.getElementById("driverAliasList");
  if (!list) return;
  bindDriverAliasClicks(list);

  if (list.querySelector(".driver-alias-input:focus")) return;

  const drivers = Object.values(liveDrivers || {});
  const telemetryNames = [];
  const seen = new Set();
  for (const driver of drivers) {
    const telemetryName = driver.telemetry_name || driver.name;
    const key = normalizeAliasKey(telemetryName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    telemetryNames.push({
      telemetryName,
      displayName: driverAliases[key] || driver.name || telemetryName,
      instanceIndex: driver.instance_index
    });
  }

  if (telemetryNames.length === 0) {
    list.innerHTML = '<div class="driver-alias-empty">Waiting for live drivers...</div>';
    return;
  }

  list.innerHTML = telemetryNames.map((item) => {
    const instanceIndex = Number(item.instanceIndex);
    const colorIndex = Number.isInteger(instanceIndex) ? instanceIndex % INSTANCE_COLORS.length : 0;
    const color = INSTANCE_COLORS[colorIndex] || TEAM_COLORS.DEFAULT;
    return `
      <div class="driver-alias-row">
        <span class="driver-alias-dot" style="background:${color}"></span>
        <span class="driver-alias-raw">${escapeHtml(item.telemetryName)}</span>
        <input class="driver-alias-input" data-telemetry-name="${escapeAttr(item.telemetryName)}" value="${escapeAttr(item.displayName)}" placeholder="Player name">
        <button class="driver-alias-save" data-telemetry-name="${escapeAttr(item.telemetryName)}">Save</button>
      </div>
    `;
  }).join('');
}

/* One delegated handler for the Save buttons. The panel is re-rendered with
   innerHTML on every update, so the listener lives on the list and is bound
   once. mousedown is prevented so clicking Save does not blur the input first. */
function bindDriverAliasClicks(list) {
  if (list.dataset.clicksBound === '1') return;
  list.dataset.clicksBound = '1';
  list.addEventListener('mousedown', (event) => {
    if (event.target.closest('.driver-alias-save')) event.preventDefault();
  });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('.driver-alias-save');
    if (button) saveDriverAlias(button.dataset.telemetryName);
  });
}

async function saveDriverAlias(telemetryName) {
  const input = Array.from(document.querySelectorAll(".driver-alias-input"))
    .find((el) => el.dataset.telemetryName === telemetryName);
  if (!input) return;

  const displayName = input.value.trim();
  try {
    driverAliases = await fetchJsonWithTimeout("/api/telemetry/driver_alias", 1500, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telemetry_name: telemetryName, display_name: displayName })
    });
    loadLiveDriverPositions();

    // Confirm the change so the operator knows it was applied.
    if (displayName) {
      showInfoToast("Player name set", telemetryName + " → " + displayName, false);
    } else {
      showInfoToast("Player name cleared", "Now using " + telemetryName, false);
    }
  } catch (e) {
    console.error("Error saving driver alias:", e);
    showInfoToast("Could not save name", "Try again for " + telemetryName, true);
  }
}

function normalizeAliasKey(name) {
  return String(name || '').trim().toLowerCase();
}
