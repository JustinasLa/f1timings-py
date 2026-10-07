function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readStoredValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
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
    && Number.isFinite(driver.world_x)
    && Number.isFinite(driver.world_z);
}
function parseTimeToSeconds(t) {
  if (typeof t === 'number') {
    return Number.isFinite(t) && t > 0 ? t : Infinity;
  }
  if (typeof t !== 'string') return Infinity;
  const text = t.trim();
  if (!/^(?:\d+:\d+(?:\.\d+)?|\d+\.\d+\.\d+|\d+(?:\.\d+)?)$/.test(text)) return Infinity;

  let seconds;
  if (text.includes(':')) {
    const parts = text.split(':');
    if (Number(parts[1]) >= 60) return Infinity;
    seconds = Number(parts[0]) * 60 + Number(parts[1]);
  } else if (text.split('.').length === 3) {
    const parts = text.split('.');
    if (Number(parts[1]) >= 60) return Infinity;
    seconds = Number(parts[0]) * 60 + Number(parts[1]) + Number(`0.${parts[2]}`);
  } else {
    seconds = Number(text);
  }
  return Number.isFinite(seconds) && seconds > 0 ? seconds : Infinity;
}

function formatSeconds(s) {
  if (!Number.isFinite(s) || s < 0) return 'N/A';
  // Round before splitting so 59.9996 carries into the next minute.
  const milliseconds = Math.round(s * 1000);
  if (!Number.isFinite(milliseconds)) return 'N/A';
  const minutes = Math.floor(milliseconds / 60000);
  const remainder = milliseconds % 60000;
  return `${minutes}:${(remainder / 1000).toFixed(3).padStart(6, '0')}`;
}

function formatTime(t) {
  return formatSeconds(parseTimeToSeconds(t));
}

function formatGap(seconds) {
  if (!Number.isFinite(seconds)) return 'N/A';
  if (seconds < 60) return seconds.toFixed(3) + 's';
  return formatSeconds(seconds);
}
