/* "Stored Times" leaderboard table and the fastest-lap header pill. */

let lastLeaderboardRowsHtml = null;

// The best (fastest) time for each sector, used to colour the sector boxes.
// "personal" is keyed by driver name; "overall" is the best of anyone. A value
// of 0 means that sector has not been set by anyone yet. Both are recomputed
// each time the leaderboard is rendered (see updateLeaderboard).
let leaderboardPersonalBestSectors = {};
let leaderboardOverallBestSectors = { s1: 0, s2: 0, s3: 0 };

// The live, in-progress sectors for any driver who is currently on a flying lap,
// keyed by driver name. Rebuilt from the live feed each time the leaderboard is
// rendered (see updateLeaderboard). When a driver has an entry here, their row
// shows these live sectors instead of their stored fastest-lap sectors, so you
// can watch the pace build up: S1 fills in first, then S2, while the box for a
// sector they have not reached yet stays blank.
let leaderboardLiveLapSectors = {};

/* Format a top-speed value for display. Returns a dash only when the value is
   genuinely missing (null/undefined), so a real reading of 0 km/h still shows
   instead of being treated as "no data". */
function formatTopSpeed(speedKph) {
  if (speedKph === null || speedKph === undefined) {
    return '—';
  }
  // Show as a full number. Math.round also tidies any older records that were
  // saved with a decimal before we switched to whole numbers.
  return Math.round(speedKph) + ' km/h';
}

/* Work out a driver's "potential" lap: the fastest lap they could in theory set
   by stitching together their personal-best S1, S2 and S3. We only show a value
   when all three sectors have been set, otherwise there is no complete lap to
   build and we show a dash. Returns a formatted lap time like "1:31.250". */
function formatPotentialTime(driver) {
  let best = driver.best_sectors;
  if (!best) {
    return '—';
  }

  // All three sectors must be set (> 0) to build a complete potential lap.
  const haveAllSectors = best.s1 > 0 && best.s2 > 0 && best.s3 > 0;
  if (!haveAllSectors) {
    return '—';
  }

  const totalMs = best.s1 + best.s2 + best.s3;
  const totalSeconds = totalMs / 1000;
  return formatSeconds(totalSeconds);
}

/* Format one sector time (milliseconds) as seconds like "31.500", or a dash
   when the value is missing or zero (e.g. an older lap saved before we recorded
   sectors, or a sector we never captured). */
function formatLeaderboardSectorMs(milliseconds) {
  if (milliseconds === null || milliseconds === undefined || milliseconds <= 0) {
    return '—';
  }
  return (milliseconds / 1000).toFixed(3);
}

/* Return the smaller of two sector times in milliseconds, treating 0 (or a
   missing value) as "not set" so it never wins. Returns 0 when neither is set. */
function minSector(a, b) {
  const aSet = a && a > 0;
  const bSet = b && b > 0;
  if (!aSet && !bSet) {
    return 0;
  }
  if (!aSet) {
    return b;
  }
  if (!bSet) {
    return a;
  }
  if (a < b) {
    return a;
  }
  return b;
}

/* Work out which STORED sector times to show for a driver in the left-hand
   table. This is the fallback used whenever the driver is not on a flying lap
   (drivers who are show their live sectors instead, see buildSectorBoxesHtml),
   so the table keeps showing each driver's fastest-lap sectors the rest of the
   time, including straight after a hard refresh.

   We prefer the fastest lap's own sectors. If that lap is missing a sector (for
   example an older lap saved before we captured sectors), we fall back to the
   driver's best recorded value for that sector, so a box is never left empty
   while the driver has any sector data at all. */
function getDisplaySectors(driver, lap) {
  let best = driver.best_sectors;
  if (!best) {
    best = { s1: 0, s2: 0, s3: 0 };
  }

  let s1 = lap.sector_1_ms;
  if (!s1 || s1 <= 0) {
    s1 = best.s1;
  }
  let s2 = lap.sector_2_ms;
  if (!s2 || s2 <= 0) {
    s2 = best.s2;
  }
  let s3 = lap.sector_3_ms;
  if (!s3 || s3 <= 0) {
    s3 = best.s3;
  }

  return { s1: s1, s2: s2, s3: s3, isValid: lap.is_valid !== false };
}

