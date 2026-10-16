'use strict';
// Lectores de PST abiertos para ver correos de varios archivos.
// pst-extractor guarda el mapa de propiedades con nombre en una variable
// estática compartida por todos los archivos; al pasar de un archivo a otro se
// reconstruye para el archivo que se va a leer.
const fs = require('fs');
const { PSTFile } = require('pst-extractor');
const { NodeMap } = require('pst-extractor/dist/NodeMap.class');
const R = require('./pstreader');

class Readers {
  constructor(lib) {
    this.lib = lib;
    this.open = new Map(); // id archivo -> PSTFile
    this.current = null;
    this.cache = new Map(); // "fid-ref" -> PSTMessage (pocos, LRU)
  }

  pst(fid) {
    const f = this.lib.byId(fid);
    if (!f) throw Object.assign(new Error('El archivo ya no está en la biblioteca'), { status: 404 });
    let p = this.open.get(f.id);
    if (!p) {
      if (!this.lib.exists(f)) {
        throw Object.assign(new Error(`El archivo no está disponible: ${f.path}. Si está en un disco externo, conéctalo (o vuelve a agregarlo desde su nueva ubicación).`), { status: 410 });
      }
      PSTFile.nodeMap = new NodeMap();
      try {
        p = R.openPst(f.path);
      } catch (e) {
        const msg = /EBUSY|EPERM|EACCES/.test(e.code || e.message) ? 'El archivo está bloqueado (¿Outlook lo tiene abierto?)' : e.message;
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
    if (!m) throw new R.NotFound('Referencia inválida');
    const fid = Number(m[1]);
    const pst = this.pst(fid); // también deja activo el mapa de este archivo
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
