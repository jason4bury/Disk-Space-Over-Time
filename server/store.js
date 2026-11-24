// Everything kept in DATA_DIR: the drives (settings.json), the readings (history.json) and the
// SSH key (ssh-key.json). The private key is stored encrypted (AES-256-GCM) and never sent back
// to the browser.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { utils } = require('ssh2');

const DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const SETTINGS = path.join(DIR, 'settings.json');
const HISTORY = path.join(DIR, 'history.json');
const KEYFILE = path.join(DIR, 'ssh-key.json');
const SECRETFILE = path.join(DIR, '.key-secret');
const KEY_COMMENT = 'disk-space-over-time';

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
// Write to a temporary file first, so a crash never leaves half a file.
function writeJson(file, value, pretty = true) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readText(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }

// --- Drives ---
function getDrives() { return readJson(SETTINGS, {}).drives || null; } // null: none saved yet, use DRIVES / the mounted folders
function saveDrives(drives) {
  const s = readJson(SETTINGS, {});
  s.drives = drives.map((d) => ({ name: d.name, url: d.url }));
  writeJson(SETTINGS, s);
}

// --- Readings: one per day, { day: 'YYYY-MM-DD', at: ISO time, d: { driveId: [size, used, free] } } ---
let history = null;
function readings() {
  if (!history) {
    const h = readJson(HISTORY, null);
    history = h && Array.isArray(h.days) ? h.days : [];
  }
  return history;
}
// Adds a day's readings, replacing that day's earlier ones drive by drive (a drive that couldn't be
// read this time keeps its earlier reading for the day). keepDays > 0 drops older days.
function addReadings(day, at, values, keepDays) {
  const list = readings();
  let entry = list.find((e) => e.day === day);
  if (!entry) {
    entry = { day, at, d: {} };
    list.push(entry);
    list.sort((a, b) => a.day.localeCompare(b.day));
  }
  entry.at = at;
  Object.assign(entry.d, values);
  if (keepDays > 0) {
    const cutoff = new Date(`${day}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
    const first = cutoff.toISOString().slice(0, 10);
    while (list.length && list[0].day < first) list.shift();
  }
  writeJson(HISTORY, { version: 1, days: list }, false);
  return entry;
}

// --- SSH key ---
// The encryption key: from SESSION_SECRET, or (with sign-in off and no secret) a random one kept in DATA_DIR.
function cipherKey() {
  let secret = (process.env.SESSION_SECRET || '').trim();
  if (secret.length < 32) {
    secret = readText(SECRETFILE);
    if (!secret) { secret = crypto.randomBytes(32).toString('hex'); ensureDir(); fs.writeFileSync(SECRETFILE, secret, { mode: 0o600 }); }
  }
  return crypto.createHash('sha256').update(`${KEY_COMMENT} key:${secret}`).digest();
}
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}
function unseal(sealed) {
  const [iv, tag, body] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', cipherKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

function describe(parsed, source, created) {
  const pub = parsed.getPublicSSH();
  return {
    type: parsed.type,
    publicKey: `${parsed.type} ${pub.toString('base64')} ${KEY_COMMENT}`,
    fingerprint: 'SHA256:' + crypto.createHash('sha256').update(pub).digest('base64').replace(/=+$/, ''),
    source, created,
  };
}
function parse(privateKey, passphrase) {
  const parsed = utils.parseKey(privateKey, passphrase || undefined);
  if (parsed instanceof Error) {
    if (/passphrase|decrypt|encrypted/i.test(parsed.message)) throw new Error(passphrase ? 'The passphrase is wrong for this key.' : 'This key has a passphrase: type it in too.');
    throw new Error('That isn\'t a private key this app can read. Paste the whole key, from -----BEGIN to -----END.');
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key.isPrivateKey()) throw new Error('That is a public key. Paste the private key (the file without .pub).');
  return key;
}

function makeKey() {
  const pair = utils.generateKeyPairSync('ed25519', { comment: KEY_COMMENT });
  return saveKey(pair.private, '', 'made');
}
function saveKey(privateKey, passphrase, source = 'pasted') {
  const text = String(privateKey || '').trim().replace(/\r\n/g, '\n') + '\n';
  const info = describe(parse(text, passphrase), source, new Date().toISOString());
  writeJson(KEYFILE, { ...info, sealed: seal(JSON.stringify({ privateKey: text, passphrase: passphrase || '' })) });
  return info;
}
function removeKey() { try { fs.unlinkSync(KEYFILE); } catch { /* already gone */ } }

// What the page may see: never the private key.
function keyInfo() {
  const k = readJson(KEYFILE, null);
  if (k) return { publicKey: k.publicKey, fingerprint: k.fingerprint, type: k.type, source: k.source, created: k.created };
  const file = process.env.SSH_KEY;
  if (file && fs.existsSync(file)) {
    try { return { ...describe(parse(fs.readFileSync(file, 'utf8'), process.env.SSH_KEY_PASSPHRASE), 'file', null), file }; } catch (e) { return { source: 'file', file, error: e.message }; }
  }
  return null;
}

// For connecting: the saved key, or the SSH_KEY file when none is saved in the app.
function keyForSsh() {
  const k = readJson(KEYFILE, null);
  if (k) {
    try { return JSON.parse(unseal(k.sealed)); } catch { throw new Error('The saved SSH key can\'t be unlocked (was SESSION_SECRET changed?). Make or paste the key again in Settings.'); }
  }
  const file = process.env.SSH_KEY;
  if (file) {
    try { return { privateKey: fs.readFileSync(file, 'utf8'), passphrase: process.env.SSH_KEY_PASSPHRASE || '' }; } catch { /* fall through */ }
  }
  throw new Error('No SSH key yet: make one or paste yours in Settings');
}

module.exports = { DIR, getDrives, saveDrives, readings, addReadings, makeKey, saveKey, removeKey, keyInfo, keyForSsh };
