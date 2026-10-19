'use strict';
// Combined queries over several indexes (one per PST) attached to the same
// SQLite connection as f<id>. Each file contributes one or more "arms" to a
// UNION ALL that is then sorted and paginated.
const { buildFtsQuery, parseDay, ATT_ROWID } = require('./db');

const COUNT_CAP = 5000; // the quick count stops here; the exact one is requested separately

// References: message "fid-nid" (or "fid-nid.0.1" for embedded attachments),
// folder "fid:nid".
function parseFolderRef(s) {
  const m = /^(\d+):(\d+)$/.exec(String(s || ''));
  return m ? { f: Number(m[1]), id: Number(m[2]) } : null;
}
function parseMsgRef(s) {
  const m = /^(\d+)-(\d+(?:\.\d+)*)$/.exec(String(s || ''));
  return m ? { f: Number(m[1]), ref: m[2], nid: Number(m[2].split('.')[0]) } : null;
}

const listParam = (v, max = 5000) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, max);

// Prepares, for each active file, the common filters (without the text search).
// files: [{ id, alias }]
function build(conn, files, q) {
  const fts = buildFtsQuery(q.q);
  const emptySearch = !!(q.q && String(q.q).trim() && !fts);
  let targets = files;
  const folder = parseFolderRef(q.folder);
  if (folder) targets = targets.filter((f) => f.id === folder.f);
  if (q.file) {
    const ids = listParam(q.file).map(Number);
    targets = targets.filter((f) => ids.includes(f.id));
  }
  let idsByFile = null;
  if (q.ids) {
    idsByFile = new Map();
    for (const r of listParam(q.ids, 20000).map(parseMsgRef).filter(Boolean)) {
      if (!idsByFile.has(r.f)) idsByFile.set(r.f, []);
      idsByFile.get(r.f).push(r.nid);
    }
    targets = targets.filter((f) => idsByFile.has(f.id));
  }
  const main = fts ? fts.main : null;
  const att = fts && q.inatt !== '0' ? fts.att : null;

  const arms = [];
  for (const f of targets) {
    const A = f.alias;
    const where = [];
    const params = [];
    if (emptySearch || (fts && !main && !att)) where.push('0');
    if (folder) {
      const row = conn.prepare(`SELECT path FROM ${A}.folders WHERE id = ?`).get(folder.id);
      if (row && q.sub === '1') {
        where.push(`m.folder_id IN (SELECT id FROM ${A}.folders WHERE path = ? OR substr(path, 1, ?) = ?)`);
        params.push(row.path, row.path.length + 1, row.path + '/');
      } else {
        where.push('m.folder_id = ?');
        params.push(folder.id);
      }
    }
    const from = parseDay(q.dateFrom, false);
    if (from != null) { where.push('m.date >= ?'); params.push(from); }
    const to = parseDay(q.dateTo, true);
    if (to != null) { where.push('m.date < ?'); params.push(to); }
    if (q.att === '1') where.push('m.att_count > 0');
    if (q.unread === '1') where.push('m.is_read = 0');
    if (q.kind === 'mail') where.push("(m.msg_class LIKE 'IPM.Note%' OR m.msg_class = '' OR m.msg_class IS NULL)");
    if (q.conv) { where.push('m.conv_key = ?'); params.push(String(q.conv)); }
    if (q.attext) {
      const exts = listParam(String(q.attext).toLowerCase()).map((s) => s.replace(/^\./, ''));
      if (exts.length) {
        where.push(`m.id IN (SELECT msg_id FROM ${A}.attachments WHERE ext IN (${exts.map(() => '?').join(',')}) AND (hidden = 0 OR embedded = 1))`);
        params.push(...exts);
      }
    }
    if (idsByFile) {
      const ids = idsByFile.get(f.id);
      where.push(`m.id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    // copies of the same email in other backups: shown only once
    if (q.dups !== '1') where.push(`NOT EXISTS (SELECT 1 FROM main.dup d WHERE d.f = ${f.id} AND d.id = m.id)`);
    // only the emails that are not in any other file of the library
    if (q.only === 'unique') where.push(`EXISTS (SELECT 1 FROM main.cmp_uniq u WHERE u.f = ${f.id} AND u.id = m.id)`);
    arms.push({ f, A, where, params });
  }
  return { arms, fts, main, att, relevance: q.sort === 'relevance' && !!(main || att) };
}

const inMain = (A) => `m.id IN (SELECT rowid FROM ${A}.fts WHERE fts MATCH ?)`;
const inAtt = (A) => `m.id IN (SELECT rowid / ${ATT_ROWID} FROM ${A}.attfts WHERE attfts MATCH ?)`;
const W = (list) => (list.length ? 'WHERE ' + list.join(' AND ') : '');

// Builds the SELECTs of each file. cols(arm) returns the columns; from(arm) the FROM
// (messages by default). With relevance, matches in subject/body carry their
// bm25 score and those only inside attachments come after them (rank 0).
function arms(b, cols, { from, extraWhere = [], extraParams = [], forceSimple = false } = {}) {
  const out = [];
  for (const arm of b.arms) {
    const A = arm.A;
    const FROM = from ? from(arm) : `${A}.messages m`;
    const base = [...arm.where, ...extraWhere];
    const bp = [...arm.params, ...extraParams];
    if (!b.fts) {
      out.push({ sql: `SELECT ${cols(arm, 'NULL', 'NULL')} FROM ${FROM} ${W(base)}`, params: bp });
    } else if (b.relevance && !forceSimple) {
      if (b.main) {
        out.push({
          sql: `SELECT ${cols(arm, 'hm.rank', '0')} FROM ${FROM} JOIN (SELECT rowid AS id, rank FROM ${A}.fts WHERE fts MATCH ?) hm ON hm.id = m.id ${W(base)}`,
          params: [b.main, ...bp],
        });
      }
      if (b.att) {
        const w = [...base, inAtt(A)];
        const p = [...bp, b.att];
        if (b.main) { w.push(`NOT ${inMain(A)}`); p.push(b.main); }
        out.push({ sql: `SELECT ${cols(arm, '0.0', '1')} FROM ${FROM} ${W(w)}`, params: p });
      }
    } else {
      // sort by date or another column: it is enough to know whether the email matches
      const conds = [];
      const cp = [];
      if (b.main) { conds.push(inMain(A)); cp.push(b.main); }
      if (b.att) { conds.push(inAtt(A)); cp.push(b.att); }
      let hit = b.main ? '0' : '1';
      const hp = [];
      if (b.main && b.att) { hit = `CASE WHEN ${inMain(A)} THEN 0 ELSE 1 END`; hp.push(b.main); }
      out.push({
        sql: `SELECT ${cols(arm, 'NULL', hit)} FROM ${FROM} ${W([...base, `(${conds.join(' OR ')})`])}`,
        params: [...hp, ...bp, ...cp],
      });
    }
  }
  if (!out.length) return null;
  return { sql: out.map((o) => o.sql).join(' UNION ALL '), params: out.flatMap((o) => o.params) };
}

const MSG_COLS = (arm, rank, hit) => `${arm.f.id} AS src, m.id, m.folder_id, m.subject, m.sender_name, m.sender_email, m.to_text, m.cc_text,
  m.date, m.size, m.att_count, m.msg_class, m.importance, m.is_read, m.conv_key, m.message_id, m.snippet, ${rank} AS rank, ${hit} AS hit_src`;

const SORTS = {
  date: 'date', sender: 'sender_name COLLATE NOCASE', subject: 'subject COLLATE NOCASE', size: 'size', att: 'att_count',
};
function orderBy(q, b) {
  if (b.relevance) return 'ORDER BY rank ASC, date DESC, src, id';
  const col = SORTS[q.sort] || SORTS.date;
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${col} ${dir}, src ${dir}, id ${dir}`;
}

// Capped count: fast even when hundreds of thousands of emails match
function countCapped(conn, u, cap = COUNT_CAP) {
  const n = conn.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM (${u.sql}) LIMIT ${cap + 1})`).get(...u.params).n;
  return { total: Math.min(n, cap), capped: n > cap };
}
function countExact(conn, u) {
  return conn.prepare(`SELECT COUNT(*) AS n FROM (${u.sql})`).get(...u.params).n;
}

// ------------------------------------------------------------------ queries

function messages(conn, files, q, { limit, offset = 0, count = false, exact = false } = {}) {
  const b = build(conn, files, q);
  const terms = b.fts ? b.fts.terms : [];
  const u = arms(b, MSG_COLS);
  if (!u) return { total: 0, rows: [], terms };
  if (exact) return { total: countExact(conn, arms(b, MSG_COLS, { forceSimple: true })), terms };
  const lim = limit == null ? '' : `LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
  const rows = conn.prepare(`SELECT * FROM (${u.sql}) ${orderBy(q, b)} ${lim}`).all(...u.params);
  addConvCounts(conn, rows);
  const res = { rows, terms, total: null };
  if (count) Object.assign(res, countCapped(conn, arms(b, MSG_COLS, { forceSimple: true })));
  return res;
}

function addConvCounts(conn, rows) {
  const st = conn.prepare('SELECT n FROM main.gconvs WHERE conv_key = ?');
  for (const r of rows) {
    if (r.conv_key) {
      const c = st.get(r.conv_key);
      r.conv_n = c ? c.n : null;
    }
  }
}

// does the query have no filters? (allows using the precalculated conversations table)
const isUnfiltered = (q) => !q.q && !q.folder && !q.file && !q.dateFrom && !q.dateTo && q.att !== '1' && q.unread !== '1'
  && q.kind !== 'mail' && !q.attext && !q.ids && q.dups !== '1' && !q.only;

function threads(conn, files, q, { limit, offset = 0, count = false, exact = false, useGlobal = true } = {}) {
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  if (useGlobal && isUnfiltered(q)) {
    const inF = `f IN (${files.map((f) => f.id).join(',') || 'NULL'})`;
    if (exact) return { total: conn.prepare(`SELECT COUNT(*) AS n FROM main.gconvs WHERE ${inF}`).get().n };
    const rows = conn.prepare(`SELECT conv_key, n AS hits, n AS conv_n, last_date AS date, f AS src, id, att AS att_count,
        CASE WHEN unread THEN 0 ELSE 1 END AS is_read, senders FROM main.gconvs WHERE ${inF}
        ORDER BY last_date ${dir} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`).all();
    fillThreadRows(conn, files, rows);
    const total = count ? conn.prepare(`SELECT COUNT(*) AS n FROM main.gconvs WHERE ${inF}`).get().n : null;
    return { total, capped: false, rows, terms: [] };
  }
  const b = build(conn, files, q);
  const cols = (arm, rank, hit) => `${arm.f.id} AS src, m.id, m.conv_key, m.date, m.subject, m.sender_name, m.snippet, m.att_count, m.is_read,
    ${rank} AS rank, ${hit} AS hit_src`;
  const u = arms(b, cols);
  const terms = b.fts ? b.fts.terms : [];
  if (!u) return { total: 0, rows: [], terms };
  if (exact) return { total: conn.prepare(`SELECT COUNT(DISTINCT conv_key) AS n FROM (${u.sql})`).get(...u.params).n };
  // MAX(date) is the only MIN/MAX function: src, id, subject… come from the most recent email
  const order = b.relevance ? 'SUM(rank) / COUNT(*) ASC, date DESC' : `date ${dir}`;
  const rows = conn.prepare(`SELECT conv_key, COUNT(*) AS hits, MAX(date) AS date, src, id, subject, sender_name, snippet,
      SUM(att_count) AS att_count, CASE WHEN SUM(is_read = 0) > 0 THEN 0 ELSE 1 END AS is_read,
      substr(group_concat(DISTINCT sender_name), 1, 300) AS senders
    FROM (${u.sql}) GROUP BY conv_key ORDER BY ${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`).all(...u.params);
  addConvCounts(conn, rows);
  const res = { rows, terms, total: null };
  if (count) {
    const n = conn.prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT conv_key FROM (${u.sql}) LIMIT ${COUNT_CAP + 1})`).get(...u.params).n;
    Object.assign(res, { total: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP });
  }
  return res;
}

// fills in subject/sender/snippet of the last email of each conversation
function fillThreadRows(conn, files, rows) {
  const byId = new Map(files.map((f) => [f.id, f]));
  for (const r of rows) {
    const f = byId.get(r.src);
    if (!f) continue;
    const m = conn.prepare(`SELECT subject, sender_name, snippet FROM ${f.alias}.messages WHERE id = ?`).get(r.id);
    if (m) Object.assign(r, m);
  }
}

function thread(conn, files, key, { dups = false } = {}) {
  const b = build(conn, files, { conv: key, dups: dups ? '1' : '0' });
  const u = arms(b, (arm) => `${arm.f.id} AS src, m.id, m.folder_id, fo.path AS folder, m.subject, m.sender_name, m.sender_email,
      m.to_text, m.cc_text, m.date, m.att_count, m.message_id, m.snippet, m.msg_class`,
  { from: (arm) => `${arm.A}.messages m LEFT JOIN ${arm.A}.folders fo ON fo.id = m.folder_id` });
  if (!u) return [];
  return conn.prepare(`SELECT * FROM (${u.sql}) ORDER BY date ASC, src ASC, id ASC LIMIT 5000`).all(...u.params);
}

function attachments(conn, files, q, { limit, offset = 0, count = false, exact = false } = {}) {
  const b = build(conn, files, { ...q, sort: q.sort === 'relevance' ? 'date' : q.sort });
  const extraWhere = ['(a.hidden = 0 OR a.embedded = 1)'];
  const extraParams = [];
  if (q.ext) {
    const exts = listParam(String(q.ext).toLowerCase()).map((s) => s.replace(/^\./, ''));
    extraWhere.push(`a.ext IN (${exts.map(() => '?').join(',')})`);
    extraParams.push(...exts);
  }
  if (q.name) {
    extraWhere.push("a.name LIKE ? ESCAPE '\\'");
    extraParams.push(`%${String(q.name).replace(/[%_\\]/g, (c) => '\\' + c)}%`);
  }
  const cols = (arm, rank, hit) => `${arm.f.id} AS src, a.msg_id, a.idx, a.name, a.ext, a.size, a.mime, a.embedded, a.txt_state,
    m.subject, m.sender_name, m.date, m.folder_id, ${hit} AS hit_src`;
  const u = arms(b, cols, { from: (arm) => `${arm.A}.attachments a JOIN ${arm.A}.messages m ON m.id = a.msg_id`, extraWhere, extraParams });
  if (!u) return { total: 0, rows: [], exts: [] };
  if (exact) return { total: countExact(conn, u) };
  const sort = { name: 'name COLLATE NOCASE', size: 'size', ext: 'ext', date: 'date' }[q.sort] || 'date';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const rows = conn.prepare(`SELECT * FROM (${u.sql}) ORDER BY ${sort} ${dir}, src, msg_id, idx LIMIT ${Number(limit)} OFFSET ${Number(offset)}`).all(...u.params);
  const res = { rows, total: null };
  if (count) {
    Object.assign(res, countCapped(conn, u));
    const e = b.arms.map((arm) => `SELECT ext, COUNT(*) AS n FROM ${arm.A}.attachments WHERE hidden = 0 OR embedded = 1 GROUP BY ext`).join(' UNION ALL ');
    res.exts = e ? conn.prepare(`SELECT ext, SUM(n) AS n FROM (${e}) GROUP BY ext ORDER BY n DESC LIMIT 30`).all() : [];
  }
  return res;
}

module.exports = { build, arms, messages, threads, thread, attachments, parseFolderRef, parseMsgRef, isUnfiltered, COUNT_CAP };
