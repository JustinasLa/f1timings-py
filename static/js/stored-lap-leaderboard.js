let lastLeaderboardRowsHtml = null;
let leaderboardSearchQuery = '';
let leaderboardValidOnly = false;

function initializeLeaderboardFilters() {
  const search = document.getElementById('leaderboardSearch');
  const validOnly = document.getElementById('leaderboardValidOnly');
  if (search) {
    leaderboardSearchQuery = search.value.trim().toLowerCase();
    search.oninput = function () {
      leaderboardSearchQuery = search.value.trim().toLowerCase();
      updateLeaderboard(latestLeaderboardDrivers);
    };
  }
  if (validOnly) {
    leaderboardValidOnly = validOnly.checked;
    validOnly.onchange = function () {
      leaderboardValidOnly = validOnly.checked;
      updateLeaderboard(latestLeaderboardDrivers);
    };
  }
}

function matchesLeaderboardFilters(driver, lap) {
  return (!leaderboardValidOnly || lap.is_valid !== false) &&
    (String(driver.name) + ' ' + String(driver.team)).toLowerCase().includes(leaderboardSearchQuery);
}

let leaderboardPersonalBestSectors = Object.create(null);
let leaderboardOverallBestSectors = { s1: 0, s2: 0, s3: 0 };

let leaderboardLiveLapSectors = Object.create(null);

const EVENT_DATE_STORAGE_KEY = 'leaderboardEventDate';
let eventDateFilter = '';
let lastEventDateOptionsHtml = null;

function recordDate(record) {
  return String(record?.recorded_at || '').slice(0, 10);
}

function isLeaderboardRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record);
}

function updateEventDateOptions(records) {
  const select = document.getElementById('eventDateFilter');
  if (!select) return;
  const dates = new Set();
  for (const record of records) {
    if (isLeaderboardRecord(record) && record.is_pole_reference !== true && recordDate(record)) {
      dates.add(recordDate(record));
    }
  }
  if (eventDateFilter) {
    dates.add(eventDateFilter);
  }
  let optionsHtml = '<option value="">All time</option>';
  for (const date of Array.from(dates).sort().reverse()) {
    optionsHtml += '<option value="' + escapeAttr(date) + '">' + escapeHtml(date) + '</option>';
  }
  if (optionsHtml !== lastEventDateOptionsHtml) {
    select.innerHTML = optionsHtml;
    lastEventDateOptionsHtml = optionsHtml;
  }
  select.value = eventDateFilter;
}

function filterRecordsByEventDate(records) {
  if (!eventDateFilter) {
    return records;
  }
  return records.filter(record =>
    isLeaderboardRecord(record) && (record.is_pole_reference === true || recordDate(record) === eventDateFilter)
  );
}

function initializeEventDateFilter() {
  eventDateFilter = readStoredValue(EVENT_DATE_STORAGE_KEY) || '';
  updateEventDateOptions([]);
  const select = document.getElementById('eventDateFilter');
  if (!select) return;
  select.onchange = function () {
    eventDateFilter = select.value;
    writeStoredValue(EVENT_DATE_STORAGE_KEY, eventDateFilter);
    loadDisplayData();
  };
}

function formatTopSpeed(speedKph) {
  if (typeof speedKph !== 'number' || !Number.isFinite(speedKph) || speedKph < 0) {
    return '—';
  }
  return Math.round(speedKph) + ' km/h';
}

function formatTyreTag(tyre) {
  if (!tyre) {
    return '';
  }
  const name = String(tyre);
  return '<span class="tyre-tag tyre-' + escapeAttr(name.toLowerCase()) + '" title="' +
    escapeAttr(name) + '">' + escapeHtml(name.charAt(0)) + '</span>';
}

function formatAssistsTag(assists) {
  if (!Array.isArray(assists) || assists.length === 0) {
    return '';
  }
  const text = assists.join(' ');
  return '<span class="assists-tag" title="Assists: ' + escapeAttr(text) + '">' +
    escapeHtml(text) + '</span>';
}

function potentialMs(driver) {
  const best = driver.best_sectors;
  if (!best || ![best.s1, best.s2, best.s3].every(value => sectorMs(value) > 0)) {
    return 0;
  }
  const total = sectorMs(best.s1) + sectorMs(best.s2) + sectorMs(best.s3);
  return Number.isFinite(total) ? total : 0;
}

