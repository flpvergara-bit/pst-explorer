'use strict';
// Importación de una biblioteca de una versión anterior (la versión web guarda
// sus datos en <carpeta de la app>\data). Se COPIA a la carpeta de datos de la
// app de escritorio y se verifica; la carpeta original no se modifica.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { t } = require('../src/i18n');

const isLibraryDir = (dir) => {
  try { return fs.statSync(path.join(dir, 'library.json')).isFile() && fs.statSync(path.join(dir, 'index')).isDirectory(); } catch { return false; }
};

// Busca bibliotecas anteriores en lugares típicos: junto a la app, en la carpeta
// actual y en carpetas tipo "pst-explorer" (raíz de cada disco, perfil, Escritorio,
// Documentos, Descargas) hasta dos niveles.
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

// Resumen de una biblioteca: archivos, correos indexados y tamaño
function summarize(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const lib = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
  let messages = 0;
  let bytes = 0;
  for (const f of listFiles(dir)) bytes += f.size;
  for (const f of lib.files || []) {
    const db = path.join(dir, 'index', f.key + '.db');
    if (!fs.existsSync(db)) continue;
    // solo lectura sobre una base que no se está escribiendo: se lee el contador guardado
    try {
      const d = new DatabaseSync(db, { readOnly: true });
      const r = d.prepare("SELECT v FROM meta WHERE k = 'indexed'").get();
      d.close();
      messages += Number(r && r.v) || 0;
    } catch { /* índice ilegible: se informará en la verificación */ }
  }
  return { dir, files: (lib.files || []).length, messages, bytes };
}

// Archivos que forman la biblioteca (relativos a dir). Los -wal se copian porque
// pueden tener datos aún no volcados al .db; los -shm no: SQLite los reconstruye.
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

// Copia la biblioteca de src a dest y la verifica:
//  1) cada archivo copiado tiene el mismo SHA-256 que el original;
//  2) cada índice pasa PRAGMA quick_check y su cantidad de correos coincide con lo registrado.
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
  // 1) comprobar que lo escrito es idéntico
  done = 0;
  const problems = [];
  for (const f of files) {
    const h = await hashFile(path.join(tmp, f.rel), (n) => {
      done += n;
      onProgress({ phase: 'verify', done, total, text: f.rel });
    });
    if (h !== hashes.get(f.rel)) problems.push(`${f.rel}: ${t('mig.notIdentical')}`);
  }
  // 2) integridad de cada índice y cantidad de correos
  const { DatabaseSync } = require('node:sqlite');
  const lib = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8'));
  let messages = 0;
  for (const [i, f] of (lib.files || []).entries()) {
    onProgress({ phase: 'check', done: i, total: lib.files.length, text: f.name });
    const db = path.join(tmp, 'index', f.key + '.db');
    if (!fs.existsSync(db)) continue; // archivo agregado pero aún sin índice
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
