// Records every drive once a day at RECORD_TIME (and straight away the first time the app runs).
// If the machine was off or asleep at that time, the day's reading is made as soon as it's back.
const store = require('./store');
const { readAll } = require('./drives');

const RECORD_TIME = parseTime(process.env.RECORD_TIME || '03:00');
const KEEP_DAYS = Math.max(0, Math.floor(Number(process.env.KEEP_DAYS) || 0));

function parseTime(text) {
  const m = String(text).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

// Today and the time now in the container's time zone (TZ), as 2026-11-24 and 03:00.
function localDay(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function localTime(d = new Date()) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

const RETRY_MS = 30 * 60 * 1000;
const state = { recording: false, last: null, lastErrors: {}, lastTry: 0 };

// Reads every drive and saves the readings as today's. Drives that can't be read are left out
// (and their reason kept for the page), so a sleeping NAS never records as an empty drive.
async function record(drives) {
  if (state.recording) return state.last;
  state.recording = true;
  state.lastTry = Date.now();
  try {
    const now = new Date();
    const read = await readAll(drives);
    const values = {};
    const errors = {};
    for (const d of drives) {
      const r = read[d.id];
      if (r && r.ok) values[d.id] = [r.size, r.used, r.free];
      else errors[d.id] = (r && r.error) || 'Not read';
    }
    if (Object.keys(values).length) store.addReadings(localDay(now), now.toISOString(), values, KEEP_DAYS);
    state.last = { at: now.toISOString(), read: Object.keys(values).length, failed: Object.keys(errors).length };
    state.lastErrors = errors;
    return state.last;
  } finally { state.recording = false; }
}

// Drives with no reading yet today.
function missingToday(drives) {
  const t = localDay();
  const today = store.readings().find((e) => e.day === t);
  return drives.filter((d) => !(today && today.d[d.id]));
}

// Checks once a minute whether today's reading is due. A drive that couldn't be read (a sleeping
// NAS) is tried again every 30 minutes until the day is over.
function start(getDrives) {
  const tick = () => {
    const drives = getDrives();
    if (!drives.length || state.recording) return;
    const first = !store.readings().length;
    const due = first || (localTime() >= RECORD_TIME && missingToday(drives).length);
    if (due && Date.now() - state.lastTry >= RETRY_MS) record(drives).catch((e) => console.error('Recording failed:', e.message));
  };
  tick();
  setInterval(tick, 60 * 1000).unref();
}

module.exports = { RECORD_TIME, KEEP_DAYS, state, record, start, localDay };
