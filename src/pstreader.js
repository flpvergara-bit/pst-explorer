'use strict';
// Utilidades de lectura de PST compartidas entre el servidor y el indexador.
const Long = require('long');
const iconv = require('iconv-lite');
const { deEncapsulateSync } = require('rtf-stream-parser');
const { PSTFile } = require('pst-extractor');
const { PSTUtil } = require('pst-extractor/dist/PSTUtil.class');
require('./pstcache').install();

const ATTACH_EMBEDDED = 5;
const MAX_RECIPIENTS = 5000; // envíos masivos: más allá de esto no aporta

function safe(fn, def = '') {
  try {
    const v = fn();
    return v == null ? def : v;
  } catch {
    return def;
  }
}

function openPst(path) {
  return new PSTFile(path);
}

function loadObject(pst, nid) {
  const node = pst.getDescriptorIndexNode(Long.fromNumber(nid));
  return PSTUtil.detectAndLoadPSTObject(pst, node);
}

// Ids de los elementos de una carpeta. A diferencia de getNextChild(), no se
// detiene ante filas dañadas o no descargadas (OST): simplemente las omite.
function folderChildIds(folder) {
  const ids = [];
  try { folder.initEmailsTable(); } catch { return ids; }
  const t = folder.emailsTable;
  if (t) {
    const n = t.rowCount;
    for (let i = 0; i < n; i += 500) {
      let rows;
      try { rows = t.getItems(i, Math.min(500, n - i)); } catch { continue; }
      for (const row of rows) {
        const e = row && row.get(0x67f2);
        if (e && e.itemIndex !== -1 && e.entryValueReference > 0) ids.push(e.entryValueReference);
      }
    }
  } else if (folder.fallbackEmailsTable) {
    for (const node of folder.fallbackEmailsTable) ids.push(node.descriptorIdentifier);
  }
  return ids;
}

class NotFound extends Error {
  constructor(msg) { super(msg); this.status = 404; }
}

// ref: "123" (id de nodo) o "123.0.2" (mensajes adjuntos dentro de mensajes)
function parseRef(ref) {
  const parts = String(ref).split('.').map(Number);
  if (!parts.length || parts.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new NotFound('Referencia inválida');
  return parts;
}

function loadMessage(pst, ref) {
  const parts = parseRef(ref);
  let msg;
  try {
    msg = loadObject(pst, parts[0]);
  } catch {
    throw new NotFound('Mensaje no encontrado');
  }
  for (const idx of parts.slice(1)) {
    if (idx >= safe(() => msg.numberOfAttachments, 0)) throw new NotFound('Adjunto no encontrado');
    const emb = safe(() => msg.getAttachment(idx).embeddedPSTMessage, null);
    if (!emb) throw new NotFound('El adjunto no es un mensaje');
    msg = emb;
  }
  if (!msg || typeof msg.subject === 'undefined') throw new NotFound('El elemento no es un mensaje');
  return msg;
}

// ---------- direcciones ----------

const isSmtp = (s) => typeof s === 'string' && /^[^\s@<>]+@[^\s@<>]+$/.test(s);

function senderOf(msg) {
  const name = safe(() => msg.senderName) || safe(() => msg.sentRepresentingName);
  let email = safe(() => msg.senderEmailAddress);
  if (!isSmtp(email)) {
    // remitentes Exchange (X500): buscar la dirección SMTP en propiedades alternativas
    email = [0x5d01, 0x5d02, 0x0065]
      .map((id) => safe(() => msg.getStringItem(id)))
      .find(isSmtp) || safe(() => msg.sentRepresentingEmailAddress);
    if (!isSmtp(email)) email = '';
  }
  return { name: name || email, email };
}

function recipientsOf(msg) {
  const out = { to: [], cc: [], bcc: [] };
  const n = Math.min(safe(() => msg.numberOfRecipients, 0), MAX_RECIPIENTS);
  for (let i = 0; i < n; i++) {
    const r = safe(() => msg.getRecipient(i), null);
    if (!r) continue;
    let email = safe(() => r.smtpAddress);
    if (!isSmtp(email)) email = isSmtp(safe(() => r.emailAddress)) ? r.emailAddress : '';
    const name = safe(() => r.displayName) || email;
    const type = safe(() => r.recipientType, 1);
    (type === 2 ? out.cc : type === 3 ? out.bcc : out.to).push({ name, email });
  }
  // Algunos PST no tienen tabla de destinatarios: usar los textos de visualización
  if (!n) {
    const split = (s) => (s || '').split(';').map((x) => x.trim()).filter(Boolean).map((name) => ({ name, email: '' }));
    out.to = split(safe(() => msg.displayTo));
    out.cc = split(safe(() => msg.displayCC));
    out.bcc = split(safe(() => msg.displayBCC));
  }
  return out;
}

const fmtAddr = (a) => (a.email && a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.name || a.email);
const fmtList = (list) => list.map(fmtAddr).join('; ');

function messageDate(msg) {
  const d = safe(() => msg.messageDeliveryTime, null) || safe(() => msg.clientSubmitTime, null) || safe(() => msg.creationTime, null);
  return d instanceof Date && !isNaN(d) ? d.getTime() : null;
}

// ---------- asunto / hilos ----------

const PREFIX_RE = /^\s*(?:\[[^\]]{0,40}\]\s*)?(?:re|rv|fw|fwd|res|enc|tr|aw|wg|sv|vs|rif|r|reenviar|reenv|resp|respuesta)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i;

