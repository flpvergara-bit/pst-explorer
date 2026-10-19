'use strict';
// PST Explorer — servidor local. Solo escucha en 127.0.0.1.
// Trabaja con una biblioteca de varios PST: cada uno tiene su índice, una cola
// los indexa de a uno en segundo plano y las búsquedas recorren todos a la vez.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, fork } = require('child_process');
const express = require('express');
const { ZipArchive } = require('archiver');
const MailComposer = require('nodemailer/lib/mail-composer');
const R = require('./src/pstreader');
const Q = require('./src/query');
const { Library, scanFolder, MAX_ACTIVE } = require('./src/library');
const { Readers } = require('./src/readers');

// Modo escritorio: el servidor corre como utilityProcess de Electron (ver electron/main.js)
const DESKTOP = !!process.parentPort;
// PORT=0 escucha en un puerto libre (el real se informa al proceso principal)
const PORT = process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 8765;
let port = PORT;
// PSTX_DATA permite usar otra carpeta de datos (p. ej. la de la app de escritorio, o pruebas)
const DATA_DIR = process.env.PSTX_DATA ? path.resolve(process.env.PSTX_DATA) : path.join(__dirname, 'data');
// Token de sesión: si está definido, toda petición debe traerlo (cookie "pstx" o cabecera)
const TOKEN = process.env.PSTX_TOKEN || '';
// Los procesos hijos (indexador, consolidación) corren con el Node de Electron
const CHILD_ENV = DESKTOP ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
const toMain = (m) => { if (DESKTOP) process.parentPort.postMessage(m); };

const lib = new Library(DATA_DIR);
lib.reconnect();
const readers = new Readers(lib);

const conn = () => lib.conn;
const active = () => lib.active;
const fileName = (fid) => (lib.byId(fid) || {}).name || `archivo ${fid}`;
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

// ================================================================ cola de indexado

const J = {
  child: null, // proceso indexador en curso
  job: null, // { fileId, phase, startedAt, doneAtStart }
  progress: new Map(), // fileId -> último avance informado
  restarts: new Map(),
  failed: new Map(), // fileId -> mensaje de error (no se reintenta hasta reiniciar)
  consolidating: null,
  consolidatePending: false,
  lastConsolidation: null,
};

function fileStatus(f) {
  const m = lib.meta(f);
  return {
    complete: m.complete === '1',
    attComplete: m.att_complete === '1',
    indexed: Number(m.indexed) || 0,
    total: Number(m.total) || 0,
    errors: Number(m.errors) || 0,
    attIndexed: Number(m.att_indexed) || 0,
  };
}

function schedule() {
  if (J.child || lib.paused) return;
  const cands = lib.files.filter((f) => f.enabled && !J.failed.has(f.id) && lib.exists(f));
  const st = new Map(cands.map((f) => [f.id, fileStatus(f)]));
  // primero los correos de todos los archivos (del más chico al más grande), luego el contenido de adjuntos
  let phase = 'messages';
  let next = cands.filter((f) => !st.get(f.id).complete).sort((a, b) => a.size - b.size)[0];
  if (!next) {
    phase = 'attachments';
    next = cands.filter((f) => !st.get(f.id).attComplete).sort((a, b) => a.size - b.size)[0];
  }
  if (!next) { J.job = null; return; }
  startJob(next, phase, false);
}

function startJob(f, phase, careful) {
  const child = fork(path.join(__dirname, 'src', 'indexer.js'), [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--max-old-space-size=4096'], env: CHILD_ENV,
  });
  J.child = child;
  J.job = { fileId: f.id, phase, startedAt: Date.now(), careful };
  const P = { stage: 'starting', done: 0, total: 0, attDone: 0, attTotal: 0, errors: 0, folder: '', recovered: J.restarts.get(f.id) || 0 };
  J.progress.set(f.id, P);
  let finished = false;
  let failure = null;
  child.send({ pstPath: f.path, dbPath: lib.dbPath(f), careful, phase });
  child.on('message', (m) => {
    if (J.child !== child) return;
    if (m.type === 'folders') {
      Object.assign(P, { stage: 'indexing', total: m.total, done: m.done });
      J.job.doneAtStart = m.done;
      J.job.rateFrom = Date.now();
    } else if (m.type === 'progress') Object.assign(P, { done: m.done, total: m.total, errors: m.errors, folder: m.folder });
    else if (m.type === 'phase') {
      P.stage = m.phase;
      if (m.attTotal != null) {
        Object.assign(P, { attTotal: m.attTotal, attDone: m.attDone });
        J.job.doneAtStart = m.attDone;
        J.job.rateFrom = Date.now();
      }
    } else if (m.type === 'messagesDone') Object.assign(P, { stage: 'finalizing', done: m.done, total: m.total, errors: m.errors, folder: '' });
    else if (m.type === 'attProgress') Object.assign(P, { attDone: m.attDone, attTotal: m.attTotal });
    else if (m.type === 'done') finished = true;
    else if (m.type === 'error') failure = m.error;
  });
  child.on('exit', (code, signal) => {
    if (J.child !== child) return; // detenido a propósito
    J.child = null;
    J.job = null;
    if (finished) {
      J.restarts.delete(f.id);
      J.progress.delete(f.id);
      if (phase === 'messages') requestConsolidation();
    } else if (failure) {
      J.failed.set(f.id, failure);
      console.error(`Error indexando ${f.name}: ${failure}`);
    } else {
      // caída del lector (p. ej. un elemento dañado): reanudar en modo cuidadoso
      const n = (J.restarts.get(f.id) || 0) + 1;
      J.restarts.set(f.id, n);
      console.error(`Indexador detenido en ${f.name} (código ${code ?? signal}); reanudando en modo cuidadoso (${n})…`);
      if (n <= 25) return startJob(f, phase, true);
      J.failed.set(f.id, 'El indexador se detuvo demasiadas veces. Puede que el archivo esté muy dañado.');
    }
    schedule();
  });
}

