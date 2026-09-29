function buildToastSectorsHtml(data) {
  const s1Ms = data.sector_1_ms;
  const s2Ms = data.sector_2_ms;
  const s3Ms = data.sector_3_ms;

  if (
    formatLeaderboardSectorMs(s1Ms) === '—' &&
    formatLeaderboardSectorMs(s2Ms) === '—' &&
    formatLeaderboardSectorMs(s3Ms) === '—'
  ) {
    return '';
  }

  const isValid = data.is_valid !== false;

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

function classifyLapForToast(data) {
  if (data.is_valid === false) {
    return { qualityClass: 'invalid', labelText: 'Invalid Lap' };
  }

  const newSeconds = parseTimeToSeconds(data.time);

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

  container.prepend(toast);

  setTimeout(() => {
    toast.classList.add('fading');
    toast.addEventListener('animationend', () => toast.remove());
  }, 8000);
}

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
