require('dotenv').config();
const path = require('path');
const express = require('express');
const { settingsProblems, requireAuth, login, logout, signInOff } = require('./auth');
const drivesLib = require('./drives');
const recorder = require('./recorder');
const stats = require('./stats');
const store = require('./store');
const { DISPLAY_VERSION } = require('./version');

const APP = 'Disk Space Over Time';

// Refuse to start with missing sign-in settings or settings that can't be read, saying what to fix.
const problems = settingsProblems();
let startDrives = [];
try { startDrives = drivesLib.startingDrives(); } catch (e) { problems.push(e.message); }
if (!recorder.RECORD_TIME) problems.push(`RECORD_TIME "${process.env.RECORD_TIME}" isn't a time such as 03:00`);
if (problems.length) {
  console.error(`${APP} cannot start:\n  - ` + problems.join('\n  - '));
  console.error('Set these in your .env file (see .env.example), then start the container again.');
  process.exit(1);
}

// The drives: as saved in Settings, or DRIVES from .env (or the mounted folders) until something is saved there.
function drives() {
  const saved = store.getDrives();
  if (!saved) return startDrives;
  const list = [];
  for (const d of saved) { try { list.push(drivesLib.toDrive(d.name, d.url)); } catch { /* skip one that no longer reads */ } }
  return list;
}

const PORT = Number(process.env.PORT) || 3060;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '20kb' }));

// Unauthenticated: the sign-in page and its endpoints, and a health check for Docker and monitors.
app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.post('/api/login', login);
app.post('/api/logout', logout);
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));
app.use('/favicon.ico', express.static(path.join(__dirname, '..', 'public', 'favicon.ico')));
app.use('/apple-touch-icon.png', express.static(path.join(__dirname, '..', 'public', 'apple-touch-icon.png')));

app.use(requireAuth);

// Changes must come as JSON from this page: a form on another site can't send that.
function jsonOnly(req, res, next) {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
  next();
}

function about() {
  return {
    app: APP, version: DISPLAY_VERSION, signIn: !signInOff,
    recordTime: recorder.RECORD_TIME, keepDays: recorder.KEEP_DAYS,
    trendDays: stats.TREND_DAYS, lowPercent: stats.LOW_PERCENT, soonDays: stats.SOON_DAYS,
  };
}

app.get('/api/drives', (_req, res) => {
  const readings = store.readings();
  res.json({
    ...about(),
    recording: recorder.state.recording,
    last: recorder.state.last,
    firstDay: readings.length ? readings[0].day : null,
    lastDay: readings.length ? readings[readings.length - 1].day : null,
    drives: stats.build(drives(), readings, recorder.state.lastErrors),
  });
});
app.get('/api/about', (_req, res) => res.json(about()));

// Read every drive now, as today's reading.
app.post('/api/record', jsonOnly, async (_req, res) => {
  try { res.json({ ok: true, ...(await recorder.record(drives())) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Every reading as a spreadsheet. Drive names go in as ="..." so Excel never turns one into a date or number.
app.get('/api/export.csv', (_req, res) => {
  const gb = (n) => (n / 1024 ** 3).toFixed(2); // as the page and Windows show them
  const text = (s) => `"=""${String(s).replace(/"/g, '""""')}"""`;
  const known = new Map(drives().map((d) => [d.id, d.name]));
  const rows = ['Date,Drive,Size (GB),Used (GB),Free (GB),Free (%)'];
  for (const e of store.readings()) {
    for (const [id, v] of Object.entries(e.d)) {
      if (!known.has(id)) continue;
      rows.push([e.day, text(known.get(id)), gb(v[0]), gb(v[1]), gb(v[2]), v[0] ? ((v[2] / v[0]) * 100).toFixed(1) : ''].join(','));
    }
  }
  res.set('Content-Disposition', `attachment; filename="Disk Space Over Time ${recorder.localDay()}.csv"`);
  res.type('text/csv; charset=utf-8').send('﻿' + rows.join('\r\n') + '\r\n');
});

// --- Settings: the drives and the SSH key ---
app.get('/api/settings', (_req, res) => {
  res.json({ drives: drives().map((d) => ({ id: d.id, name: d.name, url: d.url })), fromStart: !store.getDrives(), key: store.keyInfo(), root: drivesLib.ROOT.split(path.sep).join('/'), df: drivesLib.DF });
});
app.get('/api/settings/folders', async (_req, res) => {
  try { res.json(await drivesLib.listFolders()); } catch (e) { res.status(500).json({ error: e.message }); }
});
// The drives on another machine, over SSH.
app.post('/api/settings/machine', jsonOnly, async (req, res) => {
  try { res.json({ ok: true, drives: await drivesLib.listMachine(req.body && req.body.url) }); } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.put('/api/settings/drives', jsonOnly, (req, res) => {
  const list = Array.isArray(req.body && req.body.drives) ? req.body.drives : null;
  if (!list) return res.status(400).json({ error: 'No drives sent' });
  if (list.length > 50) return res.status(400).json({ error: 'That is more than 50 drives' });
  try {
    const parsed = list.map((d) => drivesLib.toDrive(d.name, d.url));
    const names = new Set();
    const ids = new Set();
    for (const d of parsed) {
      if (names.has(d.name.toLowerCase())) throw new Error(`Two drives are called "${d.name}"`);
      if (ids.has(d.id)) throw new Error(`"${d.name}" is already on the list`);
      names.add(d.name.toLowerCase()); ids.add(d.id);
    }
    store.saveDrives(parsed);
    // Read a newly added drive straight away, so it has today's reading.
    const today = store.readings().find((e) => e.day === recorder.localDay());
    if (parsed.some((d) => !(today && today.d[d.id]))) recorder.record(drives()).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/settings/key/make', jsonOnly, (_req, res) => {
  try { res.json({ ok: true, key: store.makeKey() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings/key', jsonOnly, (req, res) => {
  try { res.json({ ok: true, key: store.saveKey(req.body && req.body.privateKey, req.body && req.body.passphrase) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/settings/key', (_req, res) => { store.removeKey(); res.json({ ok: true, key: store.keyInfo() }); });

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

app.listen(PORT, () => {
  const list = drives();
  console.log(`${APP} v${DISPLAY_VERSION} on port ${PORT}: ${list.length ? list.map((d) => d.name).join(', ') : 'no drives yet (add them in Settings)'}${signInOff ? ' (sign-in is off)' : ''}`);
  console.log(`Recording every day at ${recorder.RECORD_TIME}${recorder.KEEP_DAYS ? `, keeping ${recorder.KEEP_DAYS} days` : ', keeping every reading'}. Data is kept in ${store.DIR}`);
  recorder.start(drives);
});
