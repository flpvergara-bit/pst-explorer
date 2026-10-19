'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = '2';
const ATT_ROWID = 4096; // rowid en attfts = msg_id * ATT_ROWID + idx

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000; PRAGMA cache_size=-65536;');
  return db;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS folders(
      id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, path TEXT, depth INTEGER, ord INTEGER,
      total INTEGER DEFAULT 0, indexed INTEGER DEFAULT 0, cls TEXT);
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY, folder_id INTEGER, subject TEXT, sender_name TEXT, sender_email TEXT,
      to_text TEXT, cc_text TEXT, bcc_text TEXT, date INTEGER, size INTEGER, att_count INTEGER,
      msg_class TEXT, importance INTEGER, is_read INTEGER, conv_key TEXT, message_id TEXT, snippet TEXT);
    CREATE TABLE IF NOT EXISTS attachments(
      msg_id INTEGER, idx INTEGER, name TEXT, ext TEXT, size INTEGER, mime TEXT, cid TEXT,
      embedded INTEGER, hidden INTEGER, txt_state INTEGER DEFAULT 0, PRIMARY KEY(msg_id, idx));
    CREATE TABLE IF NOT EXISTS convs(conv_key TEXT PRIMARY KEY, n INTEGER, last_date INTEGER);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      subject, sender, recipients, body, attachments, content='', tokenize='unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE IF NOT EXISTS attfts USING fts5(content, content='', tokenize='unicode61 remove_diacritics 2');
    CREATE INDEX IF NOT EXISTS ix_msg_folder_date ON messages(folder_id, date);
    CREATE INDEX IF NOT EXISTS ix_msg_date ON messages(date);
    CREATE INDEX IF NOT EXISTS ix_msg_conv ON messages(conv_key, date);
    CREATE INDEX IF NOT EXISTS ix_att_ext ON attachments(ext);
    CREATE INDEX IF NOT EXISTS ix_att_state ON attachments(txt_state);
  `);
  // pesos de relevancia: asunto, remitente, destinatarios, cuerpo, nombres de adjuntos
  db.exec("INSERT INTO fts(fts, rank) VALUES('rank', 'bm25(10.0, 5.0, 3.0, 1.0, 4.0)')");
  db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('schema', SCHEMA_VERSION);
}

function getMeta(db, k) {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return r ? r.v : null;
}

function setMeta(db, k, v) {
  db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run(k, String(v));
}

// ---------- búsqueda ----------

const FIELD_ALIASES = {
  de: 'sender', from: 'sender', remitente: 'sender',
  para: 'recipients', to: 'recipients', cc: 'recipients', destinatario: 'recipients',
  asunto: 'subject', subject: 'subject',
  adjunto: 'attachments', adjuntos: 'attachments', archivo: 'attachments', att: 'attachments', attachment: 'attachments', attachments: 'attachments', file: 'attachments',
  cuerpo: 'body', body: 'body', texto: 'body',
  contenido: 'content', content: 'content', dentro: 'content',
};

// Convierte el texto del usuario en consultas FTS5 seguras.
// Admite "frases", -exclusiones, prefijos de campo (de:, para:, asunto:, adjunto:, cuerpo:, contenido:)
// y OR entre grupos de términos. Devuelve { main, att, terms }:
//   main  -> consulta sobre los correos (asunto, remitente, destinatarios, cuerpo, nombres de adjuntos)
//   att   -> consulta sobre el texto extraído de los adjuntos (términos sin campo o con contenido:)
//   terms -> palabras para resaltar en la interfaz
function buildFtsQuery(input) {
  const groups = [[]];
  const terms = [];
  const re = /(-)?(?:([a-záéíóúñ]+):)?(?:"([^"]*)"|(\S+))/gi;
  let m;
  while ((m = re.exec(input || ''))) {
    const [, minus, field, quoted, bare] = m;
    if (!minus && !field && quoted == null && /^(or|o|\|)$/i.test(bare)) { groups.push([]); continue; }
    let text = (quoted ?? bare ?? '').trim();
    let col = null;
    if (field) {
      col = FIELD_ALIASES[field.toLowerCase()] || null;
      if (!col) text = `${field}:${text}`; // no era un campo (p.ej. una hora 10:30)
    }
    const clean = text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!clean) continue;
    if (!minus) terms.push(clean);
    groups[groups.length - 1].push({ col, phrase: `"${clean.replace(/"/g, '""')}"` + (quoted != null ? '' : '*'), neg: !!minus });
  }

  const build = (target) => {
    const parts = [];
    for (const g of groups) {
      const pos = g.filter((t) => !t.neg);
      if (!pos.length) continue;
      // un grupo solo aplica a un destino si todos sus términos positivos pueden buscarse ahí
      const fits = (t) => (target === 'main' ? t.col !== 'content' : !t.col || t.col === 'content');
      if (!pos.every(fits)) continue;
      const fmt = (t) => (target === 'main' && t.col ? `${t.col} : ${t.phrase}` : t.phrase);
      let q = pos.map(fmt).join(' AND ');
      for (const n of g.filter((t) => t.neg && fits(t))) q = `(${q}) NOT ${fmt(n)}`;
      parts.push(`(${q})`);
    }
    return parts.length ? parts.join(' OR ') : null;
  };
  const main = build('main');
  const att = build('att');
  if (!main && !att) return null;
  return { main, att, terms };
}

function parseDay(s, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (endOfDay) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Base de la biblioteca: datos que combinan varios archivos (copias repetidas
// entre respaldos y conversaciones globales). Se recalcula con consolidate.js.
function createLibrarySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS dup(f INTEGER, id INTEGER, PRIMARY KEY(f, id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS copies(f INTEGER, id INTEGER, others TEXT, PRIMARY KEY(f, id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS gconvs(conv_key TEXT PRIMARY KEY, n INTEGER, last_date INTEGER, f INTEGER, id INTEGER,
      att INTEGER, unread INTEGER, senders TEXT);
    CREATE INDEX IF NOT EXISTS ix_gconvs_date ON gconvs(last_date);
    -- comparación entre archivos: qué tiene cada uno que no esté en los demás
    CREATE TABLE IF NOT EXISTS cmp_file(f INTEGER PRIMARY KEY, total INTEGER, unique_n INTEGER, shared_n INTEGER,
      intra_dup INTEGER, no_id INTEGER, min_date INTEGER, max_date INTEGER);
    CREATE TABLE IF NOT EXISTS cmp_pair(a INTEGER, b INTEGER, shared INTEGER, PRIMARY KEY(a, b)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS cmp_need(a INTEGER, b INTEGER, n INTEGER, PRIMARY KEY(a, b)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS cmp_uniq(f INTEGER, id INTEGER, PRIMARY KEY(f, id)) WITHOUT ROWID;
  `);
}

module.exports = { openDb, createSchema, createLibrarySchema, getMeta, setMeta, buildFtsQuery, parseDay, SCHEMA_VERSION, ATT_ROWID };
