/* Column visibility settings for the "Stored Times" leaderboard. A gear button
   opens a panel of switches; turning a switch off hides that column on the left
   table. The choices are saved in the browser so they survive a page reload. */

// The columns that can be toggled. Each name matches three things: the
// data-column on its switch, the "col-<name>" class on the table cells, and the
// "hide-col-<name>" class we add to the table when the column should be hidden.
const COLUMN_SETTING_NAMES = ["pos", "topspeed", "bestlap", "potential", "sectors", "gap", "laps"];
const COLUMN_SETTING_STORAGE_KEY = "leaderboardColumns";

// Whether each column is currently shown. Everything starts shown except the
// "Potential" column (the best-possible lap from each driver's fastest sectors),
// which is an extra stat that is off by default and turned on from the gear menu.
// "pos" is the far-left position number; hiding it only removes the numbers and
// does not change how the rows are sorted.
let columnVisibility = {
  pos: true,
  topspeed: true,
  bestlap: true,
  potential: false,
  sectors: true,
  gap: true,
  laps: true
};

/* Read any saved choices from localStorage into columnVisibility. */
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
    // A bad or old saved value must not break the page; keep the defaults.
    console.error("Could not read column settings:", e);
  }
}

/* Save the current choices to localStorage. */
function saveColumnSettings() {
  try {
    localStorage.setItem(COLUMN_SETTING_STORAGE_KEY, JSON.stringify(columnVisibility));
  } catch (e) {
    console.error("Could not save column settings:", e);
  }
}

/* Add or remove the "hide-col-<name>" class on the table for each column, which
   shows or hides that column's cells. The table element itself is not rebuilt
   when the rows refresh, so these classes stay applied between refreshes. */
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

/* Make every switch in the panel match the current choices. */
function syncColumnSwitches() {
  const inputs = document.querySelectorAll("#columnSettingsMenu input[data-column]");
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const name = input.dataset.column;
    input.checked = columnVisibility[name] === true;
  }
}

/* Set up the gear button, the switches, and load/apply the saved choices. */
function initializeColumnSettings() {
  loadColumnSettings();
  applyColumnSettings();
  syncColumnSwitches();

  const toggle = document.getElementById("columnSettingsToggle");
  const menu = document.getElementById("columnSettingsMenu");
  if (!toggle || !menu) return;

  // Open or close the panel when the gear is clicked.
  toggle.onclick = function (event) {
    event.stopPropagation();
    const isOpen = menu.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  };

  // When a switch changes, update the choice, show/hide the column, and save.
  const inputs = menu.querySelectorAll("input[data-column]");
  for (let i = 0; i < inputs.length; i++) {
    inputs[i].onchange = function (event) {
      const name = event.target.dataset.column;
      columnVisibility[name] = event.target.checked;
      applyColumnSettings();
      saveColumnSettings();
      // Move the divider so the left pane fits the new set of visible columns.
      if (typeof autoFitLayoutToColumns === "function") {
        autoFitLayoutToColumns();
      }
    };
  }

  // Close the panel when clicking anywhere outside it.
  document.addEventListener("click", function (event) {
    if (!menu.contains(event.target) && event.target !== toggle) {
      menu.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
  });
}