function stopJob(fileId) {
  if (!J.child || (fileId != null && J.job && J.job.fileId !== fileId)) return false;
  const c = J.child;
  J.child = null;
  J.job = null;
  c.kill();
  return true;
}

// Consolidación: copias repetidas entre respaldos y conversaciones globales
function requestConsolidation() {
  if (J.consolidating) { J.consolidatePending = true; return; }
  const files = active().map((a) => ({ id: a.id, dbPath: lib.dbPath(lib.byId(a.id)) }));
  const sig = librarySignature();
  const child = fork(path.join(__dirname, 'src', 'consolidate.js'), [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--max-old-space-size=4096'], env: CHILD_ENV,
  });
  J.consolidating = { startedAt: Date.now() };
  child.send({ libDbPath: lib.libDbPath, files, sig });
  child.on('message', (m) => {
    if (m.type === 'done') J.lastConsolidation = { ...m.stats, at: Date.now() };
    if (m.type === 'error') console.error('Error al consolidar:', m.error);
  });
  child.on('exit', () => {
    J.consolidating = null;
    if (J.consolidatePending) { J.consolidatePending = false; requestConsolidation(); }
  });
}

// Firma de la biblioteca: archivos activos y cuántos correos tiene indexados cada uno
const librarySignature = () => active().map((a) => `${a.id}:${fileStatus(lib.byId(a.id)).indexed}`).join(',');

// ¿la consolidación guardada corresponde a los archivos activos actuales?
function consolidationStale() {
  try {
    const r = conn().prepare("SELECT v FROM main.meta WHERE k = 'sig'").get();
    return !r || r.v !== librarySignature();
  } catch {
    return true;
  }
}

function libraryChanged() {
  readers.closeAll();
  lib.reconnect();
  unreadCache.clear();
  requestConsolidation();
  schedule();
}

// ================================================================ utilidades HTTP

const app = express();
app.disable('x-powered-by');

const hasToken = (req) => {
  if (!TOKEN) return true;
  if (req.headers['x-pstx-token'] === TOKEN) return true;
  return (req.headers.cookie || '').split(/;\s*/).some((c) => c === `pstx=${TOKEN}`);
};

