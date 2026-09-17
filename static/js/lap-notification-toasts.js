/* Lap-time toast notifications. */

/* Build the three sector-time boxes shown in a lap toast. Each box is coloured
   per sector with the SAME logic as the leaderboard (purple = fastest of anyone,
   green = this driver's best or their first, yellow = slower, red = invalid), so
   a single lap can show, say, a purple S1 and a green S3 even when the lap overall
   is not a personal best. Returns an empty string when the lap has no sector data. */
function buildToastSectorsHtml(data) {
  const s1Ms = data.sector_1_ms;
  const s2Ms = data.sector_2_ms;
  const s3Ms = data.sector_3_ms;

  // If we have no sector times at all, do not show an empty row of dashes.
  if (
    formatLeaderboardSectorMs(s1Ms) === '—' &&
    formatLeaderboardSectorMs(s2Ms) === '—' &&
    formatLeaderboardSectorMs(s3Ms) === '—'
  ) {
    return '';
  }

  const isValid = data.is_valid !== false;

  // Reuse the leaderboard's per-driver and overall best sectors so the colours
  // match exactly. A driver with no recorded best (e.g. their first lap) has 0,
  // which buildOneSectorBox/sectorColorClass treat as "this is their best".
  let personalBest = leaderboardPersonalBestSectors[data.name];
  if (!personalBest) {
    personalBest = { s1: 0, s2: 0, s3: 0 };
  }
  const overallBest = leaderboardOverallBestSectors;

  let boxes = '';
  boxes += buildOneSectorBox(s1Ms, personalBest.s1, overallBest.s1, isValid);
  boxes += buildOneSectorBox(s2Ms, personalBest.s2, overallBest.s2, isValid);
  boxes += buildOneSectorBox(s3Ms, personalBest.s3, overallBest.s3, isValid);
  return '<div class="lap-toast-sectors">' + boxes + '</div>';
}

/* Work out a lap's quality (which drives the toast colour and label) by
   comparing it against the leaderboard we are already showing. We do NOT trust
   the backend's is_overall_fastest/is_faster flags here, because those are based
   on the server's in-memory laps only and miss laps loaded from a track's saved
   records file (e.g. a faster time set in a previous session). Comparing against
   the leaderboard keeps the toast colour in step with what the user sees. */
function classifyLapForToast(data) {
  if (data.is_valid === false) {
    return { qualityClass: 'invalid', labelText: 'Invalid Lap' };
  }

  const newSeconds = parseTimeToSeconds(data.time);

  // Find the current overall-best and this driver's own best VALID lap on the
  // leaderboard (the saved records). The new lap is usually not folded in yet.
  let overallBestSeconds = Infinity;
  let driverBestSeconds = Infinity;
  for (const driverName in latestLeaderboardDrivers) {
    const driver = latestLeaderboardDrivers[driverName];
    if (!driver || !driver.lap_times) {
      continue;
    }
    for (let i = 0; i < driver.lap_times.length; i++) {
      const lap = driver.lap_times[i];
      if (lap.is_valid === false) {
        continue;
      }
      const lapSeconds = parseTimeToSeconds(lap.time);
      if (lapSeconds < overallBestSeconds) {
        overallBestSeconds = lapSeconds;
      }
      if (driverName === data.name && lapSeconds < driverBestSeconds) {
        driverBestSeconds = lapSeconds;
      }
    }
  }

  // Compare with <= so a lap that has already been folded into the leaderboard
  // (a refresh landed first) still classifies correctly.
  if (newSeconds <= overallBestSeconds) {
    return { qualityClass: 'fastest', labelText: 'Fastest Lap' };
  }
  if (newSeconds <= driverBestSeconds) {
    return { qualityClass: 'best', labelText: 'Personal Best' };
  }
  return { qualityClass: 'normal', labelText: 'Lap' };
}

function showLapToast(data) {
  const container = document.getElementById('lap-toast-container');

  // Pop a toast for every completed lap (each finish-line crossing), whether or
  // not it was a personal best or the overall fastest, including invalid laps.
  // The quality class drives the accent colour (label, dot and sector boxes);
  // the label text names the lap type, like the pole-lap card.
  const quality = classifyLapForToast(data);
  const qualityClass = quality.qualityClass;
  const labelText = quality.labelText;

  const toast = document.createElement('div');
  toast.className = 'lap-toast ' + qualityClass;

  const sectorsHtml = buildToastSectorsHtml(data);

  toast.innerHTML = `
    <div class="lap-toast-label">${labelText}</div>
    <div class="lap-toast-line">
      <div class="lap-toast-driver">
        <span class="lap-toast-dot"></span>
        ${escapeHtml(data.name)}
      </div>
      <div class="lap-toast-time">${formatTime(data.time)}</div>
    </div>
    ${sectorsHtml}
  `;

  // Newest toast goes on top so the latest lap is always shown first.
  container.prepend(toast);

  setTimeout(() => {
    toast.classList.add('fading');
    toast.addEventListener('animationend', () => toast.remove());
  }, 8000);
}

/* Simple text toast for general feedback (e.g. a player name was saved).
   Pass isError true to style it as a failure. */
function showInfoToast(title, message, isError) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'info-toast';
  if (isError) {
    toast.className = 'info-toast error';
  }

  toast.innerHTML = `
    <div class="toast-driver">${escapeHtml(title)}</div>
    <div class="info-toast-message">${escapeHtml(message)}</div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fading');
    toast.addEventListener('animationend', () => toast.remove());
  }, 3000);
}
