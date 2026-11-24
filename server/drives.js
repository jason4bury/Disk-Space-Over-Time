// Reads how big each drive is and how much is free. A drive is either a folder the app can see
// (a drive or volume mounted into the container under DRIVES_ROOT, read with statfs) or a mount
// point on another machine, read over SSH with a key by running "df -P -k" there.
//   /drives/C                       a folder in the container (or any folder, without Docker)
//   ssh://user@address:22/volume1   a mount point on another machine
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const store = require('./store');

const ROOT = path.resolve(process.env.DRIVES_ROOT || '/drives');
const TIMEOUT_MS = 15000;
const DF = 'df -P -k';

// The same address always gives the same id, so renaming a drive keeps its history, and adding
// one back after removing it brings its history back.
function idOf(url) { return crypto.createHash('sha1').update(url).digest('hex').slice(0, 12); }

// One drive: checks the address. label starts any error message.
function toDrive(name, url, label) {
  name = String(name || '').trim();
  url = String(url || '').trim().replace(/\\/g, '/');
  label = label || `"${name}"`;
  if (!name) throw new Error('Every drive needs a name');
  if (name.length > 60) throw new Error(`${label}: the name is longer than 60 characters`);
  if (!url) throw new Error(`${label} needs a folder or an ssh:// address`);
  const drive = { name, url };
  if (/^ssh:\/\//i.test(url)) drive.ssh = parseSsh(label, url);
  else if (/^[a-z]+:\/\//i.test(url)) throw new Error(`${label}: only folders and ssh:// addresses can be read`);
  else if (!path.isAbsolute(url) && !/^[a-z]:\//i.test(url)) throw new Error(`${label}: the folder needs a full path, such as ${ROOT.split(path.sep).join('/')}/C`);
  drive.id = idOf(drive.ssh ? `ssh://${drive.ssh.username}@${drive.ssh.host.toLowerCase()}:${drive.ssh.port}${drive.ssh.mount}` : url.replace(/\/+$/, '') || '/');
  return drive;
}

// ssh://user@address:port/mount -> { username, host, port, mount }
function parseSsh(label, url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${label}: that address can't be read`); }
  if (!u.username) throw new Error(`${label} needs a user name, such as ssh://admin@192.168.1.20:22/volume1`);
  if (!u.hostname) throw new Error(`${label} needs the machine's address`);
  const mount = decodeURIComponent(u.pathname || '').replace(/(.)\/+$/, '$1') || '/';
  return { username: decodeURIComponent(u.username), host: u.hostname, port: Number(u.port) || 22, mount };
}
function sshKeyOf(ssh) { return `${ssh.username}@${ssh.host.toLowerCase()}:${ssh.port}`; }

// "C=/drives/C, NAS=ssh://admin@192.168.1.20:22/volume1" -> drives
function parseDrives(text) {
  const list = [];
  for (const part of String(text || '').split(/[,;\n]/)) {
    const item = part.trim();
    if (!item) continue;
    const at = item.indexOf('=');
    const name = at > 0 ? item.slice(0, at).trim() : `Drive ${list.length + 1}`;
    list.push(toDrive(name, (at > 0 ? item.slice(at + 1) : item).trim(), `DRIVES: "${item}"`));
  }
  return list;
}

// --- Folders the app can see ---
async function readFolder(dir) {
  let s;
  try { s = await fs.promises.statfs(dir); } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`The folder ${dir} isn't there (is the drive mounted in docker-compose.yml?)`);
    throw new Error(`Can't read ${dir} (${e.code || e.message})`);
  }
  const size = s.blocks * s.bsize;
  if (!size) throw new Error(`${dir} reports no size`);
  return { size, used: (s.blocks - s.bfree) * s.bsize, free: s.bavail * s.bsize };
}

// Each folder directly under DRIVES_ROOT, with its size, for the picker in Settings.
async function listFolders() {
  let entries = [];
  try { entries = await fs.promises.readdir(ROOT, { withFileTypes: true }); } catch { /* nothing mounted */ }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(ROOT, e.name).split(path.sep).join('/'));
  const out = [];
  for (const dir of dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))) {
    try { out.push({ path: dir, name: path.basename(dir), ...(await readFolder(dir)) }); } catch (e) { out.push({ path: dir, name: path.basename(dir), error: e.message }); }
  }
  return { root: ROOT.split(path.sep).join('/'), folders: out };
}

// Before anything is saved in Settings: DRIVES from .env, or else each folder mounted in DRIVES_ROOT.
function startingDrives() {
  if ((process.env.DRIVES || '').trim()) return parseDrives(process.env.DRIVES);
  let entries = [];
  try { entries = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { /* nothing mounted */ }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => toDrive(e.name, path.join(ROOT, e.name).split(path.sep).join('/')));
}