// Protección contra DNS rebinding, peticiones de otros orígenes y (en escritorio) de otros programas
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) return res.status(403).send('Host no permitido');
  if (!hasToken(req)) return res.status(403).send('Acceso no autorizado');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!req.is('application/json')) return res.status(415).send('Se requiere JSON');
    const origin = req.headers.origin;
    if (origin && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`) return res.status(403).send('Origen no permitido');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json());

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    res.status(e.status || 500).json({ error: e.message || String(e) });
  }
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function safeName(name, max = 120) {
  let n = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  if (n.length > max) {
    const ext = R.extOf(n);
    n = ext && ext.length < 10 ? n.slice(0, max - ext.length - 1).trim() + '.' + ext : n.slice(0, max).trim();
  }
  return n || 'sin_nombre';
}

function contentDisposition(type, name) {
  const ascii = safeName(name).replace(/[^\x20-\x7e]/g, '_').replace(/[";]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function uniqueName(set, name) {
  let n = name;
  let i = 2;
  while (set.has(n.toLowerCase())) {
    const ext = R.extOf(name);
    n = ext ? `${name.slice(0, -(ext.length + 1))} (${i}).${ext}` : `${name} (${i})`;
    i++;
  }
  set.add(n.toLowerCase());
  return n;
}

const pad = (n) => String(n).padStart(2, '0');
function fmtDate(ms, withTime = true) {
  if (ms == null) return '';
  const d = new Date(ms);
  const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}` : s;
}
function fmtDateLong(ms) {
  if (ms == null) return '';
  return new Date(ms).toLocaleString('es-CL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const intParam = (v, def, max) => Math.min(Math.max(Number.parseInt(v, 10) || def, 0), max);
const aliasOf = (fid) => {
  const a = active().find((x) => x.id === fid);
  if (!a) throw httpError(404, 'El archivo no está activo en la biblioteca');
  return a.alias;
};
const withRefs = (rows) => rows.map((r) => ({ ...r, ref: `${r.src}-${r.id ?? r.msg_id}` }));

// ================================================================ detalle de mensaje

function indexRow(ref) {
  const p = Q.parseMsgRef(ref);
  if (!p) throw httpError(404, 'Referencia inválida');
  const A = aliasOf(p.f);
  const row = conn().prepare(`SELECT m.*, fo.path AS folder FROM ${A}.messages m LEFT JOIN ${A}.folders fo ON fo.id = m.folder_id WHERE m.id = ?`).get(p.nid);
  return { p, A, row };
}

function messageInfo(ref) {
  const { p, A, row } = indexRow(ref);
  const conv = row && row.conv_key ? conn().prepare('SELECT n FROM main.gconvs WHERE conv_key = ?').get(row.conv_key) : null;
  const cp = conn().prepare('SELECT others FROM main.copies WHERE f = ? AND id = ?').get(p.f, p.nid);
  const common = {
    ref: String(ref),
    file: { id: p.f, name: fileName(p.f) },
    embedded: p.ref.includes('.'),
    folder: !p.ref.includes('.') && row ? row.folder : '',
    convKey: row ? row.conv_key : null,
    convCount: conv ? conv.n : 1,
    alsoIn: cp && cp.others ? cp.others.split(',').map(Number).map((id) => ({ id, name: fileName(id) })) : [],
  };
  let msg;
  try {
    msg = readers.message(ref);
  } catch (e) {
    if (e.status !== 410 || !row || common.embedded) throw e;
    // El PST no está disponible (p. ej. disco desconectado): mostrar lo que hay en el índice
    const atts = conn().prepare(`SELECT idx, name, ext, size, mime, cid, embedded, hidden FROM ${A}.attachments WHERE msg_id = ? ORDER BY idx`).all(p.nid);
    const split = (s) => (s || '').split(/;\s*/).filter(Boolean).map((x) => {
      const mm = /^(.*?)\s*<([^>]+)>$/.exec(x);
      return mm ? { name: mm[1], email: mm[2] } : { name: x, email: '' };
    });
    return {
      ...common, unavailable: e.message, subject: row.subject, from: { name: row.sender_name, email: row.sender_email },
      to: split(row.to_text), cc: split(row.cc_text), bcc: split(row.bcc_text), date: row.date, msgClass: row.msg_class,
      importance: row.importance, size: row.size, messageId: row.message_id, bodyType: 'text', remoteImages: false, hasHeaders: false,
      attachments: atts.map((a) => ({ ...a, embedded: !!a.embedded, hidden: !!a.hidden, byReference: false })),
    };
  }
  const body = R.getBody(msg);
  const atts = R.listAttachments(msg);
  if (body.type === 'html') R.markInline(atts, body.content);
  return {
    ...common,
    subject: R.safe(() => msg.subject),
    from: R.senderOf(msg),
    onBehalf: R.safe(() => msg.sentRepresentingName),
    ...R.recipientsOf(msg),
    date: R.messageDate(msg),
    msgClass: R.safe(() => msg.messageClass),
    importance: R.safe(() => msg.importance, 1),
    size: R.toNum(R.safe(() => msg.messageSize, 0)),
    messageId: R.safe(() => msg.internetMessageId),
    bodyType: body.type,
    remoteImages: body.type === 'html' && /(?:src|background)\s*=\s*["']?\s*https?:|url\(\s*["']?https?:/i.test(body.content),
    hasHeaders: !!R.safe(() => msg.transportMessageHeaders),
    attachments: atts,
    location: R.safe(() => msg.location),
  };
}

// HTML del cuerpo listo para mostrarse aislado (iframe sandbox) o imprimirse
function bodyHtml(ref, { forPrint = false } = {}) {
  let msg;
  try {
    msg = readers.message(ref);
  } catch (e) {
    if (e.status !== 410) throw e;
    const { row } = indexRow(ref);
    return `<div style="padding:10px;border:1px solid #d0d7de;border-radius:6px;background:#fff8c5;margin-bottom:12px">
      ⚠ ${esc(e.message)}<br>Se muestra el inicio del texto guardado en el índice.</div><pre class="pst-plain">${esc(row ? row.snippet : '')}…</pre>`;
  }
  const body = R.getBody(msg);
  const atts = R.listAttachments(msg);
  const base = `/api/message/${encodeURIComponent(ref)}/att/`;
  if (body.type !== 'html') {
    const linked = esc(body.content).replace(/\bhttps?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    return `<pre class="pst-plain">${linked}</pre>`;
  }
  let html = body.content;
  // imágenes en línea cid: -> URL local del adjunto
  html = html.replace(/(["'(=]\s*)cid:([^"')\s>]+)/gi, (m, pre, cid) => {
    let c;
    try { c = decodeURIComponent(cid); } catch { c = cid; }
    c = c.replace(/^<|>$/g, '').toLowerCase();
    const a = atts.find((x) => x.cid && x.cid.toLowerCase() === c) || atts.find((x) => x.name.toLowerCase() === c);
    return a ? `${pre}${base}${a.idx}?inline=1` : m;
  });
  // limpieza: scripts, meta refresh, base, formularios y manejadores (el CSP también los bloquea)
  html = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(meta|base|link)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*/gi, '$1=$2#');
  if (forPrint) html = html.replace(/<\/?template/gi, (t) => t.replace('<', '&lt;'));
  return html;
}

const BODY_STYLE = `
  html,body{margin:0;padding:0;background:#fff;color:#1f2328}
  body{font:14px/1.5 "Segoe UI",Calibri,Arial,sans-serif;padding:16px;word-wrap:break-word;overflow-wrap:anywhere}
  pre.pst-plain{white-space:pre-wrap;font:14px/1.5 "Segoe UI",Calibri,Arial,sans-serif;margin:0}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  blockquote{margin-left:.5em;padding-left:.8em;border-left:3px solid #d0d7de;color:#444}`;

function csp(remoteImages, nonce) {
  return [
    "default-src 'none'",
    `img-src 'self' data:${remoteImages ? ' http: https:' : ''}`,
    `style-src 'self' 'unsafe-inline'${remoteImages ? ' http: https:' : ''}`,
    `font-src 'self' data:${remoteImages ? ' http: https:' : ''}`,
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
  ].join('; ');
}

// ================================================================ MIME / EML

async function buildEml(msg) {
  const from = R.senderOf(msg);
  const rc = R.recipientsOf(msg);
  const body = R.getBody(msg);
  const atts = R.listAttachments(msg);
  if (body.type === 'html') R.markInline(atts, body.content);
  const addr = (a) => ({ name: a.name || a.email, address: a.email || 'desconocido@invalid' });
  const attachments = [];
  for (const a of atts) {
    if (a.embedded) {
      const emb = R.safe(() => msg.getAttachment(a.idx).embeddedPSTMessage, null);
      if (emb) attachments.push({ filename: a.name.replace(/\.msg$/i, '.eml'), content: await buildEml(emb), contentType: 'message/rfc822' });
    } else if (!a.byReference) {
      attachments.push({ filename: a.name, content: R.readAttachmentData(msg, a.idx), contentType: a.mime, cid: a.cid || undefined });
    }
  }
  const date = R.messageDate(msg);
  const mail = new MailComposer({
    from: addr(from),
    to: rc.to.map(addr),
    cc: rc.cc.map(addr),
    bcc: rc.bcc.map(addr),
    subject: R.safe(() => msg.subject),
    date: date ? new Date(date) : undefined,
    messageId: R.safe(() => msg.internetMessageId) || undefined,
    inReplyTo: R.safe(() => msg.inReplyToId) || undefined,
    [body.type === 'html' ? 'html' : 'text']: body.content,
    attachments,
    keepBcc: true,
  });
  return new Promise((resolve, reject) => mail.compile().build((err, buf) => (err ? reject(err) : resolve(buf))));
}

// ================================================================ ZIP en streaming

function startZip(res, name) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition('attachment', name));
  const zip = new ZipArchive({ zlib: { level: 1 } });
  zip.on('warning', () => {});
  zip.on('error', () => res.destroy());
  zip.pipe(res);
  let aborted = false;
  res.on('close', () => { aborted = !res.writableFinished; });
  const add = (data, entryName, date) => new Promise((resolve) => {
    zip.once('entry', resolve);
    zip.append(data, { name: entryName, date: date ? new Date(date) : undefined });
  });
  return { zip, add, isAborted: () => aborted };
}

function msgFolderName(row) {
  return safeName(`${fmtDate(row.date).replace(':', 'h').replace(' ', '_')} - ${row.subject || '(sin asunto)'} - ${row.sender_name || ''}`, 110);
}

// Datos de la importación desde una versión anterior (los escribe electron/migrate.js)
function readMigration() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'migration.json'), 'utf8')); } catch { return null; }
}