/* Pick the colour class for one sector box:
   - invalid lap  -> red (every sector)
   - overall best -> purple
   - personal best-> green (also when the driver has no recorded best for this
                    sector yet, since this value is then their best by default)
   - otherwise    -> yellow
   - no time yet  -> plain (dash) */
function sectorColorClass(valueMs, personalBestMs, overallBestMs, isValid) {
  if (!isValid) {
    return 'sector-invalid';
  }
  if (!valueMs || valueMs <= 0) {
    return 'sector-none';
  }
  if (overallBestMs > 0 && valueMs <= overallBestMs) {
    return 'sector-purple';
  }
  // Green when it matches the driver's own best, or when they have no recorded
  // best for this sector yet (a first/only sector is their best by definition).
  if (personalBestMs <= 0 || valueMs <= personalBestMs) {
    return 'sector-green';
  }
  return 'sector-yellow';
}

/* Build the HTML for one sector box (the coloured number for S1, S2 or S3). */
function buildOneSectorBox(valueMs, personalBestMs, overallBestMs, isValid) {
  const text = formatLeaderboardSectorMs(valueMs);
  const colorClass = sectorColorClass(valueMs, personalBestMs, overallBestMs, isValid);
  return '<span class="sector-box ' + colorClass + '">' + text + '</span>';
}

/* Build the lookup of live, in-progress sectors keyed by driver name, from the
   latest live feed. Only drivers who are actively on a flying lap (live_lap_active)
   are included; everyone else keeps showing their stored fastest-lap sectors. */
function buildLeaderboardLiveLapSectors() {
  const liveLapSectors = {};
  for (const driverKey in latestLiveDrivers) {
    const liveDriver = latestLiveDrivers[driverKey];
    if (!liveDriver || liveDriver.live_lap_active !== true) {
      continue;
    }
    liveLapSectors[liveDriver.name] = {
      s1: liveDriver.live_sector_1_ms || 0,
      s2: liveDriver.live_sector_2_ms || 0,
      s3: liveDriver.live_sector_3_ms || 0,
      isValid: liveDriver.live_lap_invalid !== true
    };
  }
  return liveLapSectors;
}

/* Return a copy of the stored drivers with an extra placeholder entry for any
   driver who is on a live lap right now but has no stored lap time yet (for
   example, a player who was just renamed mid-session). The placeholder has no
   time, so the rest of the row shows dashes, but it lets their live sectors
   appear on the left instead of the driver being missing entirely. */
function addLiveOnlyDrivers(drivers) {
  const mergedDrivers = {};

  // Copy the stored drivers first.
  for (const driverName in drivers) {
    mergedDrivers[driverName] = drivers[driverName];
  }

  // Add a placeholder for each live, on-a-lap driver we do not already have.
  for (const driverKey in latestLiveDrivers) {
    const liveDriver = latestLiveDrivers[driverKey];
    if (!liveDriver || liveDriver.live_lap_active !== true) {
      continue;
    }
    const driverName = liveDriver.name;
    if (!driverName || mergedDrivers[driverName]) {
      continue;
    }

    const placeholderLap = {
      time: '',
      is_fastest: false,
      is_valid: true,
      fastest_speed_kph: null,
      sector_1_ms: null,
      sector_2_ms: null,
      sector_3_ms: null
    };
    mergedDrivers[driverName] = {
      name: driverName,
      team: liveDriver.team || 'Unknown Team',
      lap_times: [placeholderLap],
      all_laps: [],
      recent_laps: [],
      lap_count: 0,
      best_sectors: { s1: 0, s2: 0, s3: 0 },
      is_live_only: true
    };
  }

  return mergedDrivers;
}