// --- Over SSH ---
// Runs df on another machine and gives back its file systems.
function dfOver(ssh) {
  return new Promise((resolve, reject) => {
    let key;
    try { key = store.keyForSsh(); } catch (e) { reject(e); return; }
    const c = new Client();
    let done = false;
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); c.end(); if (err) reject(err); else resolve(value); };
    const timer = setTimeout(() => finish(new Error(`${ssh.host} didn't answer within 15 seconds`)), TIMEOUT_MS);
    const pin = (process.env.SSH_FINGERPRINTS || '').split(/[,;\s]+/).filter(Boolean);
    let seen = '';
    c.on('ready', () => c.exec(DF, (err, stream) => {
      if (err) return finish(err);
      let out = '';
      let errText = '';
      stream.on('data', (d) => { out += d; });
      stream.stderr.on('data', (d) => { errText += d; });
      stream.on('close', (code) => {
        const list = parseDf(out);
        if (list.length) return finish(null, list);
        finish(new Error(code === 127 ? "df wasn't found on that machine" : (errText.trim().split(/\r?\n/).pop() || "df didn't give any drives")));
      });
    }));
    c.on('error', (e) => {
      if (pin.length && seen && !pin.includes(seen)) return finish(new Error(`The machine's SSH host key (${seen}) isn't one in SSH_FINGERPRINTS`));
      if (e.level === 'client-authentication') return finish(new Error('SSH refused the key (add the line from Settings to ~/.ssh/authorized_keys for that user)'));
      finish(new Error(friendly(e)));
    });
    c.connect({
      host: ssh.host, port: ssh.port, username: ssh.username,
      privateKey: key.privateKey, passphrase: key.passphrase || undefined,
      readyTimeout: TIMEOUT_MS, hostHash: 'sha256',
      // With SSH_FINGERPRINTS set, only a machine whose host key matches one of them is trusted.
      hostVerifier: (hash) => { seen = 'SHA256:' + Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, ''); return !pin.length || pin.includes(seen); },
    });
  });
}
function friendly(e) {
  if (e.code === 'ECONNREFUSED') return 'SSH isn\'t answering on that port';
  if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' || e.code === 'ETIMEDOUT' || /timed out/i.test(e.message)) return 'The machine can\'t be reached';
  if (e.code === 'ENOTFOUND') return 'That machine name isn\'t known on the network';
  return e.message;
}

// "df -P -k" output -> [{ device, mount, size, used, free }] in bytes.
function parseDf(text) {
  const list = [];
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+%|-)\s+(\/.*)$/);
    if (m) list.push({ device: m[1], mount: m[6].trim(), size: Number(m[2]) * 1024, used: Number(m[3]) * 1024, free: Number(m[4]) * 1024 });
  }
  return list;
}

// The file systems worth tracking, for the picker: no memory disks, system images or tiny
// partitions, and each disk once (at its shortest mount point).
function worthTracking(list) {
  const skip = /^(tmpfs|devtmpfs|udev|shm|overlay|none|squashfs|efivarfs|cgroup2?|proc|sysfs)$|^\/dev\/loop/;
  const byDevice = new Map();
  for (const f of list) {
    if (skip.test(f.device) || f.size < 1024 ** 3 || /^\/(proc|sys|dev|run|boot)(\/|$)/.test(f.mount) || /\/@/.test(f.mount)) continue;
    const known = byDevice.get(f.device);
    if (!known || f.mount.length < known.mount.length) byDevice.set(f.device, f);
  }
  return [...byDevice.values()].sort((a, b) => a.mount.localeCompare(b.mount));
}

// The file systems on one machine, for Settings.
async function listMachine(url) {
  const d = toDrive('Test', url);
  if (!d.ssh) throw new Error('That isn\'t an ssh:// address');
  const all = await dfOver(d.ssh);
  return worthTracking(all).map((f) => ({ ...f, url: `ssh://${encodeURIComponent(d.ssh.username)}@${d.ssh.host}:${d.ssh.port}${f.mount}` }));
}

// --- Reading every drive ---
// -> { id: { ok, size, used, free } | { ok: false, error } }. Each machine is asked once, whatever
// the number of its drives.
async function readAll(drives) {
  const out = {};
  const machines = new Map();
  await Promise.all(drives.map(async (d) => {
    if (d.ssh) {
      const k = sshKeyOf(d.ssh);
      if (!machines.has(k)) machines.set(k, dfOver(d.ssh));
      try {
        const list = await machines.get(k);
        const f = list.find((x) => x.mount === d.ssh.mount);
        out[d.id] = f ? { ok: true, size: f.size, used: f.used, free: f.free } : { ok: false, error: `${d.ssh.mount} isn't mounted on ${d.ssh.host}` };
      } catch (e) { out[d.id] = { ok: false, error: e.message }; }
    } else {
      try { out[d.id] = { ok: true, ...(await readFolder(d.url)) }; } catch (e) { out[d.id] = { ok: false, error: e.message }; }
    }
  }));
  return out;
}

module.exports = { ROOT, DF, idOf, toDrive, parseDrives, parseDf, worthTracking, startingDrives, listFolders, listMachine, readAll };
