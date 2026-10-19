'use strict';
// Import of a library from a previous version (the web version keeps its data
// in <app folder>\data). It is COPIED to the desktop app's data folder and
// verified; the original folder is not modified.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { t } = require('../src/i18n');

const isLibraryDir = (dir) => {
  try { return fs.statSync(path.join(dir, 'library.json')).isFile() && fs.statSync(path.join(dir, 'index')).isDirectory(); } catch { return false; }
};

// Looks for previous libraries in typical places: next to the app, in the current
// folder and in "pst-explorer"-like folders (root of each drive, profile, Desktop,
// Documents, Downloads) up to two levels deep.
function findLegacy(extra = []) {
  const found = new Set();
  const add = (dir) => { if (dir && isLibraryDir(dir)) found.add(path.resolve(dir)); };
  for (const d of extra) add(d);
  add(path.join(process.cwd(), 'data'));
  const home = os.homedir();
  const bases = [home, path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')];
  if (process.platform === 'win32') for (const l of 'CDEFGH') if (fs.existsSync(`${l}:\\`)) bases.push(`${l}:\\`);
  const re = /pst.?explorer/i;
  const scan = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('$') || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (re.test(e.name)) add(path.join(full, 'data'));
      else if (depth > 1 && !/^(windows|program files.*|programdata|appdata|node_modules)$/i.test(e.name)) scan(full, depth - 1);
    }
  };
  for (const b of bases) scan(b, 2);
  return [...found];
}

// Summary of a library: files, indexed emails and size
function summarize(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const lib = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
  let messages = 0;
  let bytes = 0;
  for (const f of listFiles(dir)) bytes += f.size;
  for (const f of lib.files || []) {
    const db = path.join(dir, 'index', f.key + '.db');
    if (!fs.existsSync(db)) continue;
    // read-only on a database that is not being written: read the stored counter
    try {
      const d = new DatabaseSync(db, { readOnly: true });
      const r = d.prepare("SELECT v FROM meta WHERE k = 'indexed'").get();
      d.close();
      messages += Number(r && r.v) || 0;
    } catch { /* unreadable index: reported by the verification */ }
  }
  return { dir, files: (lib.files || []).length, messages, bytes };
}

// Files that make up the library (relative to dir). -wal files are copied because
// they may hold data not yet flushed to the .db; -shm files are not: SQLite rebuilds them.
function listFiles(dir) {
  const out = [];
  for (const name of ['library.json', 'library.db', 'library.db-wal']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) out.push({ rel: name, size: fs.statSync(p).size });
  }
  for (const name of fs.readdirSync(path.join(dir, 'index'))) {
    const p = path.join(dir, 'index', name);
    if (fs.statSync(p).isFile() && !name.endsWith('-shm')) out.push({ rel: path.join('index', name), size: fs.statSync(p).size });
  }
  return out;
}

function copyFileHashed(src, dest, onBytes) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 });
    const ws = fs.createWriteStream(dest);
    rs.on('data', (chunk) => { h.update(chunk); onBytes(chunk.length); });
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', () => resolve(h.digest('hex')));
    rs.pipe(ws);
  });
}

function hashFile(file, onBytes) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on('data', (c) => { h.update(c); onBytes(c.length); })
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

// Copies the library from src to dest and verifies it:
//  1) every copied file has the same SHA-256 as the original;
//  2) every index passes PRAGMA quick_check and its email count matches the recorded one.
// onProgress({ phase, done, total, text })
async function copyAndVerify(src, dest, onProgress = () => {}) {
  const tmp = dest + '.importando';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'index'), { recursive: true });
  const files = listFiles(src);
  const total = files.reduce((s, f) => s + f.size, 0);
  let done = 0;
  const hashes = new Map();
  for (const f of files) {
    onProgress({ phase: 'copy', done, total, text: f.rel });
    hashes.set(f.rel, await copyFileHashed(path.join(src, f.rel), path.join(tmp, f.rel), (n) => {
      done += n;
      onProgress({ phase: 'copy', done, total, text: f.rel });
    }));
  }
  // 1) check that what was written is identical
  done = 0;
  const problems = [];
  for (const f of files) {
    const h = await hashFile(path.join(tmp, f.rel), (n) => {
      done += n;
      onProgress({ phase: 'verify', done, total, text: f.rel });
    });
    if (h !== hashes.get(f.rel)) problems.push(`${f.rel}: ${t('mig.notIdentical')}`);
  }
  // 2) integrity of each index and email count
  const { DatabaseSync } = require('node:sqlite');
  const lib = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8'));
  let messages = 0;
  for (const [i, f] of (lib.files || []).entries()) {
    onProgress({ phase: 'check', done: i, total: lib.files.length, text: f.name });
    const db = path.join(tmp, 'index', f.key + '.db');
    if (!fs.existsSync(db)) continue; // file added but not indexed yet
    try {
      const d = new DatabaseSync(db);
      const ok = d.prepare('PRAGMA quick_check').get();
      const meta = Object.fromEntries(d.prepare('SELECT k, v FROM meta').all().map((r) => [r.k, r.v]));
      const n = d.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
      d.close();
      if (Object.values(ok)[0] !== 'ok') problems.push(`${f.name}: ${t('mig.integrity')}`);
      if (meta.complete === '1' && Number(meta.indexed) !== n) problems.push(`${f.name}: ${t('mig.count', { expected: meta.indexed, found: n })}`);
      messages += n;
    } catch (e) {
      problems.push(`${f.name}: ${e.message}`);
    }
  }
  if (problems.length) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const err = new Error(problems.join('\n'));
    err.problems = problems;
    throw err;
  }
  const info = { from: src, at: new Date().toISOString(), files: (lib.files || []).length, messages, bytes: total, verified: true, oldDeleted: false };
  fs.writeFileSync(path.join(tmp, 'migration.json'), JSON.stringify(info, null, 2));
  fs.renameSync(tmp, dest);
  return info;
}

module.exports = { findLegacy, summarize, copyAndVerify, isLibraryDir };