// ================================================================ API: biblioteca

app.get('/api/state', wrap(async (req, res) => {
  const files = lib.files.map((f) => {
    const st = fileStatus(f);
    const isActive = active().some((a) => a.id === f.id);
    const job = J.job && J.job.fileId === f.id ? J.job : null;
    const P = job ? J.progress.get(f.id) : null;
    let eta = null;
    if (job && P && job.rateFrom) {
      const elapsed = (Date.now() - job.rateFrom) / 1000;
      const doneNow = job.phase === 'messages' ? P.done : P.attDone;
      const totalNow = job.phase === 'messages' ? P.total : P.attTotal;
      const rate = (doneNow - (job.doneAtStart || 0)) / elapsed;
      if (elapsed > 15 && rate > 0) eta = Math.round((totalNow - doneNow) / rate);
    }
    return {
      id: f.id, name: f.name, path: f.path, size: f.size, enabled: f.enabled, exists: lib.exists(f), active: isActive,
      overLimit: (lib.overLimit || []).includes(f.id), status: st, failed: J.failed.get(f.id) || null,
      job: job ? { phase: job.phase, careful: job.careful, ...P, eta } : null,
    };
  });
  res.json({
    files,
    paused: lib.paused,
    indexing: !!J.job,
    consolidating: !!J.consolidating,
    lastConsolidation: J.lastConsolidation,
    totals: { messages: files.filter((f) => f.active).reduce((s, f) => s + f.status.indexed, 0) },
    maxActive: MAX_ACTIVE,
    desktop: DESKTOP,
    dataDir: DATA_DIR,
    migration: readMigration(),
  });
}));

app.post('/api/library/add', wrap(async (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path];
  const r = lib.add(paths.filter(Boolean));
  if (r.added.length) libraryChanged();
  res.json(r);
}));

app.post('/api/library/add-folder', wrap(async (req, res) => {
  const dir = String(req.body.dir || '');
  if (!dir || !fs.existsSync(dir)) throw httpError(400, 'La carpeta no existe');
  const found = scanFolder(dir);
  const r = lib.add(found);
  if (r.added.length) libraryChanged();
  res.json({ ...r, found: found.length });
}));

app.post('/api/library/remove', wrap(async (req, res) => {
  const id = Number(req.body.id);
  stopJob(id);
  readers.close(id);
  if (!lib.remove(id, !!req.body.deleteIndex)) throw httpError(404, 'No existe');
  J.failed.delete(id);
  libraryChanged();
  res.json({ ok: true });
}));

app.post('/api/library/enable', wrap(async (req, res) => {
  const f = lib.byId(req.body.id);
  if (!f) throw httpError(404, 'No existe');
  f.enabled = !!req.body.enabled;
  lib.save();
  if (!f.enabled) stopJob(f.id);
  libraryChanged();
  res.json({ ok: true });
}));

