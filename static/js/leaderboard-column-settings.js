const COLUMN_SETTING_NAMES = ["pos", "topspeed", "bestlap", "potential", "sectors", "gap", "laps"];
const COLUMN_SETTING_STORAGE_KEY = "leaderboardColumns";

let columnVisibility = {
  pos: true,
  topspeed: true,
  bestlap: true,
  potential: false,
  sectors: true,
  gap: true,
  laps: true
};

function loadColumnSettings() {
  try {
    const saved = localStorage.getItem(COLUMN_SETTING_STORAGE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved);
    for (let i = 0; i < COLUMN_SETTING_NAMES.length; i++) {
      const name = COLUMN_SETTING_NAMES[i];
      if (typeof parsed[name] === "boolean") {
        columnVisibility[name] = parsed[name];
      }
    }
  } catch (e) {
    console.error("Could not read column settings:", e);
  }
}

function saveColumnSettings() {
  try {
    localStorage.setItem(COLUMN_SETTING_STORAGE_KEY, JSON.stringify(columnVisibility));
  } catch (e) {
    console.error("Could not save column settings:", e);
  }
}

function applyColumnSettings() {
  const table = document.querySelector(".timing-table");
  if (!table) return;
  for (let i = 0; i < COLUMN_SETTING_NAMES.length; i++) {
    const name = COLUMN_SETTING_NAMES[i];
    if (columnVisibility[name]) {
      table.classList.remove("hide-col-" + name);
    } else {
      table.classList.add("hide-col-" + name);
    }
  }
}

function syncColumnSwitches() {
  const inputs = document.querySelectorAll("#columnSettingsMenu input[data-column]");
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const name = input.dataset.column;
    input.checked = columnVisibility[name] === true;
  }
}

function initializeColumnSettings() {
  loadColumnSettings();
  applyColumnSettings();
  syncColumnSwitches();

  const toggle = document.getElementById("columnSettingsToggle");
  const menu = document.getElementById("columnSettingsMenu");
  if (!toggle || !menu) return;

  toggle.onclick = function (event) {
    event.stopPropagation();
    const isOpen = menu.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  };

  const inputs = menu.querySelectorAll("input[data-column]");
  for (let i = 0; i < inputs.length; i++) {
    inputs[i].onchange = function (event) {
      const name = event.target.dataset.column;
      columnVisibility[name] = event.target.checked;
      applyColumnSettings();
      saveColumnSettings();
      if (typeof autoFitLayoutToColumns === "function") {
        autoFitLayoutToColumns();
      }
    };
  }

  document.addEventListener("click", function (event) {
    if (!menu.contains(event.target) && event.target !== toggle) {
      menu.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
  });
}
