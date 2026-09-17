/* Generic helpers: HTML escaping, fetch, and lap-time formatting. */

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function escapeJs(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function fetchJsonWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function hasLivePosition(driver) {
  return driver
    && Number.isFinite(Number(driver.world_x))
    && Number.isFinite(Number(driver.world_z));
}
function parseTimeToSeconds(t) {
  if (!t) return Infinity;
  if (t.includes(':')) {
    const parts = t.split(/[:.]/);
    if (parts.length === 3) return parseInt(parts[0]) * 60 + parseInt(parts[1]) + parseFloat(`0.${parts[2]}`);
    if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  }
  if (t.includes('.')) {
    const parts = t.split('.');
    if (parts.length === 3) return parseInt(parts[0]) * 60 + parseInt(parts[1]) + parseFloat(`0.${parts[2]}`);
    return parseFloat(t);
  }
  return parseFloat(t) || Infinity;
}

/* Format a number of seconds as m:ss.sss (for example 70.27 -> "1:10.270"). */
function formatSeconds(s) {
  if (!isFinite(s)) return 'N/A';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? '0' : ''}${rem.toFixed(3)}`;
}

function formatTime(t) {
  return formatSeconds(parseTimeToSeconds(t));
}

function formatGap(seconds) {
  if (seconds < 60) return seconds.toFixed(3) + 's';
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(3).padStart(6, '0');
  return `${m}:${s}`;
}