function formatPotentialTime(driver) {
  const totalMs = potentialMs(driver);
  return totalMs ? formatSeconds(totalMs / 1000) : '—';
}

function buildPotentialTitle(driver, lap) {
  const totalMs = potentialMs(driver);
  const lostMs = Math.round(parseTimeToSeconds(lap.time) * 1000) - totalMs;
  if (!totalMs || !lap.is_valid || !isFinite(lostMs) || lostMs <= 0) {
    return '';
  }
  return ' title="' + formatGap(lostMs / 1000) + ' left on the table vs best lap"';
}

function formatConsistency(driver) {
  const times = (driver.all_laps || [])
    .filter(lap => lap.is_valid !== false)
    .map(lap => parseTimeToSeconds(lap.time))
    .filter(isFinite);
  if (times.length < 3) {
    return '—';
  }
  const mean = times.reduce((sum, t) => sum + t, 0) / times.length;
  const variance = times.reduce((sum, t) => sum + (t - mean) * (t - mean), 0) / times.length;
  return '±' + formatGap(Math.sqrt(variance));
}

function formatLeaderboardSectorMs(milliseconds) {
  milliseconds = sectorMs(milliseconds);
  if (!milliseconds) {
    return '—';
  }
  return (milliseconds / 1000).toFixed(3);
}

function sectorMs(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
}

