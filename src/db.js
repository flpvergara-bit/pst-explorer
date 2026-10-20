'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = '2';
const ATT_ROWID = 4096; // rowid in attfts = msg_id * ATT_ROWID + idx

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
  // relevance weights: subject, sender, recipients, body, attachment names
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

// ---------- search ----------

const FIELD_ALIASES = {
  de: 'sender', from: 'sender', remitente: 'sender',
  para: 'recipients', to: 'recipients', cc: 'recipients', destinatario: 'recipients',
  asunto: 'subject', subject: 'subject',
  adjunto: 'attachments', adjuntos: 'attachments', archivo: 'attachments', att: 'attachments', attachment: 'attachments', attachments: 'attachments', file: 'attachments',
  cuerpo: 'body', body: 'body', texto: 'body',
  contenido: 'content', content: 'content', dentro: 'content',
};

// Turns the user's text into safe FTS5 queries.
// Supports "phrases", -exclusions, field prefixes (from:/de:, to:/para:, subject:/asunto:, attachment:/adjunto:, body:/cuerpo:, content:/contenido:)
// and OR between groups of terms. Returns { main, att, terms }:
//   main  -> query on the emails (subject, sender, recipients, body, attachment names)
//   att   -> query on the text extracted from attachments (terms without a field or with content:)
//   terms -> words to highlight in the UI
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
      if (!col) text = `${field}:${text}`; // it was not a field (e.g. a time like 10:30)
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
      // a group only applies to a target if all its positive terms can be searched there
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

// Duplicate key of an email across backups (SQL over a file's messages table):
// its Message-ID, or subject+date+sender when it has none. strict (used by the
// consolidated PST export) also requires the same item class and attachment
// count for items without Message-ID, so two different contacts or notices with
// the same subject and time are never merged.
function dkeySql(fid, strict) {
  const extra = strict ? " || '|' || IFNULL(msg_class, '') || '|' || IFNULL(att_count, 0)" : '';
  return `CASE WHEN message_id IS NOT NULL AND message_id <> '' THEN 'i:' || message_id
    WHEN date IS NOT NULL THEN 's:' || IFNULL(subject, '') || '|' || date || '|' || IFNULL(sender_email, sender_name)${extra}
    ELSE 'u:${Number(fid)}:' || id END`;
}

// Library database: data that combines several files (duplicate copies across
// backups and global conversations). Recalculated by consolidate.js.
function createLibrarySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS dup(f INTEGER, id INTEGER, PRIMARY KEY(f, id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS copies(f INTEGER, id INTEGER, others TEXT, PRIMARY KEY(f, id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS gconvs(conv_key TEXT PRIMARY KEY, n INTEGER, last_date INTEGER, f INTEGER, id INTEGER,
      att INTEGER, unread INTEGER, senders TEXT);
    CREATE INDEX IF NOT EXISTS ix_gconvs_date ON gconvs(last_date);
    -- comparison between files: what each one has that the others do not
    CREATE TABLE IF NOT EXISTS cmp_file(f INTEGER PRIMARY KEY, total INTEGER, unique_n INTEGER, shared_n INTEGER,
      intra_dup INTEGER, no_id INTEGER, min_date INTEGER, max_date INTEGER);
    CREATE TABLE IF NOT EXISTS cmp_pair(a INTEGER, b INTEGER, shared INTEGER, PRIMARY KEY(a, b)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS cmp_need(a INTEGER, b INTEGER, n INTEGER, PRIMARY KEY(a, b)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS cmp_uniq(f INTEGER, id INTEGER, PRIMARY KEY(f, id)) WITHOUT ROWID;
  `);
}

module.exports = { openDb, createSchema, createLibrarySchema, dkeySql, getMeta, setMeta, buildFtsQuery, parseDay, SCHEMA_VERSION, ATT_ROWID };