/* Build the three coloured sector boxes for a leaderboard row. */
function buildSectorBoxesHtml(driver, lap) {
  // While a driver is on a flying lap, show their live sectors (S1, then S2,
  // with the not-yet-reached boxes left blank) instead of their stored
  // fastest-lap sectors, so the table reflects the pace they are on right now.
  let display = leaderboardLiveLapSectors[driver.name];
  if (!display) {
    display = getDisplaySectors(driver, lap);
  }

  let personalBest = leaderboardPersonalBestSectors[driver.name];
  if (!personalBest) {
    personalBest = { s1: 0, s2: 0, s3: 0 };
  }
  const overallBest = leaderboardOverallBestSectors;

  let boxes = '';
  boxes += buildOneSectorBox(display.s1, personalBest.s1, overallBest.s1, display.isValid);
  boxes += buildOneSectorBox(display.s2, personalBest.s2, overallBest.s2, display.isValid);
  boxes += buildOneSectorBox(display.s3, personalBest.s3, overallBest.s3, display.isValid);
  return '<div class="sector-box-row">' + boxes + '</div>';
}

/* Recompute the personal-best (per driver) and overall-best sector times used to
   colour the sector boxes, from each driver's stored laps. A sector box is
   coloured green when it matches the driver's own best, and purple when it is the
   best of anyone. */
function recomputeBestSectors(rows) {
  leaderboardPersonalBestSectors = {};
  leaderboardOverallBestSectors = { s1: 0, s2: 0, s3: 0 };

  for (let i = 0; i < rows.length; i++) {
    const driver = rows[i].driver;

    // This driver's best sectors found in their stored laps.
    let recordBest = driver.best_sectors;
    if (!recordBest) {
      recordBest = { s1: 0, s2: 0, s3: 0 };
    }
    const personalBest = { s1: recordBest.s1, s2: recordBest.s2, s3: recordBest.s3 };

    leaderboardPersonalBestSectors[driver.name] = personalBest;
    leaderboardOverallBestSectors.s1 = minSector(leaderboardOverallBestSectors.s1, personalBest.s1);
    leaderboardOverallBestSectors.s2 = minSector(leaderboardOverallBestSectors.s2, personalBest.s2);
    leaderboardOverallBestSectors.s3 = minSector(leaderboardOverallBestSectors.s3, personalBest.s3);
  }
}

/* Decide if "candidate" is a better lap to show than "current". A valid lap
   always beats an invalid lap. If both have the same validity, the faster
   time wins. */
function isBetterLap(candidate, current) {
  if (candidate.is_valid !== current.is_valid) {
    // The valid one is better.
    return current.is_valid === false;
  }
  return parseTimeToSeconds(candidate.time) < parseTimeToSeconds(current.time);
}

/* Pick the colour for the dot next to a driver's name. The team name says
   which simulator the lap came from (for example "nhlstendensim" is blue and
   "nhlstendensim2" is orange, set in TEAM_COLORS). */
function getDriverDotColor(driver) {
  return Object.prototype.hasOwnProperty.call(TEAM_COLORS, driver.team)
    ? TEAM_COLORS[driver.team]
    : TEAM_COLORS['DEFAULT'];
}

/* Build the leaderboard "drivers" object from saved track_times records.
   Each record is one saved lap: { driver, team, time, time_seconds, ... }.
   We group the records by driver name and mark the single fastest lap so the
   table and the header pill can highlight it. */
