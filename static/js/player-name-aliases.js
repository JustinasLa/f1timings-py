const driverAliasDrafts = new Map();

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

  for (const input of list.querySelectorAll('.driver-alias-input')) {
    if (input.value !== input.dataset.savedValue) {
      driverAliasDrafts.set(normalizeAliasKey(input.dataset.telemetryName), input.value);
    } else {
      driverAliasDrafts.delete(normalizeAliasKey(input.dataset.telemetryName));
    }
  }
  // Keep the focused row, including its Save button, stable during live polling.
  if (list.contains(document.activeElement)) return;

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
      displayName: driverAliasDrafts.has(key) ? driverAliasDrafts.get(key) :
        driverAliases[key] || driver.name || telemetryName,
      savedName: driverAliases[key] || driver.name || telemetryName,
      instanceIndex: driver.instance_index
    });
  }

  if (telemetryNames.length === 0) {
    const waiting = '<div class="driver-alias-empty">Waiting for live drivers...</div>';
    if (list.dataset.aliasMarkup !== waiting) {
      list.innerHTML = waiting;
      list.dataset.aliasMarkup = waiting;
    }
    return;
  }

  const markup = telemetryNames.map((item) => {
    const instanceIndex = Number(item.instanceIndex);
    const colorIndex = Number.isInteger(instanceIndex) ? instanceIndex % INSTANCE_COLORS.length : 0;
    const color = INSTANCE_COLORS[colorIndex] || TEAM_COLORS.DEFAULT;
    return `
      <div class="driver-alias-row">
        <span class="driver-alias-dot" style="background:${color}"></span>
        <span class="driver-alias-raw">${escapeHtml(item.telemetryName)}</span>
        <input class="driver-alias-input" data-telemetry-name="${escapeAttr(item.telemetryName)}" data-saved-value="${escapeAttr(item.savedName)}" value="${escapeAttr(item.displayName)}" placeholder="Player name">
        <button class="driver-alias-save" data-telemetry-name="${escapeAttr(item.telemetryName)}">Save</button>
      </div>
    `;
  }).join('');
  if (list.dataset.aliasMarkup !== markup) {
    list.innerHTML = markup;
    list.dataset.aliasMarkup = markup;
  }
}

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

  const draft = input.value;
  const displayName = draft.trim();
  const key = normalizeAliasKey(telemetryName);
  driverAliasDrafts.set(key, draft);
  try {
    driverAliases = await fetchJsonWithTimeout("/api/telemetry/driver_alias", 1500, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telemetry_name: telemetryName, display_name: displayName })
    });
    if (input.value === draft) {
      driverAliasDrafts.delete(key);
      input.value = displayName || telemetryName;
      input.dataset.savedValue = input.value;
    }
    loadLiveDriverPositions();

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
