'use strict';
// Consolidated PST export: new PST files with everything the backups contain,
// each item once. It runs as a separate process (like the indexer).
//
// - The plan is built from the indexes: items are grouped by duplicate key
//   (strict dkeySql); for each key one *owner* file is chosen (the copy with
//   more attachments, then larger, then the most recent backup) and every copy
//   in that file is kept (e.g. the same email in Sent Items and in the Inbox).
// - Items go to one PST per range of years, so each one stays under Outlook's
//   50 GB limit. Folders keep their path.
// - Writing is done by Outlook (src/outlook/pstexport.ps1), with the user's
//   profile (an open Outlook is reused), on a disposable working copy of each
//   backup: Outlook writes to every PST it opens, and the originals must not
//   change (their fingerprint identifies their index).
// - Items Outlook finds in the copy but the index does not have (unreadable
//   for the reader) are exported too, without deduplicating.
// - Finally the new PSTs are indexed and every key of the backups must be in
//   them: that is the proof that nothing was lost.
// Everything is recorded in a job database, so an interrupted export resumes
// where it stopped without repeating or losing items.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, execFile, fork } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const D = require('./db');

const IPM_SUBTREE = 0x8022; // NID of "Top of Personal Folders": the root Outlook shows
const MAX_BUCKET = 40 * 1024 ** 3; // per output PST (Outlook's limit is 50 GB)
const OVERHEAD = 1.15; // PST file size / sum of the item sizes
const BATCH = 50;
const CALL_TIMEOUT = 5 * 60 * 1000;