function buildDriversFromRecords(records) {
  const drivers = {};

  // Step 1: keep only the fastest lap for each driver. If a driver set more
  // than one lap (for example Marc Oldenburger set two), we replace their lap
  // whenever we find a quicker one, so each driver ends up with a single time.
  for (const record of records) {
    // The pole / track-record reference lap is shown on the map instead of in
    // this leaderboard, so leave it out here.
    if (record.is_pole_reference === true) {
      continue;
    }

    const driverName = record.driver || 'Unknown';
    const recordSeconds = parseTimeToSeconds(record.time);

    const lap = {
      time: record.time,
      is_fastest: false,
      is_valid: record.is_valid !== false,
      fastest_speed_kph: record.fastest_speed_kph,
      sector_1_ms: record.sector_1_ms,
      sector_2_ms: record.sector_2_ms,
      sector_3_ms: record.sector_3_ms
    };

    // We also keep every lap (valid or invalid) so a row can be expanded to
    // show the driver's recent laps with the same columns as the main row.
    const lapDetail = {
      time: record.time,
      is_valid: record.is_valid !== false,
      fastest_speed_kph: record.fastest_speed_kph,
      recorded_at: record.recorded_at || '',
      sector_1_ms: record.sector_1_ms,
      sector_2_ms: record.sector_2_ms,
      sector_3_ms: record.sector_3_ms
    };

    if (!drivers[driverName]) {
      // First lap we have seen for this driver.
      drivers[driverName] = {
        name: driverName,
        team: record.team || 'Unknown Team',
        lap_times: [lap],
        all_laps: [lapDetail],
        lap_count: 1,
        // The driver's fastest time for each sector across all their valid laps,
        // used to colour the sector boxes green (personal best) or purple
        // (overall best). 0 means that sector has not been set yet.
        best_sectors: { s1: 0, s2: 0, s3: 0 }
      };
    } else {
      // We already have a lap for this driver. Count it, keep every lap, and
      // keep this lap as their displayed time only if it is a better lap.
      drivers[driverName].lap_count = drivers[driverName].lap_count + 1;
      drivers[driverName].all_laps.push(lapDetail);
      const currentLap = drivers[driverName].lap_times[0];
      if (isBetterLap(lap, currentLap)) {
        drivers[driverName].lap_times[0] = lap;
        drivers[driverName].team = record.team || drivers[driverName].team;
      }
    }

    // Fold this lap's sectors into the driver's personal best per sector. Only
    // valid laps count, so an illegal lap can never set a "best" sector.
    if (record.is_valid !== false) {
      const best = drivers[driverName].best_sectors;
      best.s1 = minSector(best.s1, record.sector_1_ms);
      best.s2 = minSector(best.s2, record.sector_2_ms);
      best.s3 = minSector(best.s3, record.sector_3_ms);
    }
  }

  // Keep only the 5 most recent laps for each driver, newest first, for the
  // expandable detail view.
  for (const driverName in drivers) {
    const laps = drivers[driverName].all_laps;
    laps.sort(function (a, b) {
      const timeA = a.recorded_at || '';
      const timeB = b.recorded_at || '';
      if (timeA < timeB) return 1;
      if (timeA > timeB) return -1;
      return 0;
    });
    drivers[driverName].recent_laps = laps.slice(0, 5);
  }

  // Step 2: find the single fastest valid lap across all drivers. Invalid laps
  // are never counted as the fastest.
  let fastestLap = null;
  let fastestSeconds = Infinity;
  for (const driverName in drivers) {
    for (const lap of drivers[driverName].lap_times) {
      if (!lap.is_valid) continue;
      const lapSeconds = parseTimeToSeconds(lap.time);
      if (lapSeconds < fastestSeconds) {
        fastestSeconds = lapSeconds;
        fastestLap = lap;
      }
    }
  }

  // Step 3: mark that lap as the fastest so it gets highlighted.
  if (fastestLap) {
    fastestLap.is_fastest = true;
  }

  return drivers;
}

/* Attach the one delegated click handler for the leaderboard body. The table is
   re-rendered (innerHTML) on every update, so the listener lives on the tbody
   itself and is bound only once. */
function bindLeaderboardClicks(tbody) {
  if (!tbody || tbody.dataset.clicksBound === '1') return;
  tbody.dataset.clicksBound = '1';
  tbody.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('.lap-delete-btn');
    if (deleteButton) {
      event.stopPropagation();
      deleteSavedLap(
        deleteButton.dataset.driver,
        deleteButton.dataset.time,
        deleteButton.dataset.recordedAt
      );
      return;
    }
    const row = event.target.closest('tr[data-driver]');
    if (row) {
      toggleDriverExpand(row.dataset.driver);
    }
  });
}