function normalizeSubject(s) {
  let prev;
  s = String(s || '');
  do {
    prev = s;
    s = s.replace(PREFIX_RE, '');
  } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function convKeyOf(msg, id) {
  const k = normalizeSubject(safe(() => msg.conversationTopic) || safe(() => msg.subject));
  return k || `#${id}`;
}

// ---------- cuerpo ----------

function rtfToText(rtf) {
  // Conversión básica de RTF a texto plano (para RTF "real", no encapsulado)
  let out = '';
  let depth = 0;
  const skipStack = [];
  let skip = false;
  let uc = 1;
  let i = 0;
  const SKIP_DEST = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|headerl|headerr|footerl|footerr|listtable|listoverridetable|rsidtbl|xmlnstbl|themedata|colorschememapping|latentstyles|datastore|generator|mmathPr)$/;
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === '{') {
      skipStack.push(skip);
      depth++;
      i++;
      if (rtf.startsWith('\\*', i)) skip = true;
    } else if (c === '}') {
      skip = skipStack.pop() || false;
      depth--;
      i++;
    } else if (c === '\\') {
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?|^\\'([0-9a-fA-F]{2})|^\\(.)/s.exec(rtf.slice(i, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      if (m[1]) {
        const w = m[1];
        if (SKIP_DEST.test(w)) skip = true;
        else if (skip) continue;
        else if (w === 'par' || w === 'line' || w === 'row') out += '\n';
        else if (w === 'tab' || w === 'cell') out += '\t';
        else if (w === 'uc') uc = Number(m[2] || 1);
        else if (w === 'u') {
          let code = Number(m[2]);
          if (code < 0) code += 65536;
          out += String.fromCharCode(code);
          i += uc; // saltar el carácter de reemplazo
        }
      } else if (m[3] && !skip) {
        out += iconv.decode(Buffer.from([parseInt(m[3], 16)]), 'win1252');
      } else if (m[4] && !skip) {
        if (m[4] === '~') out += ' ';
        else if ('\\{}'.includes(m[4])) out += m[4];
      }
    } else {
      if (!skip && c !== '\r' && c !== '\n') out += c;
      i++;
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function rtfDecode(buf, enc) {
  try { return iconv.decode(buf, enc); } catch { return iconv.decode(buf, 'win1252'); }
}

// Devuelve { type: 'html' | 'text', content }
function getBody(msg) {
  const html = safe(() => msg.bodyHTML);
  if (html && html.trim()) return { type: 'html', content: html };
  const rtf = safe(() => msg.bodyRTF);
  if (rtf && /\\fromhtml1/.test(rtf.slice(0, 2000))) {
    try {
      const r = deEncapsulateSync(rtf, { decode: rtfDecode, mode: 'either' });
      if (r && r.text) return { type: r.mode === 'html' ? 'html' : 'text', content: String(r.text) };
    } catch { /* continuar */ }
  }
  const text = safe(() => msg.body);
  if (text && text.trim()) return { type: 'text', content: text };
  if (rtf) {
    try {
      const r = deEncapsulateSync(rtf, { decode: rtfDecode, mode: 'either' });
      if (r && r.text) return { type: r.mode === 'html' ? 'html' : 'text', content: String(r.text) };
    } catch { /* RTF real */ }
    return { type: 'text', content: rtfToText(rtf) };
  }
  return { type: 'text', content: '' };
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", iexcl: '¡', iquest: '¿', ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', uuml: 'ü', Uuml: 'Ü', ordm: 'º', ordf: 'ª', euro: '€', copy: '©', reg: '®', middot: '·', laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[e] ?? m;
  });
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(head|style|script|title|xml)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h\d|table|blockquote)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function bodyText(msg) {
  const b = getBody(msg);
  return b.type === 'html' ? htmlToText(b.content) : b.content;
}