const post = (m) => { if (process.send) process.send(m); };
const fail = (code, extra) => Object.assign(new Error(code), { code, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ plan

// files: [{ id, name, dbPath, size }]
function buildPlan(files) {
  const mem = new DatabaseSync(':memory:');
  mem.exec(`CREATE TABLE m(f INTEGER, id INTEGER, folder INTEGER, k TEXT, date INTEGER, size INTEGER, att INTEGER, rec INTEGER);
    CREATE TABLE fo(f INTEGER, id INTEGER, names TEXT, cls TEXT, PRIMARY KEY(f, id));`);
  const ins = mem.prepare('INSERT INTO m VALUES (?,?,?,?,?,?,?,?)');
  const insF = mem.prepare('INSERT INTO fo VALUES (?,?,?,?)');
  const recency = [];
  for (const f of files) {
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      recency.push({ f: f.id, last: db.prepare('SELECT MAX(date) d FROM messages').get().d || 0 });
      const fold = new Map(db.prepare('SELECT id, parent_id, name, depth, cls FROM folders').all().map((r) => [r.id, r]));
      mem.exec('BEGIN');
      for (const r of fold.values()) insF.run(f.id, r.id, JSON.stringify(folderNames(fold, r.id)), r.cls || '');
      for (const r of db.prepare(`SELECT id, folder_id, ${D.dkeySql(f.id, true)} AS k, date, size, att_count FROM messages`).iterate()) {
        ins.run(f.id, r.id, r.folder_id, r.k, r.date, r.size || 0, r.att_count || 0, 0);
      }
      mem.exec('COMMIT');
    } finally {
      db.close();
    }
  }
  // the most recent backup wins a tie
  recency.sort((a, b) => a.last - b.last).forEach((r, i) => mem.prepare('UPDATE m SET rec = ? WHERE f = ?').run(i, r.f));
  mem.exec(`CREATE INDEX ix_m ON m(k);
    CREATE TABLE own AS SELECT k, f FROM (
      SELECT k, f, ROW_NUMBER() OVER (PARTITION BY k ORDER BY att DESC, size DESC, rec DESC, f) rn FROM m) WHERE rn = 1;
    CREATE UNIQUE INDEX ix_own ON own(k);
    CREATE TABLE items AS SELECT m.f, m.id, m.folder, m.date, m.size FROM m JOIN own o ON o.k = m.k AND o.f = m.f;`);

  // ranges of years under the size limit
  const years = mem.prepare(`SELECT CAST(strftime('%Y', date / 1000, 'unixepoch', 'localtime') AS INTEGER) y, COUNT(*) n, SUM(size) b
    FROM items WHERE date IS NOT NULL GROUP BY y ORDER BY y`).all();
  const undated = mem.prepare('SELECT COUNT(*) n, IFNULL(SUM(size), 0) b FROM items WHERE date IS NULL').get();
  // as few files as possible, balanced in size
  const total = years.reduce((s, y) => s + y.b, 0);
  let buckets = [];
  for (let k = Math.max(1, Math.ceil((total * OVERHEAD) / MAX_BUCKET)); ; k++) {
    const target = total / k;
    buckets = [];
    for (const y of years) {
      const cur = buckets[buckets.length - 1];
      const join = cur && (cur.bytes + y.b) * OVERHEAD <= MAX_BUCKET
        && (buckets.length >= k || Math.abs(cur.bytes + y.b - target) <= Math.abs(cur.bytes - target));
      if (join) Object.assign(cur, { to: y.y, n: cur.n + y.n, bytes: cur.bytes + y.b });
      else buckets.push({ from: y.y, to: y.y, n: y.n, bytes: y.b });
    }
    // a single year over the limit gets its own file anyway
    if (buckets.length <= k || k >= years.length) break;
  }
  if (!buckets.length) buckets.push({ from: new Date().getFullYear(), to: new Date().getFullYear(), n: 0, bytes: 0 });
  const last = buckets[buckets.length - 1];
  last.n += undated.n;
  last.bytes += undated.b;
  buckets.forEach((b) => { b.key = b.from === b.to ? String(b.from) : `${b.from}-${b.to}`; b.estBytes = Math.round(b.bytes * OVERHEAD); });

  const totals = mem.prepare('SELECT COUNT(*) n, (SELECT COUNT(*) FROM m) src, (SELECT COUNT(DISTINCT k) FROM m) keys FROM items').get();
  return { mem, buckets, items: totals.n, sourceItems: totals.src, keys: totals.keys, undated: undated.n };
}

// Folder path inside the new PST: the names below the root Outlook shows
function folderNames(fold, id) {
  const names = [];
  for (let r = fold.get(id); r && r.depth > 0; r = fold.get(r.parent_id)) {
    if (r.depth === 1 && r.id === IPM_SUBTREE) break;
    names.unshift(r.name || '_');
  }
  return names;
}

function summarize(plan) {
  return {
    items: plan.items, sourceItems: plan.sourceItems, keys: plan.keys, undated: plan.undated,
    buckets: plan.buckets.map(({ key, from, to, n, estBytes }) => ({ key, from, to, n, estBytes })),
  };
}

// Creates the job database (data/export/job.db) from the plan
function createJob(jobDbPath, cfg) {
  const plan = buildPlan(cfg.files);
  const buckets = plan.buckets.map((b) => ({ ...b, path: path.join(cfg.outDir, cfg.fileName.replace('{range}', b.key) + '.pst') }));
  for (const b of buckets) if (fs.existsSync(b.path)) throw fail('outExists', { path: b.path });
  fs.mkdirSync(path.dirname(jobDbPath), { recursive: true });
  for (const x of [jobDbPath, jobDbPath + '-wal', jobDbPath + '-shm']) fs.rmSync(x, { force: true });
  const db = D.openDb(jobDbPath);
  db.exec(`CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE files(f INTEGER PRIMARY KEY, ord INTEGER, name TEXT, path TEXT, db TEXT, size INTEGER, state TEXT DEFAULT 'pending');
    CREATE TABLE buckets(key TEXT PRIMARY KEY, y_from INTEGER, y_to INTEGER, path TEXT, n INTEGER, est INTEGER);
    CREATE TABLE folders(f INTEGER, id INTEGER, names TEXT, cls TEXT, PRIMARY KEY(f, id)) WITHOUT ROWID;
    -- state: 0 pending, 1 moved, 2 error, 3 moved before an interruption
    CREATE TABLE items(f INTEGER, nid INTEGER, folder INTEGER, bucket TEXT, state INTEGER DEFAULT 0, err TEXT, PRIMARY KEY(f, nid)) WITHOUT ROWID;
    -- items Outlook found that the index does not have
    CREATE TABLE extra(f INTEGER, nid INTEGER, names TEXT, cls TEXT, bucket TEXT, state INTEGER DEFAULT 0, err TEXT, PRIMARY KEY(f, nid)) WITHOUT ROWID;`);
  const yearBucket = (y) => (buckets.find((b) => y >= b.from && y <= b.to) || (y < buckets[0].from ? buckets[0] : buckets[buckets.length - 1])).key;
  db.exec('BEGIN');
  cfg.files.forEach((f, i) => db.prepare('INSERT INTO files(f, ord, name, path, db, size) VALUES (?,?,?,?,?,?)').run(f.id, i, f.name, f.path, f.dbPath, f.size));
  for (const b of buckets) db.prepare('INSERT INTO buckets VALUES (?,?,?,?,?,?)').run(b.key, b.from, b.to, b.path, b.n, b.estBytes);
  const insF = db.prepare('INSERT INTO folders VALUES (?,?,?,?)');
  for (const r of plan.mem.prepare('SELECT * FROM fo WHERE (f, id) IN (SELECT DISTINCT f, folder FROM items)').iterate()) insF.run(r.f, r.id, r.names, r.cls);
  const insI = db.prepare('INSERT INTO items(f, nid, folder, bucket) VALUES (?,?,?,?)');
  const last = buckets[buckets.length - 1].key;
  for (const r of plan.mem.prepare(`SELECT f, id, folder, CAST(strftime('%Y', date / 1000, 'unixepoch', 'localtime') AS INTEGER) y FROM items`).iterate()) {
    insI.run(r.f, r.id, r.folder, r.y == null ? last : yearBucket(r.y));
  }
  D.setMeta(db, 'config', JSON.stringify({ ...cfg, files: undefined }));
  D.setMeta(db, 'summary', JSON.stringify(summarize(plan)));
  D.setMeta(db, 'state', 'running');
  D.setMeta(db, 'createdAt', new Date().toISOString());
  db.exec('COMMIT');
  plan.mem.close();
  return db;
}

// ------------------------------------------------------------------ Outlook

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 60000, ...opts }, (err, stdout) => resolve(err ? null : stdout));
});