function updateLeaderboard(drivers) {
  const tbody = document.getElementById("timingTableBody");
  bindLeaderboardClicks(tbody);

  // Remember what we rendered so toggling a row open/closed can re-render
  // immediately without waiting for the next data fetch.
  latestLeaderboardDrivers = drivers;

  // Merge in placeholder rows for drivers who are on a live lap but have not set
  // a stored time yet, so their live sectors still show on the left.
  const leaderboardDrivers = addLiveOnlyDrivers(drivers);

  // Flatten all laps from all drivers into a single list
  const allRows = [];
  for (const [, driver] of Object.entries(leaderboardDrivers)) {
    for (const lap of driver.lap_times) {
      allRows.push({ driver, lap });
    }
  }

  document.getElementById("driverCount").textContent =
    Object.keys(leaderboardDrivers).length;

  if (allRows.length === 0) {
    const emptyRowsHtml = `<tr class="no-data-row"><td colspan="8">No timing data recorded for this track</td></tr>`;
    if (emptyRowsHtml !== lastLeaderboardRowsHtml) {
      tbody.innerHTML = emptyRowsHtml;
      lastLeaderboardRowsHtml = emptyRowsHtml;
    }
    return;
  }

  // Sort all laps by time (invalid laps go to the bottom)
  allRows.sort((a, b) => {
    if (a.lap.is_valid !== b.lap.is_valid) return a.lap.is_valid ? -1 : 1;
    return parseTimeToSeconds(a.lap.time) - parseTimeToSeconds(b.lap.time);
  });

  // Work out the personal-best and overall-best sector times before building the
  // rows, so each sector box can be coloured correctly.
  recomputeBestSectors(allRows);

  // Work out which drivers are on a flying lap right now, so their rows show the
  // live in-progress sectors instead of their stored fastest-lap sectors.
  leaderboardLiveLapSectors = buildLeaderboardLiveLapSectors();

  const fastestValidTime = parseTimeToSeconds(
    allRows.find(r => r.lap.is_valid)?.lap.time
  );

  let rowsHtml = '';
  for (let i = 0; i < allRows.length; i++) {
    const driver = allRows[i].driver;
    const lap = allRows[i].lap;
    const pos = i + 1;
    const dotColor = getDriverDotColor(driver);
    const isLiveOnly = driver.is_live_only === true;
    const posClass = pos === 1 ? 'p1' : pos === 2 ? 'p2' : pos === 3 ? 'p3' : '';
    const badgeClass = !lap.is_valid ? 'invalid' : lap.is_fastest ? 'fastest' : 'normal';
    const lapSec = parseTimeToSeconds(lap.time);

    // Defaults for a normal stored lap.
    let posText = !lap.is_valid ? '' : String(pos);
    let posCellClass = posClass;
    let lapTimeHtml = '<span class="laptime-badge ' + badgeClass + '">' + formatTime(lap.time) + '</span>';
    let gap = (!lap.is_valid || i === 0 || !isFinite(fastestValidTime))
      ? '—'
      : '+' + formatGap(lapSec - fastestValidTime);
    let lapCountText = String(driver.lap_count || 1);
    let rowStateClass = !lap.is_valid ? 'invalid-row' : lap.is_fastest ? 'fastest-row' : '';

    // A live-only driver has no stored lap yet, so show dashes everywhere except
    // their live sectors, and never rank or highlight the row.
    if (isLiveOnly) {
      posText = '';
      posCellClass = '';
      lapTimeHtml = '<span class="laptime-badge normal">—</span>';
      gap = '—';
      lapCountText = '—';
      rowStateClass = '';
    }

    const isExpanded = expandedDrivers.has(driver.name);

    rowsHtml += `<tr class="clickable-row ${rowStateClass} ${isExpanded ? 'expanded' : ''}" data-driver="${escapeAttr(driver.name)}">
      <td class="td-pos col-pos ${posCellClass}">${posText}</td>
      <td>
        <div class="driver-name">
          <span class="expand-toggle">${isExpanded ? '−' : '+'}</span>
          <span class="team-dot" style="background:${dotColor}"></span>${escapeHtml(driver.name)}
        </div>
      </td>
      <td class="td-laps col-topspeed">${formatTopSpeed(lap.fastest_speed_kph)}</td>
      <td class="col-bestlap">${lapTimeHtml}</td>
      <td class="td-laps col-potential">${formatPotentialTime(driver)}</td>
      <td class="col-sectors sectors-cell">${buildSectorBoxesHtml(driver, lap)}</td>
      <td class="td-laps col-gap">${gap}</td>
      <td class="td-laps col-laps">${lapCountText}</td>
    </tr>`;

    if (isExpanded) {
      rowsHtml += buildLapDetailRow(driver, fastestValidTime);
    }
  }
  if (rowsHtml !== lastLeaderboardRowsHtml) {
    tbody.innerHTML = rowsHtml;
    lastLeaderboardRowsHtml = rowsHtml;
  }
}

