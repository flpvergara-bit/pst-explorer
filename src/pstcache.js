'use strict';
// Caché de páginas para pst-extractor: la librería hace miles de lecturas
// pequeñas (B-tree, cabeceras de bloque). Agruparlas en páginas alineadas
// reduce drásticamente las llamadas al sistema en PST grandes.
const fs = require('fs');
const { PSTFile } = require('pst-extractor');
const { PSTTable7C } = require('pst-extractor/dist/PSTTable7C.class');

const PAGE = 64 * 1024;
const MAX_PAGES = 2048; // ~128 MB por archivo abierto
const DIRECT_READ = 4 * PAGE; // lecturas grandes (adjuntos) van directo

function install() {
  if (PSTFile.prototype.__cached) return;
  PSTFile.prototype.__cached = true;

  // getRecipient(i) y getAttachment(i) de pst-extractor releen la tabla completa
  // en cada llamada: con miles de destinatarios eso es cuadrático y parece un
  // cuelgue. Se memoriza la lectura completa de cada tabla.
  const getItems = PSTTable7C.prototype.getItems;
  PSTTable7C.prototype.getItems = function (start, count) {
    if (start === undefined && count === undefined) {
      if (!this.__allItems) this.__allItems = getItems.call(this);
      return this.__allItems;
    }
    return getItems.call(this, start, count);
  };

  PSTFile.prototype.readSync = function (buffer, length, position) {
    if (!(this.pstFD > 0)) {
      this.pstBuffer.copy(buffer, 0, position, position + length);
      return length;
    }
    if (length >= DIRECT_READ) return fs.readSync(this.pstFD, buffer, 0, length, position);
    if (!this.__pages) this.__pages = new Map();
    const pages = this.__pages;
    let copied = 0;
    while (copied < length) {
      const pos = position + copied;
      const pageNo = Math.floor(pos / PAGE);
      let page = pages.get(pageNo);
      if (page) {
        pages.delete(pageNo); // mover al final (LRU)
        pages.set(pageNo, page);
      } else {
        const buf = Buffer.allocUnsafe(PAGE);
        const n = fs.readSync(this.pstFD, buf, 0, PAGE, pageNo * PAGE);
        page = n === PAGE ? buf : buf.subarray(0, n);
        pages.set(pageNo, page);
        if (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value);
      }
      const off = pos - pageNo * PAGE;
      if (off >= page.length) break; // EOF
      const n = Math.min(page.length - off, length - copied);
      page.copy(buffer, copied, off, off + n);
      copied += n;
    }
    return copied;
  };
}

module.exports = { install };