async function outlookVersion() {
  const out = await run('reg', ['query', 'HKCR\\Outlook.Application\\CurVer', '/ve']);
  const m = out && /Outlook\.Application\.(\d+)/.exec(out);
  return m ? `${m[1]}.0` : null;
}

// Profile Outlook starts with when it is closed (the one it uses by default)
async function defaultProfile(version) {
  const out = await run('reg', ['query', `HKCU\\Software\\Microsoft\\Office\\${version}\\Outlook`, '/v', 'DefaultProfile']);
  const m = out && /DefaultProfile\s+REG_SZ\s+(.+)/.exec(out);
  return m ? m[1].trim() : null;
}

async function outlookRunning() {
  const out = await run('tasklist', ['/FI', 'IMAGENAME eq OUTLOOK.EXE', '/NH']);
  return !!out && /outlook\.exe/i.test(out);
}

// What the export needs: Windows with classic Outlook (COM) installed
async function checkOutlook() {
  if (process.platform !== 'win32') return { ok: false, reason: 'windowsOnly' };
  const version = await outlookVersion();
  if (!version) return { ok: false, reason: 'outlookMissing' };
  return { ok: true, version, running: await outlookRunning() };
}

// The PowerShell worker (outside the asar: PowerShell cannot read inside it)
class Worker {
  constructor() {
    const script = path.join(__dirname, 'outlook', 'pstexport.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    this.p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.waiting = [];
    this.stderr = '';
    this.p.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    readline.createInterface({ input: this.p.stdout }).on('line', (line) => {
      const w = this.waiting.shift();
      if (!w) return;
      clearTimeout(w.timer);
      let r;
      try { r = JSON.parse(line); } catch { return w.reject(fail('outlookError', { msg: line.slice(0, 300) })); }
      if (r.ok) w.resolve(r); else w.reject(fail('outlookError', { msg: r.error }));
    });
    this.p.on('exit', () => {
      for (const w of this.waiting.splice(0)) { clearTimeout(w.timer); w.reject(fail('outlookError', { msg: this.stderr.trim() || 'worker ended' })); }
    });
  }

  call(cmd, timeout = CALL_TIMEOUT) {
    return new Promise((resolve, reject) => {
      // no reply in time: Outlook is usually showing a dialog
      const timer = setTimeout(() => reject(fail('outlookTimeout')), timeout);
      this.waiting.push({ resolve, reject, timer });
      this.p.stdin.write(JSON.stringify(cmd) + '\n');
    });
  }

  async quit() {
    try { await this.call({ cmd: 'quit' }, 60000); } catch { /* already gone */ }
    this.p.kill();
  }
}

// ------------------------------------------------------------------ run

let canceled = false;

function copyWithProgress(src, dst, onProgress) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(src).size;
    let done = 0;
    let lastPost = 0;
    const r = fs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 });
    const w = fs.createWriteStream(dst);
    r.on('data', (c) => {
      done += c.length;
      if (canceled) r.destroy(fail('canceled'));
      const now = Date.now();
      if (now - lastPost > 500) { lastPost = now; onProgress(done, total); }
    });
    r.on('error', reject);
    w.on('error', reject);
    w.on('finish', resolve);
    r.pipe(w);
  });
}

