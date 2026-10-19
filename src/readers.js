'use strict';
// Open PST readers to view emails from several files.
// pst-extractor keeps the named-property map in a static variable shared
// by all files; when switching from one file to another it is rebuilt for
// the file about to be read.
const fs = require('fs');
const { PSTFile } = require('pst-extractor');
const { NodeMap } = require('pst-extractor/dist/NodeMap.class');
const R = require('./pstreader');
const { t } = require('./i18n');

class Readers {
  constructor(lib) {
    this.lib = lib;
    this.open = new Map(); // file id -> PSTFile
    this.current = null;
    this.cache = new Map(); // "fid-ref" -> PSTMessage (pocos, LRU)
  }

  pst(fid) {
    const f = this.lib.byId(fid);
    if (!f) throw Object.assign(new Error(t('err.notInLibrary')), { status: 404 });
    let p = this.open.get(f.id);
    if (!p) {
      if (!this.lib.exists(f)) {
        throw Object.assign(new Error(t('err.unavailable', { path: f.path })), { status: 410 });
      }
      PSTFile.nodeMap = new NodeMap();
      try {
        p = R.openPst(f.path);
      } catch (e) {
        const msg = /EBUSY|EPERM|EACCES/.test(e.code || e.message) ? t('err.locked') : e.message;
        throw Object.assign(new Error(msg), { status: 409 });
      }
      this.open.set(f.id, p);
      this.current = f.id;
      return p;
    }
    if (this.current !== f.id) {
      PSTFile.nodeMap = new NodeMap();
      p.processNameToIDMap();
      this.current = f.id;
    }
    return p;
  }

  // ref: "fid-nid[.idx...]"
  message(ref) {
    const m = /^(\d+)-(\d+(?:\.\d+)*)$/.exec(String(ref));
    if (!m) throw new R.NotFound(t('err.badRef'));
    const fid = Number(m[1]);
    const pst = this.pst(fid); // also makes this file's map active
    let msg = this.cache.get(ref);
    if (msg) {
      this.cache.delete(ref);
      this.cache.set(ref, msg);
      return msg;
    }
    msg = R.loadMessage(pst, m[2]);
    this.cache.set(ref, msg);
    if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
    return msg;
  }

  close(fid) {
    const p = this.open.get(fid);
    if (p) { try { p.close(); } catch { /* */ } }
    this.open.delete(fid);
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${fid}-`)) this.cache.delete(k);
    if (this.current === fid) this.current = null;
  }

  closeAll() {
    for (const id of [...this.open.keys()]) this.close(id);
  }
}

module.exports = { Readers };