/* Delete one saved lap (the X button next to each lap in the expanded view).
   Asks for confirmation first because removing a lap cannot be undone, then
   tells the backend to delete it and refreshes the leaderboard right away. */
async function deleteSavedLap(driverName, time, recordedAt) {
  if (!currentTrack) {
    return;
  }

  const confirmed = confirm(
    'Delete this lap for ' + driverName + ' (' + formatTime(time) + ')?\n' +
    'This permanently removes the saved lap and cannot be undone.'
  );
  if (!confirmed) {
    return;
  }

  try {
    const body = JSON.stringify({
      track: currentTrack,
      driver: driverName,
      time: time,
      recorded_at: recordedAt
    });
    const response = await fetch('/api/track/records/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    // Refresh now so the deleted lap disappears immediately instead of waiting
    // for the next poll.
    loadDisplayData();
  } catch (e) {
    console.error('Could not delete lap:', e);
    if (typeof showInfoToast === 'function') {
      showInfoToast('Delete failed', 'Could not remove the lap', true);
    }
  }
}

/* Toggle a driver's row open or closed, then re-render so the change shows
   right away (the row state is kept in the global expandedDrivers set). */
function toggleDriverExpand(driverName) {
  if (expandedDrivers.has(driverName)) {
    expandedDrivers.delete(driverName);
  } else {
    expandedDrivers.add(driverName);
  }
  updateLeaderboard(latestLeaderboardDrivers);
}

/* Pull the clock time (HH:MM:SS) out of a recorded_at value like
   "2026-06-04T13:55:39". Returns an empty string when there is nothing. */
function formatRecordedClock(recordedAt) {
  if (!recordedAt) return '';
  const parts = String(recordedAt).split('T');
  if (parts.length < 2) return String(recordedAt);
  return parts[1].slice(0, 8);
}

/* Build the three sector boxes for one of a driver's recent laps, coloured the
   same way as the main row (against the driver's own and the overall best). */
function buildDetailSectorBoxesHtml(driver, lap) {
  let personalBest = leaderboardPersonalBestSectors[driver.name];
  if (!personalBest) {
    personalBest = { s1: 0, s2: 0, s3: 0 };
  }
  const overallBest = leaderboardOverallBestSectors;
  const isValid = lap.is_valid !== false;

  let boxes = '';
  boxes += buildOneSectorBox(lap.sector_1_ms, personalBest.s1, overallBest.s1, isValid);
  boxes += buildOneSectorBox(lap.sector_2_ms, personalBest.s2, overallBest.s2, isValid);
  boxes += buildOneSectorBox(lap.sector_3_ms, personalBest.s3, overallBest.s3, isValid);
  return '<div class="sector-box-row">' + boxes + '</div>';
}

/* Build the expanded detail rows showing a driver's recent laps. Each lap is its
   own row using the SAME eight columns as the main clickable row (top speed, best
   lap, potential, sectors, gap, laps), so the column-visibility toggles hide the
   same cells here too. The potential cell is left blank in detail rows because
   potential is a per-driver stat, not a per-lap one. fastestValidTime is the
   overall fastest valid lap, used for the gap. */
function buildLapDetailRow(driver, fastestValidTime) {
  const laps = driver.recent_laps || [];
  if (laps.length === 0) {
    return `<tr class="lap-detail-row"><td colspan="8">No recent laps</td></tr>`;
  }

  let rowsHtml = '';
  for (let i = 0; i < laps.length; i++) {
    const lap = laps[i];
    const isValid = lap.is_valid !== false;
    const badgeClass = isValid ? 'normal' : 'invalid';
    const clock = formatRecordedClock(lap.recorded_at);

    // Gap to the overall fastest valid lap, the same rule the main row uses.
    let gap = '—';
    if (isValid && isFinite(fastestValidTime)) {
      const diff = parseTimeToSeconds(lap.time) - fastestValidTime;
      if (diff > 0) {
        gap = '+' + formatGap(diff);
      }
    }

    // Zebra stripe the rows for readability: the first row is the lighter shade.
    let stripeClass = 'detail-dark';
    if (i % 2 === 0) {
      stripeClass = 'detail-light';
    }

    // Square X button in the position column of each recent lap, to delete that
    // saved lap. We carry the driver, time and recorded_at in data attributes so
    // the delegated click handler can tell the backend exactly which lap to drop.
    const deleteButtonHtml =
      '<button class="lap-delete-btn" type="button" title="Delete this lap"' +
      ' data-driver="' + escapeAttr(driver.name) + '"' +
      ' data-time="' + escapeAttr(lap.time) + '"' +
      ' data-recorded-at="' + escapeAttr(lap.recorded_at || '') + '">&times;</button>';

    rowsHtml += `<tr class="lap-detail-row ${stripeClass}">
      <td class="td-pos col-pos">${deleteButtonHtml}</td>
      <td class="lap-detail-when">${escapeHtml(clock)}</td>
      <td class="td-laps col-topspeed">${formatTopSpeed(lap.fastest_speed_kph)}</td>
      <td class="col-bestlap">
        <span class="laptime-badge ${badgeClass}">${formatTime(lap.time)}</span>
      </td>
      <td class="td-laps col-potential"></td>
      <td class="col-sectors sectors-cell">${buildDetailSectorBoxesHtml(driver, lap)}</td>
      <td class="td-laps col-gap">${gap}</td>
      <td class="td-laps col-laps"></td>
    </tr>`;
  }

  return rowsHtml;
}

/* Find the lap marked as the pole / track-record reference for this track, if
   there is one. That lap is flagged with "is_pole_reference" in the track_times
   file (for example Charles Leclerc's pole lap at Monaco). */
function findPoleReferenceRecord(records) {
  for (const record of records) {
    if (record.is_pole_reference === true) {
      return record;
    }
  }
  return null;
}

/* Show the pole / track-record lap on the map, or hide the card when the track
   has no reference lap. */
function updatePoleLapCard(records) {
  const card = document.getElementById('poleLapCard');
  if (!card) return;

  const pole = findPoleReferenceRecord(records);
  if (!pole) {
    card.style.display = 'none';
    return;
  }

  document.getElementById('poleLapDriver').textContent = pole.driver || 'Unknown';
  document.getElementById('poleLapTime').textContent = formatTime(pole.time);

  const dot = document.getElementById('poleLapDot');
  dot.style.background = TEAM_COLORS[pole.team] || TEAM_COLORS['DEFAULT'];

  // Build a small meta line from the team and top speed, skipping any blanks.
  const metaParts = [];
  if (pole.team) {
    metaParts.push(pole.team);
  }
  if (pole.fastest_speed_kph !== null && pole.fastest_speed_kph !== undefined) {
    metaParts.push(Math.round(pole.fastest_speed_kph) + ' km/h');
  }
  document.getElementById('poleLapMeta').textContent = metaParts.join('  •  ');

  card.style.display = 'block';
}

function updateFastestLapPill(drivers) {
  const pill = document.getElementById("fastestLapPill");
  for (const [, driver] of Object.entries(drivers)) {
    const fastest = driver.lap_times.find(l => l.is_fastest);
    if (fastest) {
      pill.textContent = formatTime(fastest.time);
      pill.style.display = 'inline-block';
      return;
    }
  }
  pill.style.display = 'none';
}