function tryRemove(file) {
  try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
}

async function runJob({ jobDbPath, cfg }) {
  // cfg only for a new job; without it the existing one resumes
  const db = cfg ? createJob(jobDbPath, cfg) : D.openDb(jobDbPath);
  const conf = JSON.parse(D.getMeta(db, 'config'));
  D.setMeta(db, 'state', 'running');
  // what failed in a previous run is tried again
  db.exec('UPDATE items SET state = 0, err = NULL WHERE state = 2; UPDATE extra SET state = 0, err = NULL WHERE state = 2;');
  const workDir = path.join(conf.outDir, conf.workName);
  fs.mkdirSync(workDir, { recursive: true });
  const workPath = (f) => path.join(workDir, `source-${f.f}.pst`);
  const buckets = db.prepare('SELECT key, y_from AS "from", y_to AS "to", path FROM buckets ORDER BY y_from').all();
  const files = db.prepare('SELECT * FROM files ORDER BY ord').all();
  const totalItems = db.prepare('SELECT COUNT(*) n FROM items').get().n;
  const countDone = db.prepare('SELECT COUNT(*) n FROM items WHERE state IN (1, 3)');
  const progress = (extra) => post({ type: 'progress', done: countDone.get().n, total: totalItems, ...extra });
  const setState = db.prepare('UPDATE files SET state = ? WHERE f = ?');

  const check = await checkOutlook();
  if (!check.ok) throw fail(check.reason);
  const pendingFiles = files.filter((f) => f.state !== 'moved' && f.state !== 'done');
  if (pendingFiles.length) {
    progress({ phase: 'outlook' });
    const wk = new Worker();
    try {
      // Outlook may ask the user to sign in when it starts
      await wk.call({ cmd: 'start', profile: await defaultProfile(check.version) }, 15 * 60 * 1000);
      for (const b of buckets) await wk.call({ cmd: 'addStore', key: b.key, path: b.path });
      for (const f of pendingFiles) {
        if (canceled) throw fail('canceled');
        const work = workPath(f);
        const resumed = f.state === 'moving' && fs.existsSync(work);
        if (!resumed) {
          if (!fs.existsSync(f.path)) throw fail('sourceMissing', { path: f.path });
          setState.run('copying', f.f);
          await copyWithProgress(f.path, work, (done, total) => progress({ phase: 'copy', file: f.name, bytes: done, bytesTotal: total }));
        }
        setState.run('moving', f.f);
        await exportFile(db, wk, f, work, resumed, buckets, progress);
        setState.run('moved', f.f);
        // Outlook may keep a copy open for a while: deleted now or at the end
        for (const g of files) if (g.f !== f.f) tryRemove(workPath(g));
      }
    } finally {
      await wk.quit(); // detaches the PSTs; closes Outlook only if the export opened it
    }
  }

  // Outlook keeps the data files open until it closes: only then can the copies
  // be deleted and the new PSTs read for the verification
  D.setMeta(db, 'state', 'waitingOutlook');
  while (await outlookRunning()) {
    if (canceled) throw fail('canceled');
    progress({ phase: 'waitOutlook' });
    await sleep(3000);
  }
  for (const f of files) {
    if (fs.existsSync(workPath(f)) && !tryRemove(workPath(f))) throw fail('locked', { path: workPath(f) });
    setState.run('done', f.f);
  }
  try { fs.rmdirSync(workDir); } catch { /* not empty */ }

  // verification: index the new PSTs and look for every key of the backups
  D.setMeta(db, 'state', 'verifying');
  const report = await verify(db, buckets, files, conf, progress);
  D.setMeta(db, 'report', JSON.stringify(report));
  D.setMeta(db, 'state', 'done');
  D.setMeta(db, 'finishedAt', new Date().toISOString());
  db.close();
  return report;
}