// ---------- adjuntos ----------

const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
  tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', txt: 'text/plain', csv: 'text/csv', htm: 'text/html', html: 'text/html',
  xml: 'application/xml', json: 'application/json', zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  msg: 'application/vnd.ms-outlook', eml: 'message/rfc822', ics: 'text/calendar', vcf: 'text/vcard', mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav',
};

const extOf = (name) => {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
};

function listAttachments(msg) {
  const out = [];
  const n = safe(() => msg.numberOfAttachments, 0);
  for (let i = 0; i < n; i++) {
    const a = safe(() => msg.getAttachment(i), null);
    if (!a) continue;
    const method = safe(() => a.attachMethod, 1);
    const embedded = method === ATTACH_EMBEDDED;
    let name = safe(() => a.longFilename) || safe(() => a.filename) || safe(() => a.displayName);
    let embSubject = '';
    if (embedded) {
      embSubject = safe(() => a.embeddedPSTMessage.subject);
      name = name || embSubject || 'Mensaje adjunto';
      if (!/\.(eml|msg)$/i.test(name)) name += '.eml';
    }
    name = name || `adjunto-${i + 1}`;
    const ext = extOf(name);
    let mime = embedded ? 'message/rfc822' : (safe(() => a.mimeTag) || MIME[ext] || 'application/octet-stream').toLowerCase();
    if (mime === 'application/octet-stream' && MIME[ext]) mime = MIME[ext];
    out.push({
      idx: i,
      name,
      ext,
      size: safe(() => a.filesize, 0) || safe(() => a.size, 0),
      mime,
      cid: (safe(() => a.contentId) || '').replace(/^<|>$/g, ''),
      embedded,
      embSubject,
      hidden: !!safe(() => a.isAttachmentInvisibleInHtml, false),
      byReference: method >= 2 && method <= 4,
    });
  }
  return out;
}

// Marca como "en línea" las imágenes referenciadas desde el HTML (cid:)
function markInline(atts, html) {
  for (const a of atts) {
    if (a.cid && !a.embedded && html.includes(`cid:${a.cid}`)) a.hidden = true;
  }
  return atts;
}

const toNum = (v) => (v && typeof v.toNumber === 'function' ? v.toNumber() : Number(v) || 0);

function readAttachmentData(msg, idx) {
  const a = msg.getAttachment(idx);
  const s = safe(() => a.fileInputStream, null);
  if (!s) return Buffer.alloc(0);
  const buf = Buffer.alloc(s.length.toNumber());
  s.readCompletely(buf);
  return buf;
}

module.exports = {
  safe, openPst, loadObject, loadMessage, folderChildIds, parseRef, NotFound,
  senderOf, recipientsOf, fmtAddr, fmtList, messageDate,
  normalizeSubject, convKeyOf,
  getBody, htmlToText, bodyText, rtfToText, decodeEntities,
  listAttachments, markInline, readAttachmentData, toNum, extOf, MIME, ATTACH_EMBEDDED,
};
