'use strict';
// Library: the set of PSTs reviewed together. Each file has its own
// index (data/index/<fingerprint>.db). The query connection opens
// data/library.db and attaches the active indexes to it as f<id>.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./db');
const { t } = require('./i18n');

const MAX_ACTIVE = 10; // SQLite limit of attached databases

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
    } catch { /* new library */ }
  }

  save() {
    const tmp = this.jsonPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ files: this.files, nextId: this.nextId, paused: this.paused }, null, 2));
    fs.renameSync(tmp, this.jsonPath);
  }

  byId(id) { return this.files.find((f) => f.id === Number(id)); }
  dbPath(f) { return path.join(this.indexDir, f.key + '.db'); }
  exists(f) { try { return fs.statSync(f.path).isFile(); } catch { return false; } }

  // Adds files. If the content is already in the library (same fingerprint),
  // only the path is updated (useful if the backup moved to another drive).
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
      // create (or reuse) the index
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
      this.reconnect(); // release the file before deleting it
      removeDb(this.dbPath(f));
    }
    return true;
  }

  resetIndex(f) {
    this.conn.close(); // release the index so it can be deleted (reconnect reopens it)
    this.conn = null;
    removeDb(this.dbPath(f));
    const db = D.openDb(this.dbPath(f));
    D.createSchema(db);
    D.setMeta(db, 'pstPath', f.path);
    D.setMeta(db, 'pstName', f.name);
    D.setMeta(db, 'pstSize', f.size);
    db.close();
  }

  // Metadata of a file's index (indexing status)
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

  // (Re)opens the query connection and attaches the active indexes.
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
  // force only ignores missing files: a locked index must not look deleted
  for (const x of [file, file + '-wal', file + '-shm']) fs.rmSync(x, { force: true });
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

// File fingerprint based on its content (size + start + middle + end):
// if the PST is copied, moved or renamed, the same index is reused.
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

// Looks for PST/OST files inside a folder (recursive, with limits)
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