// Moves the items of one backup (its working copy) to the new PSTs
async function exportFile(db, wk, f, work, resumed, buckets, progress) {
  const src = `src${f.f}`;
  await wk.call({ cmd: 'addStore', key: src, path: work });
  progress({ phase: 'move', file: f.name });

  // 1. the items of the plan
  const folders = new Map(db.prepare('SELECT id, names, cls FROM folders WHERE f = ?').all(f.f).map((r) => [r.id, r]));
  const pending = db.prepare('SELECT nid, folder, bucket FROM items WHERE f = ? AND state = 0 LIMIT ?');
  const upd = db.prepare('UPDATE items SET state = ?, err = ? WHERE f = ? AND nid = ?');
  const failed = new Set();
  for (;;) {
    if (canceled) throw fail('canceled');
    const rows = pending.all(f.f, BATCH + failed.size).filter((r) => !failed.has(r.nid)).slice(0, BATCH);
    if (!rows.length) break;
    const r = await wk.call({
      cmd: 'move', src, buckets,
      items: rows.map((x) => {
        const fo = folders.get(x.folder) || { names: '[]', cls: '' };
        return { nid: x.nid, dest: x.bucket, folder: JSON.parse(fo.names), cls: fo.cls };
      }),
    });
    db.exec('BEGIN');
    for (const x of [].concat(r.results || [])) {
      if (x.ok) upd.run(1, null, f.f, x.nid);
      // not found in a copy that was already being processed: it was moved before the interruption
      else if (x.notFound && resumed) upd.run(3, null, f.f, x.nid);
      else { upd.run(2, x.notFound ? 'not found' : String(x.error || '').slice(0, 300), f.f, x.nid); failed.add(x.nid); }
    }
    db.exec('COMMIT');
    progress({ phase: 'move', file: f.name });
  }

  // 2. what Outlook sees in the copy that the index does not have
  progress({ phase: 'sweep', file: f.name });
  const listed = await wk.call({ cmd: 'listItems', src }, 30 * 60 * 1000);
  const idx = new DatabaseSync(f.db, { readOnly: true });
  const known = new Set(idx.prepare('SELECT id FROM messages').all().map((x) => x.id));
  idx.close();
  const insX = db.prepare('INSERT OR IGNORE INTO extra(f, nid, names, cls) VALUES (?,?,?,?)');
  db.exec('BEGIN');
  for (const fo of [].concat(listed.folders || [])) {
    for (const nid of String(fo.nids || '').split(',').filter(Boolean).map(Number)) {
      if (!known.has(nid)) insX.run(f.f, nid, JSON.stringify([].concat(fo.path || [])), fo.cls || '');
    }
  }
  db.exec('COMMIT');
  const pendingX = db.prepare('SELECT nid, names, cls FROM extra WHERE f = ? AND state = 0 LIMIT ?');
  const updX = db.prepare('UPDATE extra SET state = ?, err = ?, bucket = ? WHERE f = ? AND nid = ?');
  const failedX = new Set();
  for (;;) {
    if (canceled) throw fail('canceled');
    const rows = pendingX.all(f.f, BATCH + failedX.size).filter((r) => !failedX.has(r.nid)).slice(0, BATCH);
    if (!rows.length) break;
    const r = await wk.call({ cmd: 'move', src, buckets, items: rows.map((x) => ({ nid: x.nid, dest: null, folder: JSON.parse(x.names), cls: x.cls })) });
    db.exec('BEGIN');
    for (const x of [].concat(r.results || [])) {
      if (x.ok) updX.run(1, null, x.dest, f.f, x.nid);
      else { updX.run(2, String(x.error || 'not found').slice(0, 300), null, f.f, x.nid); failedX.add(x.nid); }
    }
    db.exec('COMMIT');
  }
  await wk.call({ cmd: 'removeStore', key: src });
}

function indexOutput(pstPath, dbPath) {
  for (const x of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(x, { force: true });
  const d = D.openDb(dbPath);
  D.createSchema(d);
  d.close();
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'indexer.js'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: ['--max-old-space-size=4096'] });
    let ok = false;
    child.on('message', (m) => {
      if (m.type === 'progress') post({ type: 'progress', phase: 'verify', file: path.basename(pstPath), done: m.done, total: m.total });
      if (m.type === 'done') ok = true;
    });
    child.on('exit', () => (ok ? resolve() : reject(fail('verifyFailed', { path: pstPath }))));
    child.send({ pstPath, dbPath, phase: 'messages' });
  });
}