app.post('/api/library/reindex', wrap(async (req, res) => {
  const f = lib.byId(req.body.id);
  if (!f) throw httpError(404, 'No existe');
  stopJob(f.id);
  readers.close(f.id);
  J.failed.delete(f.id);
  J.restarts.delete(f.id);
  lib.conn.close(); // soltar el índice para poder borrarlo
  lib.conn = null;
  lib.resetIndex(f);
  libraryChanged();
  res.json({ ok: true });
}));

app.post('/api/library/retry', wrap(async (req, res) => {
  J.failed.delete(Number(req.body.id));
  J.restarts.delete(Number(req.body.id));
  schedule();
  res.json({ ok: true });
}));

app.post('/api/library/pause', wrap(async (req, res) => {
  lib.paused = !!req.body.paused;
  lib.save();
  if (lib.paused) stopJob();
  else schedule();
  res.json({ ok: true, paused: lib.paused });
}));

// Diálogos nativos de Windows para elegir archivos o una carpeta
app.post('/api/library/pick', wrap(async (req, res) => {
  if (process.platform !== 'win32') throw httpError(501, 'Solo disponible en Windows');
  const folder = req.body.mode === 'folder';
  const ps = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
    ${folder ? `
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = 'Carpeta que contiene los archivos PST/OST'
    if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath }` : `
    $d = New-Object System.Windows.Forms.OpenFileDialog
    $d.Title = 'Agregar archivos de datos de Outlook'
    $d.Multiselect = $true
    $d.Filter = 'Archivos de Outlook (*.pst;*.ost)|*.pst;*.ost|Todos los archivos (*.*)|*.*'
    if ($d.ShowDialog($owner) -eq 'OK') { $d.FileNames -join [char]10 }`}`;
  execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { timeout: 10 * 60 * 1000, encoding: 'utf8' }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'No se pudo abrir el diálogo: ' + err.message });
    const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    res.json(folder ? { dir: lines[0] || null } : { paths: lines });
  });
}));

// Explorador de carpetas (alternativa al diálogo nativo)
app.get('/api/browse', wrap(async (req, res) => {
  let dir = String(req.query.dir || '');
  if (!dir) {
    if (process.platform === 'win32') {
      const drives = [];
      for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) drives.push({ name: `${l}:\\`, path: `${l}:\\`, dir: true });
      const home = require('os').homedir();
      return res.json({ dir: '', parent: null, entries: [{ name: 'Documentos', path: path.join(home, 'Documents'), dir: true }, { name: 'Descargas', path: path.join(home, 'Downloads'), dir: true }, { name: 'Escritorio', path: path.join(home, 'Desktop'), dir: true }, ...drives] });
    }
    dir = '/';
  }
  dir = path.resolve(dir);
  const entries = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('$')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) entries.push({ name: e.name, path: full, dir: true });
    else if (/\.(pst|ost)$/i.test(e.name)) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* */ }
      entries.push({ name: e.name, path: full, dir: false, size });
    }
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  const parent = path.dirname(dir);
  res.json({ dir, parent: parent === dir ? '' : parent, entries });
}));

// ================================================================ API: datos

const unreadCache = new Map(); // fid -> { indexed, map }
app.get('/api/folders', wrap(async (req, res) => {
  const out = [];
  const files = [];
  for (const a of active()) {
    const f = lib.byId(a.id);
    const st = fileStatus(f);
    files.push({ id: f.id, name: f.name, indexed: st.indexed, total: st.total, complete: st.complete, exists: lib.exists(f) });
    let uc = unreadCache.get(f.id);
    if (!uc || uc.indexed !== st.indexed) {
      uc = { indexed: st.indexed, map: new Map(conn().prepare(`SELECT folder_id, COUNT(*) AS n FROM ${a.alias}.messages WHERE is_read = 0 GROUP BY folder_id`).all().map((r) => [r.folder_id, r.n])) };
      unreadCache.set(f.id, uc);
    }
    for (const r of conn().prepare(`SELECT id, parent_id, name, path, depth, total, indexed, cls FROM ${a.alias}.folders ORDER BY ord`).all()) {
      out.push({ ...r, id: `${f.id}:${r.id}`, parent_id: r.parent_id == null ? null : `${f.id}:${r.parent_id}`, file: f.id, unread: uc.map.get(r.id) || 0 });
    }
  }
  res.json({ files, folders: out });
}));

const listOpts = (q) => ({
  limit: intParam(q.limit, 200, 1000),
  offset: intParam(q.offset, 0, 1e9),
  count: q.count !== '0',
});

app.get('/api/messages', wrap(async (req, res) => {
  const r = Q.messages(conn(), active(), req.query, listOpts(req.query));
  res.json({ ...r, rows: withRefs(r.rows) });
}));

app.get('/api/threads', wrap(async (req, res) => {
  const r = Q.threads(conn(), active(), req.query, listOpts(req.query));
  res.json({ ...r, rows: withRefs(r.rows) });
}));

app.get('/api/attachments', wrap(async (req, res) => {
  const r = Q.attachments(conn(), active(), req.query, listOpts(req.query));
  res.json({ ...r, rows: withRefs(r.rows) });
}));

// Conteo exacto (puede tardar unos segundos con búsquedas muy amplias)
app.get('/api/count', wrap(async (req, res) => {
  const fn = { threads: Q.threads, attachments: Q.attachments }[req.query.view] || Q.messages;
  res.json({ total: fn(conn(), active(), req.query, { exact: true }).total });
}));

app.get('/api/thread', wrap(async (req, res) => {
  const rows = Q.thread(conn(), active(), String(req.query.key || ''), { dups: req.query.dups === '1' });
  // copias del mismo correo (mismo Message-ID) dentro de un mismo archivo
  const seen = new Map();
  for (const r of rows) {
    r.ref = `${r.src}-${r.id}`;
    r.fileName = fileName(r.src);
    if (r.message_id) {
      if (seen.has(r.message_id)) r.duplicateOf = seen.get(r.message_id);
      else seen.set(r.message_id, r.ref);
    }
  }
  res.json({ key: req.query.key, rows });
}));

app.get('/api/message/:ref', wrap(async (req, res) => {
  res.json(messageInfo(req.params.ref));
}));

app.get('/api/message/:ref/headers', wrap(async (req, res) => {
  res.type('text/plain; charset=utf-8').send(R.safe(() => readers.message(req.params.ref).transportMessageHeaders) || '(sin encabezados de Internet)');
}));

app.get('/api/message/:ref/body', wrap(async (req, res) => {
  const images = req.query.images === '1';
  const html = bodyHtml(req.params.ref);
  res.setHeader('Content-Security-Policy', csp(images));
  res.type('text/html; charset=utf-8').send(
    `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${BODY_STYLE}</style></head><body>${html}</body></html>`,
  );
}));

app.get('/api/message/:ref/att/:idx', wrap(async (req, res) => {
  const msg = readers.message(req.params.ref);
  const idx = Number(req.params.idx);
  const a = R.listAttachments(msg).find((x) => x.idx === idx);
  if (!a) throw httpError(404, 'Adjunto no encontrado');
  let data;
  let mime = a.mime;
  let name = a.name;
  if (a.embedded) {
    data = await buildEml(msg.getAttachment(idx).embeddedPSTMessage);
    mime = 'message/rfc822';
    name = name.replace(/\.msg$/i, '.eml');
  } else {
    data = R.readAttachmentData(msg, idx);
  }
  // Solo se muestran en el navegador tipos que no pueden ejecutar código
  const inlineOk = /^image\/(png|jpe?g|gif|bmp|webp)$/.test(mime) || mime === 'application/pdf' || mime === 'text/plain';
  const inline = req.query.inline === '1' && inlineOk;
  res.setHeader('Content-Type', inline ? (mime === 'text/plain' ? 'text/plain; charset=utf-8' : mime) : 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', name));
  if (inline && mime !== 'application/pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.end(data);
}));

app.get('/api/message/:ref/eml', wrap(async (req, res) => {
  const msg = readers.message(req.params.ref);
  const buf = await buildEml(msg);
  const d = R.messageDate(msg);
  res.setHeader('Content-Type', 'message/rfc822');
  res.setHeader('Content-Disposition', contentDisposition('attachment', safeName(`${fmtDate(d, false)} ${R.safe(() => msg.subject) || 'correo'}`) + '.eml'));
  res.end(buf);
}));

// ZIP con los adjuntos de un mensaje
app.get('/api/message/:ref/attachments.zip', wrap(async (req, res) => {
  const msg = readers.message(req.params.ref);
  const body = R.getBody(msg);
  const atts = R.listAttachments(msg);
  if (body.type === 'html') R.markInline(atts, body.content);
  const z = startZip(res, safeName(`Adjuntos - ${R.safe(() => msg.subject) || 'correo'}`) + '.zip');
  const names = new Set();
  for (const a of atts) {
    if (z.isAborted()) break;
    if ((a.hidden && req.query.inline !== '1') || a.byReference) continue;
    const data = a.embedded ? await buildEml(msg.getAttachment(a.idx).embeddedPSTMessage) : R.readAttachmentData(msg, a.idx);
    await z.add(data, uniqueName(names, safeName(a.embedded ? a.name.replace(/\.msg$/i, '.eml') : a.name)));
  }
  await z.zip.finalize();
}));

// ================================================================ exportaciones masivas

// Todas las filas que cumplen los filtros (para exportar)
function selectRows(q) {
  return Q.messages(conn(), active(), q, { limit: null }).rows;
}
// Agrupa por archivo para no alternar continuamente entre PST al leerlos
const byFile = (rows) => [...rows].sort((a, b) => (a.src - b.src) || ((a.date || 0) - (b.date || 0)));

app.get('/api/export/csv', wrap(async (req, res) => {
  const rows = selectRows(req.query);
  const folders = new Map();
  const attStmt = new Map();
  for (const a of active()) {
    for (const f of conn().prepare(`SELECT id, path FROM ${a.alias}.folders`).all()) folders.set(`${a.id}:${f.id}`, f.path);
    attStmt.set(a.id, conn().prepare(`SELECT group_concat(name, ' | ') AS n FROM ${a.alias}.attachments WHERE msg_id = ? AND (hidden = 0 OR embedded = 1)`));
  }
  const cell = (v) => {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['Fecha', 'De', 'Correo remitente', 'Para', 'CC', 'Asunto', 'Archivo PST', 'Carpeta', 'N° adjuntos', 'Adjuntos', 'Tamaño (KB)', 'Tipo', 'ID'].join(';')];
  for (const r of rows) {
    lines.push([fmtDate(r.date), r.sender_name, r.sender_email, r.to_text, r.cc_text, r.subject, fileName(r.src), folders.get(`${r.src}:${r.folder_id}`),
      r.att_count, r.att_count ? attStmt.get(r.src).get(r.id).n : '', Math.round((r.size || 0) / 1024), r.msg_class, `${r.src}-${r.id}`].map(cell).join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition('attachment', `Listado correos ${fmtDate(Date.now(), false)}.csv`));
  res.end('﻿' + lines.join('\r\n'));
}));

// Adjuntos de los correos filtrados (o de un hilo, o una selección) en un ZIP
app.get('/api/export/attachments.zip', wrap(async (req, res) => {
  const q = { ...req.query, att: '1' };
  // pairs=fid-nid:idx,... -> solo esos adjuntos (selección manual en la vista de adjuntos)
  let only = null;
  if (req.query.pairs) {
    only = new Map();
    for (const pr of String(req.query.pairs).split(',').slice(0, 20000)) {
      const m = /^(\d+-\d+):(\d+)$/.exec(pr);
      if (!m) continue;
      if (!only.has(m[1])) only.set(m[1], new Set());
      only.get(m[1]).add(Number(m[2]));
    }
    q.ids = [...only.keys()].join(',');
    delete q.q;
    q.dups = '1';
  }
  const rows = byFile(selectRows(q));
  const flat = req.query.flat === '1';
  const multi = new Set(rows.map((r) => r.src)).size > 1;
  const exts = req.query.ext ? String(req.query.ext).toLowerCase().split(',').map((s) => s.trim().replace(/^\./, '')) : null;
  const z = startZip(res, req.query.name ? safeName(req.query.name) + '.zip' : `Adjuntos ${fmtDate(Date.now(), false)}.zip`);
  const names = new Set();
  for (const r of rows) {
    if (z.isAborted()) break;
    const ref = `${r.src}-${r.id}`;
    let msg;
    try { msg = readers.message(ref); } catch { continue; }
    const body = R.getBody(msg);
    const atts = R.listAttachments(msg);
    if (body.type === 'html') R.markInline(atts, body.content);
    const dir = flat ? '' : `${multi ? safeName(fileName(r.src).replace(/\.(pst|ost)$/i, ''), 60) + '/' : ''}${msgFolderName(r)}/`;
    for (const a of atts) {
      if (only ? !only.get(ref).has(a.idx) : a.hidden) continue;
      if (a.byReference || (exts && !exts.includes(a.ext))) continue;
      if (z.isAborted()) break;
      try {
        const data = a.embedded ? await buildEml(msg.getAttachment(a.idx).embeddedPSTMessage) : R.readAttachmentData(msg, a.idx);
        const base = safeName(a.embedded ? a.name.replace(/\.msg$/i, '.eml') : a.name);
        await z.add(data, uniqueName(names, dir + (flat ? `${fmtDate(r.date, false)} ${base}` : base)), r.date);
      } catch { /* adjunto ilegible: se omite */ }
    }
  }
  await z.zip.finalize();
}));

// Correos filtrados (o un hilo) como archivos .eml en un ZIP
app.get('/api/export/eml.zip', wrap(async (req, res) => {
  const rows = byFile(selectRows(req.query));
  const folders = new Map();
  for (const a of active()) for (const f of conn().prepare(`SELECT id, path FROM ${a.alias}.folders`).all()) folders.set(`${a.id}:${f.id}`, f.path);
  const z = startZip(res, req.query.name ? safeName(req.query.name) + '.zip' : `Correos ${fmtDate(Date.now(), false)}.zip`);
  const names = new Set();
  for (const r of rows) {
    if (z.isAborted()) break;
    try {
      const msg = readers.message(`${r.src}-${r.id}`);
      const fpath = [fileName(r.src).replace(/\.(pst|ost)$/i, ''), ...(folders.get(`${r.src}:${r.folder_id}`) || '').split('/')]
        .filter(Boolean).map((s) => safeName(s, 60)).join('/');
      await z.add(await buildEml(msg), uniqueName(names, `${fpath}/${msgFolderName(r)}.eml`), r.date);
    } catch { /* se omite */ }
  }
  await z.zip.finalize();
}));

// ================================================================ impresión

app.get('/print', wrap(async (req, res) => {
  let refs = [];
  if (req.query.ref) refs = String(req.query.ref).split(',').slice(0, 500);
  else if (req.query.conv) refs = Q.thread(conn(), active(), String(req.query.conv)).map((r) => `${r.src}-${r.id}`);
  const images = req.query.images === '1';
  const nonce = crypto.randomBytes(12).toString('base64');
  const parts = [];
  for (const ref of refs) {
    let info;
    try { info = messageInfo(ref); } catch { continue; }
    const list = (arr) => esc(arr.map(R.fmtAddr).join('; '));
    const atts = info.attachments.filter((a) => !a.hidden);
    parts.push(`<article class="msg">
      <h1>${esc(info.subject || '(sin asunto)')}</h1>
      <table class="hdr">
        <tr><th>De:</th><td>${esc(R.fmtAddr(info.from))}${info.onBehalf && info.onBehalf !== info.from.name ? ` (en nombre de ${esc(info.onBehalf)})` : ''}</td></tr>
        <tr><th>Fecha:</th><td>${esc(fmtDateLong(info.date))}</td></tr>
        ${info.to.length ? `<tr><th>Para:</th><td>${list(info.to)}</td></tr>` : ''}
        ${info.cc.length ? `<tr><th>CC:</th><td>${list(info.cc)}</td></tr>` : ''}
        ${info.bcc.length ? `<tr><th>CCO:</th><td>${list(info.bcc)}</td></tr>` : ''}
        ${atts.length ? `<tr><th>Adjuntos:</th><td>${atts.map((a) => `${esc(a.name)} <span class="sz">(${Math.max(1, Math.round(a.size / 1024))} KB)</span>`).join('; ')}</td></tr>` : ''}
        <tr><th>Origen:</th><td class="sz">${esc(info.file.name)}${info.folder ? ' › ' + esc(info.folder.replace(/^\//, '').replace(/\//g, ' › ')) : ''}</td></tr>
      </table>
      <div class="body"><template shadowrootmode="open"><style>${BODY_STYLE} body,:host{display:block;padding:0}</style>${bodyHtml(ref, { forPrint: true })}</template></div>
    </article>`);
  }
  const title = refs.length > 1 ? `${parts.length} correos` : 'Correo';
  res.setHeader('Content-Security-Policy', csp(images, nonce));
  res.type('text/html; charset=utf-8').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{font:13px/1.45 "Segoe UI",Arial,sans-serif;color:#111;margin:0;padding:24px;background:#fff}
  .bar{position:sticky;top:0;background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:8px 12px;margin-bottom:18px;display:flex;gap:10px;align-items:center}
  .bar button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;cursor:pointer}
  .bar span{color:#57606a}
  .msg{page-break-after:always;break-after:page;margin-bottom:32px}
  .msg:last-child{page-break-after:auto;break-after:auto}
  h1{font-size:18px;margin:0 0 8px}
  .hdr{border-collapse:collapse;margin-bottom:12px;width:100%;border-bottom:2px solid #111}
  .hdr th{text-align:left;vertical-align:top;width:80px;padding:2px 8px 2px 0;color:#444;font-weight:600}
  .hdr td{padding:2px 0;word-break:break-word}
  .sz{color:#666}
  @media print{body{padding:0}.bar{display:none}}
</style></head><body>
<div class="bar"><button id="p">Imprimir / Guardar PDF</button><span>${esc(title)}${images ? '' : ' · imágenes remotas bloqueadas'}</span></div>
${parts.join('\n') || '<p>No hay correos para imprimir.</p>'}
<script nonce="${nonce}">
  document.getElementById('p').onclick = () => print();
  ${req.query.auto === '1' ? "window.addEventListener('load', () => setTimeout(() => print(), 300));" : ''}
</script></body></html>`);
}));

// ================================================================ estáticos e inicio

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

function addInitialFiles(paths) {
  const list = paths.filter((a) => /\.(pst|ost)$/i.test(a));
  if (!list.length) return null;
  const r = lib.add(list);
  for (const sk of r.skipped) if (!/ya está/.test(sk.reason)) console.error(`${sk.path}: ${sk.reason}`);
  if (r.added.length) libraryChanged();
  return r;
}

// Resumen para la bandeja del sistema (modo escritorio)
function trayStatus() {
  const job = J.job && lib.byId(J.job.fileId);
  let pct = null;
  if (job) {
    const P = J.progress.get(job.id) || {};
    pct = J.job.phase === 'messages' ? (P.total ? (P.done / P.total) * 100 : 0) : (P.attTotal ? (P.attDone / P.attTotal) * 100 : 0);
  }
  return {
    type: 'status',
    indexing: !!J.job,
    consolidating: !!J.consolidating,
    paused: lib.paused,
    pending: lib.files.some((f) => f.enabled && lib.exists(f) && !J.failed.has(f.id) && !fileStatus(f).attComplete),
    job: job ? { name: job.name, phase: J.job.phase, pct: Math.round(pct) } : null,
  };
}

const server = app.listen(PORT, '127.0.0.1', () => {
  port = server.address().port;
  const url = `http://localhost:${port}/`;
  console.log(`PST Explorer listo en ${url}`);
  // archivos pasados por línea de comandos se agregan a la biblioteca
  addInitialFiles(process.argv.slice(2));
  if (consolidationStale()) requestConsolidation();
  schedule();
  toMain({ type: 'ready', port });
  if (!DESKTOP && process.argv.includes('--open') && process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
});

if (DESKTOP) {
  // mensajes del proceso principal de Electron
  process.parentPort.on('message', ({ data: m }) => {
    if (!m) return;
    if (m.type === 'pause') {
      lib.paused = !!m.paused;
      lib.save();
      if (lib.paused) stopJob(); else schedule();
    } else if (m.type === 'add') {
      addInitialFiles(m.paths || []);
    } else if (m.type === 'shutdown') {
      stopJob();
      process.exit(0);
    }
    toMain(trayStatus());
  });
  setInterval(() => toMain(trayStatus()), 2000).unref();
}

// Si ya hay una instancia abierta, solo abrir el navegador
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && !DESKTOP) {
    console.log(`PST Explorer ya está en ejecución: http://localhost:${PORT}/`);
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', `http://localhost:${PORT}/`]);
    setTimeout(() => process.exit(0), 500);
  } else {
    toMain({ type: 'fatal', error: e.message });
    throw e;
  }
});

// Al cerrar, detener el indexador (se reanuda en el próximo inicio)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => { stopJob(); process.exit(0); });
}
