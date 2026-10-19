'use strict';
// Biblioteca: el conjunto de PST que se revisan juntos. Cada archivo tiene su
// propio índice (data/index/<huella>.db). La conexión de consultas abre
// data/library.db y le adjunta los índices activos como f<id>.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./db');
const { t } = require('./i18n');

const MAX_ACTIVE = 10; // límite de bases adjuntas de SQLite

class Library {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.indexDir = path.join(dataDir, 'index');
    this.jsonPath = path.join(dataDir, 'library.json');
    this.libDbPath = path.join(dataDir, 'library.db');
    fs.mkdirSync(this.indexDir, { recursive: true });
    this.files = [];
    this.nextId = 1;
    this.paused = false;
    this.conn = null;
    this.active = [];
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.jsonPath, 'utf8'));
      this.files = j.files || [];
      this.nextId = j.nextId || this.files.reduce((m, f) => Math.max(m, f.id + 1), 1);
      this.paused = !!j.paused;
    } catch { /* biblioteca nueva */ }
  }

  save() {
    const tmp = this.jsonPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ files: this.files, nextId: this.nextId, paused: this.paused }, null, 2));
    fs.renameSync(tmp, this.jsonPath);
  }

  byId(id) { return this.files.find((f) => f.id === Number(id)); }
  dbPath(f) { return path.join(this.indexDir, f.key + '.db'); }
  exists(f) { try { return fs.statSync(f.path).isFile(); } catch { return false; } }

  // Agrega archivos. Si el contenido ya está en la biblioteca (misma huella),
  // solo se actualiza la ruta (útil si el respaldo se movió de disco).
  add(paths) {
    const added = [];
    const skipped = [];
    for (let p of paths) {
      p = path.resolve(String(p || '').trim().replace(/^"|"$/g, ''));
      let st;
      try { st = fs.statSync(p); } catch { skipped.push({ path: p, reason: t('add.notFound') }); continue; }
      if (!st.isFile()) { skipped.push({ path: p, reason: t('add.notFile') }); continue; }
      let key;
      try {
        checkHeader(p);
        key = fingerprint(p, st.size);
      } catch (e) {
        skipped.push({ path: p, reason: e.message });
        continue;
      }
      const same = this.files.find((f) => f.key === key);
      if (same) {
        if (same.path.toLowerCase() !== p.toLowerCase()) {
          same.path = p;
          same.name = path.basename(p);
          added.push({ ...same, relocated: true });
        } else {
          skipped.push({ path: p, reason: t('add.already') });
        }
        continue;
      }
      const f = { id: this.nextId++, path: p, name: path.basename(p), size: st.size, key, enabled: true, addedAt: new Date().toISOString() };
      // crear (o reutilizar) el índice
      const db = D.openDb(this.dbPath(f));
      let ok = false;
      try { ok = D.getMeta(db, 'schema') === D.SCHEMA_VERSION; } catch { ok = false; }
      if (!ok) {
        db.close();
        removeDb(this.dbPath(f));
        const fresh = D.openDb(this.dbPath(f));
        D.createSchema(fresh);
        fresh.close();
      } else {
        db.close();
      }
      const db2 = D.openDb(this.dbPath(f));
      D.setMeta(db2, 'pstPath', p);
      D.setMeta(db2, 'pstName', f.name);
      D.setMeta(db2, 'pstSize', st.size);
      db2.close();
      this.files.push(f);
      added.push(f);
    }
    this.save();
    return { added, skipped };
  }

  remove(id, deleteIndex) {
    const f = this.byId(id);
    if (!f) return false;
    this.files = this.files.filter((x) => x !== f);
    this.save();
    if (deleteIndex && !this.files.some((x) => x.key === f.key)) {
      this.reconnect(); // soltar el archivo antes de borrarlo
      removeDb(this.dbPath(f));
    }
    return true;
  }

  resetIndex(f) {
    removeDb(this.dbPath(f));
    const db = D.openDb(this.dbPath(f));
    D.createSchema(db);
    D.setMeta(db, 'pstPath', f.path);
    D.setMeta(db, 'pstName', f.name);
    D.setMeta(db, 'pstSize', f.size);
    db.close();
  }

  // Metadatos del índice de un archivo (estado del indexado)
  meta(f) {
    try {
      const alias = this.active.find((a) => a.id === f.id);
      const conn = alias ? this.conn : D.openDb(this.dbPath(f));
      const sql = alias ? `SELECT k, v FROM ${alias.alias}.meta` : 'SELECT k, v FROM meta';
      const m = Object.fromEntries(conn.prepare(sql).all().map((r) => [r.k, r.v]));
      if (!alias) conn.close();
      return m;
    } catch {
      return {};
    }
  }

  // (Re)abre la conexión de consultas y adjunta los índices activos.
  reconnect() {
    if (this.conn) { try { this.conn.close(); } catch { /* */ } }
    this.conn = D.openDb(this.libDbPath);
    D.createLibrarySchema(this.conn);
    this.active = [];
    this.overLimit = [];
    for (const f of this.files) {
      if (!f.enabled || !fs.existsSync(this.dbPath(f))) continue;
      if (this.active.length >= MAX_ACTIVE) { this.overLimit.push(f.id); continue; }
      const alias = `f${f.id}`;
      this.conn.prepare(`ATTACH DATABASE ? AS ${alias}`).run(this.dbPath(f));
      this.active.push({ id: f.id, alias });
    }
    return this.conn;
  }
}

function removeDb(file) {
  for (const x of [file, file + '-wal', file + '-shm']) { try { fs.rmSync(x); } catch { /* */ } }
}

function checkHeader(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    if (b.toString('latin1') !== '!BDN') throw new Error(t('add.notPst'));
  } catch (e) {
    if (/EBUSY|EPERM|EACCES/.test(e.code || '')) throw new Error(t('add.locked'));
    throw e;
  } finally {
    fs.closeSync(fd);
  }
}

// Huella del archivo basada en su contenido (tamaño + inicio + mitad + final):
// si el PST se copia, mueve o renombra, se reutiliza el mismo índice.
function fingerprint(p, size) {
  const h = crypto.createHash('sha1').update(String(size));
  const fd = fs.openSync(p, 'r');
  try {
    const CHUNK = 256 * 1024;
    const buf = Buffer.alloc(CHUNK);
    for (const pos of [0, Math.max(0, size - CHUNK), Math.floor(size / 2)]) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex').slice(0, 24);
}

// Busca PST/OST dentro de una carpeta (recursivo, con límites)
function scanFolder(dir, { maxDepth = 6, max = 500 } = {}) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > maxDepth || out.length >= max) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('$') || e.name === 'System Volume Information') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(pst|ost)$/i.test(e.name)) out.push(full);
      if (out.length >= max) return;
    }
  };
  walk(path.resolve(dir), 0);
  return out;
}

module.exports = { Library, scanFolder, removeDb, MAX_ACTIVE };