function minSector(a, b) {
  a = sectorMs(a);
  b = sectorMs(b);
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

function getDisplaySectors(driver, lap) {
  let best = driver.best_sectors;
  if (!best) {
    best = { s1: 0, s2: 0, s3: 0 };
  }

  let s1 = sectorMs(lap.sector_1_ms);
  if (!s1 || s1 <= 0) {
    s1 = sectorMs(best.s1);
  }
  let s2 = sectorMs(lap.sector_2_ms);
  if (!s2 || s2 <= 0) {
    s2 = sectorMs(best.s2);
  }
  let s3 = sectorMs(lap.sector_3_ms);
  if (!s3 || s3 <= 0) {
    s3 = sectorMs(best.s3);
  }

  return { s1: s1, s2: s2, s3: s3, isValid: lap.is_valid !== false };
}

function sectorColorClass(valueMs, personalBestMs, overallBestMs, isValid) {
  valueMs = sectorMs(valueMs);
  personalBestMs = sectorMs(personalBestMs);
  overallBestMs = sectorMs(overallBestMs);
  if (!isValid) {
    return 'sector-invalid';
  }
  if (!valueMs || valueMs <= 0) {
    return 'sector-none';
  }
  if (overallBestMs > 0 && valueMs <= overallBestMs) {
    return 'sector-purple';
  }
  if (personalBestMs <= 0 || valueMs <= personalBestMs) {
    return 'sector-green';
  }
  return 'sector-yellow';
}

function buildOneSectorBox(valueMs, personalBestMs, overallBestMs, isValid) {
  const text = formatLeaderboardSectorMs(valueMs);
  const colorClass = sectorColorClass(valueMs, personalBestMs, overallBestMs, isValid);
  return '<span class="sector-box ' + colorClass + '">' + text + '</span>';
}

function buildLeaderboardLiveLapSectors() {
  const liveLapSectors = Object.create(null);
  for (const liveDriver of Object.values(latestLiveDrivers)) {
    if (!liveDriver || liveDriver.live_lap_active !== true) {
      continue;
    }
    liveLapSectors[liveDriver.name] = {
      s1: sectorMs(liveDriver.live_sector_1_ms),
      s2: sectorMs(liveDriver.live_sector_2_ms),
      s3: sectorMs(liveDriver.live_sector_3_ms),
      isValid: liveDriver.live_lap_invalid !== true
    };
  }
  return liveLapSectors;
}

function addLiveOnlyDrivers(drivers) {
  const mergedDrivers = Object.assign(Object.create(null), drivers);

  for (const liveDriver of Object.values(latestLiveDrivers)) {
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

function liveDeltaMs(live, bestLap) {
  if (bestLap.is_valid === false) {
    return null;
  }
  const bestS1 = sectorMs(bestLap.sector_1_ms);
  const bestS2 = sectorMs(bestLap.sector_2_ms);
  const liveS1 = sectorMs(live.s1);
  const liveS2 = sectorMs(live.s2);
  if (liveS1 > 0 && liveS2 > 0 && bestS1 > 0 && bestS2 > 0) {
    return liveS1 + liveS2 - bestS1 - bestS2;
  }
  if (liveS1 > 0 && bestS1 > 0) {
    return liveS1 - bestS1;
  }
  return null;
}

function buildLiveDeltaHtml(live, bestLap) {
  const deltaMs = liveDeltaMs(live, bestLap);
  if (deltaMs === null) {
    return '';
  }
  const deltaClass = deltaMs <= 0 ? 'delta-ahead' : 'delta-behind';
  const sign = deltaMs <= 0 ? '-' : '+';
  return '<span class="live-delta ' + deltaClass + '" title="Live delta to personal best">' +
    sign + formatGap(Math.abs(deltaMs) / 1000) + '</span>';
}

function buildSectorBoxesHtml(driver, lap) {
  let display = leaderboardLiveLapSectors[driver.name];
  let deltaHtml = '';
  if (display) {
    deltaHtml = buildLiveDeltaHtml(display, lap);
  } else {
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
  return '<div class="sector-box-row">' + boxes + '</div>' + deltaHtml;
}

function recomputeBestSectors(rows) {
  leaderboardPersonalBestSectors = Object.create(null);
  leaderboardOverallBestSectors = { s1: 0, s2: 0, s3: 0 };

  for (let i = 0; i < rows.length; i++) {
    const driver = rows[i].driver;

    let recordBest = driver.best_sectors;
    if (!recordBest) {
      recordBest = { s1: 0, s2: 0, s3: 0 };
    }
    const personalBest = { s1: sectorMs(recordBest.s1), s2: sectorMs(recordBest.s2), s3: sectorMs(recordBest.s3) };

    leaderboardPersonalBestSectors[driver.name] = personalBest;
    leaderboardOverallBestSectors.s1 = minSector(leaderboardOverallBestSectors.s1, personalBest.s1);
    leaderboardOverallBestSectors.s2 = minSector(leaderboardOverallBestSectors.s2, personalBest.s2);
    leaderboardOverallBestSectors.s3 = minSector(leaderboardOverallBestSectors.s3, personalBest.s3);
  }
}

function isBetterLap(candidate, current) {
  const candidateSeconds = parseTimeToSeconds(candidate.time);
  const currentSeconds = parseTimeToSeconds(current.time);
  if (Number.isFinite(candidateSeconds) !== Number.isFinite(currentSeconds)) {
    return Number.isFinite(candidateSeconds);
  }
  if (candidate.is_valid !== current.is_valid) {
    return current.is_valid === false;
  }
  return candidateSeconds < currentSeconds;
}

function getDriverDotColor(driver) {
  return Object.prototype.hasOwnProperty.call(TEAM_COLORS, driver.team)
    ? TEAM_COLORS[driver.team]
    : TEAM_COLORS['DEFAULT'];
}

function buildDriversFromRecords(records) {
  const drivers = Object.create(null);

  for (const record of records) {
    if (!isLeaderboardRecord(record) || record.is_pole_reference === true) {
      continue;
    }

    const driverName = typeof record.driver === 'string' && record.driver ? record.driver : 'Unknown';
    const recordSeconds = parseTimeToSeconds(record.time);
    const isValid = record.is_valid !== false && Number.isFinite(recordSeconds);

    const lap = {
      time: record.time,
      is_fastest: false,
      is_valid: isValid,
      fastest_speed_kph: record.fastest_speed_kph,
      sector_1_ms: record.sector_1_ms,
      sector_2_ms: record.sector_2_ms,
      sector_3_ms: record.sector_3_ms,
      tyre: record.tyre,
      assists: record.assists
    };

    const lapDetail = {
      time: record.time,
      is_valid: isValid,
      fastest_speed_kph: record.fastest_speed_kph,
      recorded_at: record.recorded_at || '',
      sector_1_ms: record.sector_1_ms,
      sector_2_ms: record.sector_2_ms,
      sector_3_ms: record.sector_3_ms,
      tyre: record.tyre,
      assists: record.assists
    };

    if (!drivers[driverName]) {
      drivers[driverName] = {
        name: driverName,
        team: record.team || 'Unknown Team',
        lap_times: [lap],
        all_laps: [lapDetail],
        lap_count: 1,
        best_sectors: { s1: 0, s2: 0, s3: 0 }
      };
    } else {
      drivers[driverName].lap_count = drivers[driverName].lap_count + 1;
      drivers[driverName].all_laps.push(lapDetail);
      const currentLap = drivers[driverName].lap_times[0];
      if (isBetterLap(lap, currentLap)) {
        drivers[driverName].lap_times[0] = lap;
        drivers[driverName].team = record.team || drivers[driverName].team;
      }
    }

    if (isValid) {
      const best = drivers[driverName].best_sectors;
      best.s1 = minSector(best.s1, record.sector_1_ms);
      best.s2 = minSector(best.s2, record.sector_2_ms);
      best.s3 = minSector(best.s3, record.sector_3_ms);
    }
  }

  for (const driverName in drivers) {
    const laps = drivers[driverName].all_laps;
    laps.sort(function (a, b) {
      const timeA = a.recorded_at || '';
      const timeB = b.recorded_at || '';
      const timestampA = Date.parse(timeA);
      const timestampB = Date.parse(timeB);
      if (Number.isFinite(timestampA) && Number.isFinite(timestampB)) return timestampB - timestampA;
      if (timeA < timeB) return 1;
      if (timeA > timeB) return -1;
      return 0;
    });
    drivers[driverName].recent_laps = laps.slice(0, 5);
  }

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

  if (fastestLap) {
    fastestLap.is_fastest = true;
  }

  return drivers;
}

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

  latestLeaderboardDrivers = drivers;

  const leaderboardDrivers = addLiveOnlyDrivers(drivers);

  const allRows = [];
  for (const [, driver] of Object.entries(leaderboardDrivers)) {
    for (const lap of driver.lap_times) {
      allRows.push({ driver, lap });
    }
  }

  document.getElementById("driverCount").textContent =
    Object.keys(leaderboardDrivers).length;

  if (allRows.length === 0) {
    const emptyRowsHtml = `<tr class="no-data-row"><td colspan="10">No timing data recorded for this track</td></tr>`;
    if (emptyRowsHtml !== lastLeaderboardRowsHtml) {
      tbody.innerHTML = emptyRowsHtml;
      lastLeaderboardRowsHtml = emptyRowsHtml;
    }
    return;
  }

  allRows.sort((a, b) => {
    if (a.lap.is_valid !== b.lap.is_valid) return a.lap.is_valid ? -1 : 1;
    return parseTimeToSeconds(a.lap.time) - parseTimeToSeconds(b.lap.time);
  });

  recomputeBestSectors(allRows);

  leaderboardLiveLapSectors = buildLeaderboardLiveLapSectors();

  const fastestValidTime = parseTimeToSeconds(
    allRows.find(r => r.lap.is_valid && Number.isFinite(parseTimeToSeconds(r.lap.time)))?.lap.time
  );

  let previousValidTime = Infinity;
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

    let posText = !lap.is_valid || !Number.isFinite(lapSec) ? '' : String(pos);
    let posCellClass = posText ? posClass : '';
    let lapTimeHtml = '<span class="laptime-badge ' + badgeClass + '">' + formatTime(lap.time) + '</span>';
    let gap = (!lap.is_valid || i === 0 || !isFinite(fastestValidTime) || !Number.isFinite(lapSec))
      ? '—'
      : '+' + formatGap(lapSec - fastestValidTime);
    let interval = '—';
    if (lap.is_valid && !isLiveOnly && isFinite(lapSec)) {
      if (isFinite(previousValidTime)) {
        interval = '+' + formatGap(lapSec - previousValidTime);
      }
      previousValidTime = lapSec;
    }
    // Keep positions and intervals relative to the complete timing order.
    if (!matchesLeaderboardFilters(driver, lap)) continue;
    let lapCountText = String(driver.lap_count || 1);
    let rowStateClass = !lap.is_valid ? 'invalid-row' : lap.is_fastest ? 'fastest-row' : '';

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
      <td class="col-bestlap">${lapTimeHtml}${formatTyreTag(lap.tyre)}${formatAssistsTag(lap.assists)}</td>
      <td class="td-laps col-potential"${buildPotentialTitle(driver, lap)}>${formatPotentialTime(driver)}</td>
      <td class="col-sectors sectors-cell">${buildSectorBoxesHtml(driver, lap)}</td>
      <td class="td-laps col-gap">${gap}</td>
      <td class="td-laps col-interval">${interval}</td>
      <td class="td-laps col-consistency">${formatConsistency(driver)}</td>
      <td class="td-laps col-laps">${lapCountText}</td>
    </tr>`;

    if (isExpanded) {
      rowsHtml += buildLapDetailRow(driver, fastestValidTime);
    }
  }
  if (!rowsHtml) {
    rowsHtml = '<tr class="no-data-row"><td colspan="10">No drivers match these filters</td></tr>';
  }
  if (rowsHtml !== lastLeaderboardRowsHtml) {
    tbody.innerHTML = rowsHtml;
    lastLeaderboardRowsHtml = rowsHtml;
  }
}

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
    loadDisplayData();
  } catch (e) {
    console.error('Could not delete lap:', e);
    if (typeof showInfoToast === 'function') {
      showInfoToast('Delete failed', 'Could not remove the lap', true);
    }
  }
}

function toggleDriverExpand(driverName) {
  if (expandedDrivers.has(driverName)) {
    expandedDrivers.delete(driverName);
  } else {
    expandedDrivers.add(driverName);
  }
  updateLeaderboard(latestLeaderboardDrivers);
}

function formatRecordedClock(recordedAt) {
  if (!recordedAt) return '';
  const parts = String(recordedAt).split('T');
  if (parts.length < 2) return String(recordedAt);
  return parts[1].slice(0, 8);
}

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

function buildPbProgressionRow(driver) {
  const times = [];
  const laps = (driver.all_laps || []).slice().reverse();
  for (const lap of laps) {
    const seconds = parseTimeToSeconds(lap.time);
    if (lap.is_valid !== false && isFinite(seconds)) {
      times.push(seconds);
    }
  }
  if (times.length < 2) {
    return '';
  }

  const width = 200;
  const height = 40;
  const pad = 4;
  const min = Math.min(...times);
  const range = (Math.max(...times) - min) || 1;
  let best = Infinity;
  let points = '';
  let dots = '';
  for (let i = 0; i < times.length; i++) {
    const x = (pad + i * (width - 2 * pad) / (times.length - 1)).toFixed(1);
    const y = (pad + (times[i] - min) / range * (height - 2 * pad)).toFixed(1);
    points += x + ',' + y + ' ';
    if (times[i] < best) {
      best = times[i];
      dots += '<circle class="pb-chart-pb" cx="' + x + '" cy="' + y + '" r="2.5"><title>PB ' +
        formatSeconds(times[i]) + '</title></circle>';
    }
  }

  return `<tr class="pb-chart-row"><td colspan="9">
      <svg class="pb-chart" width="${width}" height="${height}" role="img" aria-label="Valid lap times in order, personal bests highlighted">
        <polyline class="pb-chart-line" points="${points.trim()}"></polyline>${dots}
      </svg>
    </td></tr>`;
}

function buildLapDetailRow(driver, fastestValidTime) {
  const laps = (driver.recent_laps || []).filter(lap => !leaderboardValidOnly || lap.is_valid !== false);
  if (laps.length === 0) {
    return `<tr class="lap-detail-row"><td colspan="10">No recent laps</td></tr>`;
  }

  let rowsHtml = buildPbProgressionRow(driver);
  for (let i = 0; i < laps.length; i++) {
    const lap = laps[i];
    const isValid = lap.is_valid !== false;
    const badgeClass = isValid ? 'normal' : 'invalid';
    const clock = formatRecordedClock(lap.recorded_at);

    let gap = '—';
    if (isValid && isFinite(fastestValidTime)) {
      const diff = parseTimeToSeconds(lap.time) - fastestValidTime;
      if (diff > 0) {
        gap = '+' + formatGap(diff);
      }
    }

    let stripeClass = 'detail-dark';
    if (i % 2 === 0) {
      stripeClass = 'detail-light';
    }

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
        <span class="laptime-badge ${badgeClass}">${formatTime(lap.time)}</span>${formatTyreTag(lap.tyre)}${formatAssistsTag(lap.assists)}
      </td>
      <td class="td-laps col-potential"></td>
      <td class="col-sectors sectors-cell">${buildDetailSectorBoxesHtml(driver, lap)}</td>
      <td class="td-laps col-gap">${gap}</td>
      <td class="td-laps col-interval"></td>
      <td class="td-laps col-consistency"></td>
      <td class="td-laps col-laps"></td>
    </tr>`;
  }

  return rowsHtml;
}

function findPoleReferenceRecord(records) {
  for (const record of records) {
    if (isLeaderboardRecord(record) && record.is_pole_reference === true) {
      return record;
    }
  }
  return null;
}

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
  dot.style.background = getDriverDotColor(pole);

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