async function verify(db, buckets, files, conf, progress) {
  const vdir = path.join(conf.dataDir, 'export', 'verify');
  fs.mkdirSync(vdir, { recursive: true });
  const mem = new DatabaseSync(':memory:');
  mem.exec('CREATE TABLE outk(k TEXT); CREATE TABLE srck(f INTEGER, id INTEGER, k TEXT, subject TEXT, date INTEGER, folder TEXT);');
  const out = [];
  for (const b of buckets) {
    if (canceled) throw fail('canceled');
    progress({ phase: 'verify', file: path.basename(b.path) });
    const vdb = path.join(vdir, `${b.key}.db`);
    await indexOutput(b.path, vdb);
    const x = new DatabaseSync(vdb, { readOnly: true });
    const ins = mem.prepare('INSERT INTO outk VALUES (?)');
    mem.exec('BEGIN');
    let n = 0;
    for (const r of x.prepare(`SELECT ${D.dkeySql(0, true)} AS k FROM messages`).iterate()) { ins.run(r.k); n++; }
    mem.exec('COMMIT');
    out.push({ key: b.key, path: b.path, items: n, bytes: fs.statSync(b.path).size, errors: Number(D.getMeta(x, 'errors')) || 0 });
    x.close();
  }
  const ins = mem.prepare('INSERT INTO srck VALUES (?,?,?,?,?,?)');
  for (const f of files) {
    const x = new DatabaseSync(f.db, { readOnly: true });
    const fpath = new Map(x.prepare('SELECT id, path FROM folders').all().map((r) => [r.id, r.path]));
    mem.exec('BEGIN');
    for (const r of x.prepare(`SELECT id, ${D.dkeySql(f.f, true)} AS k, subject, date, folder_id FROM messages`).iterate()) {
      ins.run(f.f, r.id, r.k, r.subject, r.date, fpath.get(r.folder_id) || '');
    }
    mem.exec('COMMIT');
    x.close();
  }
  mem.exec('CREATE INDEX ix_out ON outk(k);');
  // keys without Message-ID or date ('u:') are per file and cannot be matched: they are checked by count
  const missingSql = "FROM srck s WHERE s.k NOT LIKE 'u:%' AND NOT EXISTS (SELECT 1 FROM outk o WHERE o.k = s.k)";
  const missing = mem.prepare(`SELECT COUNT(DISTINCT k) n ${missingSql}`).get().n;
  const samples = mem.prepare(`SELECT f, subject, date, folder ${missingSql} GROUP BY k LIMIT 50`).all()
    .map((r) => ({ file: (files.find((f) => f.f === r.f) || {}).name, subject: r.subject, date: r.date, folder: r.folder }));
  const c = (sql) => db.prepare(sql).get().n;
  mem.close();
  return {
    outputs: out,
    planned: c('SELECT COUNT(*) n FROM items'),
    moved: c('SELECT COUNT(*) n FROM items WHERE state IN (1, 3)'),
    failed: c('SELECT COUNT(*) n FROM items WHERE state = 2'),
    extraMoved: c('SELECT COUNT(*) n FROM extra WHERE state = 1'),
    extraFailed: c('SELECT COUNT(*) n FROM extra WHERE state = 2'),
    outputItems: out.reduce((s, o) => s + o.items, 0),
    missing,
    samples,
    failures: db.prepare(`SELECT f.name AS file, i.nid, i.err FROM items i JOIN files f ON f.f = i.f WHERE i.state = 2
      UNION ALL SELECT f.name, x.nid, x.err FROM extra x JOIN files f ON f.f = x.f WHERE x.state = 2 LIMIT 50`).all(),
  };
}

module.exports = { buildPlan, summarize, checkOutlook };

// ------------------------------------------------------------------ child process

if (require.main === module) {
  process.on('message', async (m) => {
    if (m.type === 'cancel') { canceled = true; return; }
    if (m.type === 'plan') {
      try {
        const plan = buildPlan(m.files);
        post({ type: 'plan', plan: summarize(plan), outlook: await checkOutlook() });
        plan.mem.close();
        process.exit(0);
      } catch (e) {
        post({ type: 'error', code: e.code || 'error', msg: e.message });
        process.exit(2);
      }
    }
    if (m.type === 'run') {
      try {
        const report = await runJob(m);
        post({ type: 'done', report });
        process.exit(0);
      } catch (e) {
        post({ type: 'error', code: e.code || 'error', msg: e.msg || e.message, path: e.path });
        setTimeout(() => process.exit(2), 100);
      }
    }
  });
  process.on('disconnect', () => { canceled = true; });
}
