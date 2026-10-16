'use strict';
// Proceso indexador: recorre el PST y llena el índice SQLite. Corre en un
// proceso aparte para que la interfaz siga respondiendo y para que un elemento
// dañado que haga caer al lector no afecte al servidor. Es reanudable: si se
// interrumpe, continúa desde donde quedó (las tandas se confirman enteras).
// En "modo cuidadoso" (tras una caída) confirma elemento por elemento y anota
// cuál está procesando, para saltarlo si vuelve a fallar.
//
// Fase 1: carpetas y correos (metadatos + cuerpo para búsqueda).
// Fase 2: texto del contenido de los adjuntos (PDF, Office, texto, correos adjuntos).
const R = require('./pstreader');
const { extractText, EXTRACTABLE, MAX_BYTES } = require('./extract');
const { openDb, setMeta, getMeta, ATT_ROWID } = require('./db');

const BODY_LIMIT = 100000; // caracteres de cuerpo que se indexan por mensaje
const BATCH = 250;

const post = (m) => { if (process.send) process.send(m); };
let careful = false;
const nid = (o) => R.toNum(o.descriptorNodeId);

// phase: 'messages' | 'attachments' | 'all'
async function run({ pstPath, dbPath, careful: c, phase = 'all' }) {
  careful = !!c;
  const db = openDb(dbPath);
  const pst = R.openPst(pstPath);
  // elemento que se estaba procesando cuando ocurrió la caída anterior
  const crashed = getMeta(db, 'crash_candidate');
  if (crashed) {
    const [kind, a, b] = crashed.split(':').map((x, i) => (i ? Number(x) : x));
    if (kind === 'm') setMeta(db, 'skip_ids', [getMeta(db, 'skip_ids'), a].filter(Boolean).join(','));
    if (kind === 'a') db.prepare('UPDATE attachments SET txt_state = 2 WHERE msg_id = ? AND idx = ?').run(a, b);
    setMeta(db, 'errors', (Number(getMeta(db, 'errors')) || 0) + 1);
    db.prepare("DELETE FROM meta WHERE k = 'crash_candidate'").run();
  }

  if (phase !== 'attachments' && getMeta(db, 'complete') !== '1') {
    indexMessages(db, pst);
    post({ type: 'phase', phase: 'optimizing' });
    db.exec("INSERT INTO fts(fts) VALUES('optimize');");
  }
  if (phase !== 'messages' && getMeta(db, 'complete') === '1' && getMeta(db, 'att_complete') !== '1') {
    await indexAttachments(db, pst);
    post({ type: 'phase', phase: 'optimizing' });
    db.exec("INSERT INTO attfts(attfts) VALUES('optimize');");
  }
  db.close();
  pst.close();
  post({ type: 'done' });
}

// ------------------------------------------------------------------ fase 1

function indexMessages(db, pst) {
  post({ type: 'phase', phase: 'scanning' });
  const folders = [];
  let ord = 0;
  const walk = (folder, parentId, path, depth) => {
    const id = nid(folder);
    const name = depth === 0 ? '' : R.safe(() => folder.displayName) || '(sin nombre)';
    const fpath = depth === 0 ? '' : `${path}/${name}`;
    const f = { id, parentId, name, path: fpath, depth, ord: ord++, cls: R.safe(() => folder.containerClass), folder };
    f.ids = R.safe(() => folder.contentCount, 0) > 0 ? R.folderChildIds(folder) : [];
    folders.push(f);
    if (R.safe(() => folder.hasSubfolders, false)) {
      for (const child of R.safe(() => folder.getSubFolders(), [])) walk(child, id, fpath, depth + 1);
    }
  };
  walk(pst.getRootFolder(), null, '', 0);

  // correos ya indexados en una ejecución anterior (reanudación)
  const already = new Map(db.prepare('SELECT folder_id, COUNT(*) n FROM messages GROUP BY folder_id').all().map((r) => [r.folder_id, r.n]));
  const seen = new Set(db.prepare('SELECT id FROM messages').all().map((r) => r.id));
  for (const id of String(getMeta(db, 'skip_ids') || '').split(',').filter(Boolean)) seen.add(Number(id));

  const insFolder = db.prepare('INSERT OR REPLACE INTO folders(id, parent_id, name, path, depth, ord, total, indexed, cls) VALUES (?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (const f of folders) insFolder.run(f.id, f.parentId, f.name, f.path, f.depth, f.ord, f.ids.length, already.get(f.id) || 0, f.cls);
  db.exec('COMMIT');
  const total = folders.reduce((s, f) => s + f.ids.length, 0);
  setMeta(db, 'total', total);
  let done = seen.size;
  post({ type: 'folders', total, done });

  const insMsg = db.prepare(`INSERT OR REPLACE INTO messages(id, folder_id, subject, sender_name, sender_email, to_text, cc_text, bcc_text,
    date, size, att_count, msg_class, importance, is_read, conv_key, message_id, snippet) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insFts = db.prepare('INSERT INTO fts(rowid, subject, sender, recipients, body, attachments) VALUES (?,?,?,?,?,?)');
  const insAtt = db.prepare('INSERT OR REPLACE INTO attachments(msg_id, idx, name, ext, size, mime, cid, embedded, hidden, txt_state) VALUES (?,?,?,?,?,?,?,?,?,0)');
  const updFolder = db.prepare('UPDATE folders SET indexed = ? WHERE id = ?');

  let errors = Number(getMeta(db, 'errors')) || 0;
  let inTx = false;
  let lastPost = 0;
  let pending = 0;

  for (const f of folders) {
    let count = already.get(f.id) || 0;
    for (const id of f.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (careful) setMeta(db, 'crash_candidate', `m:${id}`);
      if (!inTx) { db.exec('BEGIN'); inTx = true; }
      try {
        indexMessage(R.loadObject(pst, id), id, f.id);
        count++;
      } catch {
        errors++;
      }
      done++;
      if (++pending >= (careful ? 1 : BATCH)) {
        pending = 0;
        updFolder.run(count, f.id);
        setMeta(db, 'errors', errors);
        db.exec('COMMIT');
        inTx = false;
        const now = Date.now();
        if (now - lastPost > 300) {
          lastPost = now;
          post({ type: 'progress', done, total, errors, folder: f.path });
        }
      }
    }
    if (!inTx) { db.exec('BEGIN'); inTx = true; }
    updFolder.run(count, f.id);
  }
  if (inTx) db.exec('COMMIT');
  db.prepare("DELETE FROM meta WHERE k = 'crash_candidate'").run();
  post({ type: 'progress', done, total, errors, folder: '' });

  post({ type: 'phase', phase: 'finalizing' });
  db.exec(`DELETE FROM convs;
    INSERT INTO convs(conv_key, n, last_date) SELECT conv_key, COUNT(*), MAX(date) FROM messages GROUP BY conv_key;`);
  setMeta(db, 'errors', errors);
  setMeta(db, 'indexed', db.prepare('SELECT COUNT(*) n FROM messages').get().n);
  setMeta(db, 'complete', '1');
  setMeta(db, 'completedAt', new Date().toISOString());
  post({ type: 'messagesDone', done, total, errors });

  function indexMessage(msg, id, folderId) {
    const sender = R.senderOf(msg);
    const rc = R.recipientsOf(msg);
    const atts = R.safe(() => msg.hasAttachments, false) || R.safe(() => msg.numberOfAttachments, 0) ? R.listAttachments(msg) : [];
    let text = '';
    try {
      const body = R.getBody(msg);
      text = body.type === 'html' ? R.htmlToText(body.content) : body.content;
      if (body.type === 'html') R.markInline(atts, body.content);
    } catch { /* cuerpo ilegible */ }
    const subject = R.safe(() => msg.subject);
    const snippet = text.slice(0, 600).replace(/\s+/g, ' ').trim().slice(0, 240);
    const visible = atts.filter((a) => !a.hidden || a.embedded);
    insMsg.run(
      id, folderId, subject, sender.name, sender.email,
      R.fmtList(rc.to), R.fmtList(rc.cc), R.fmtList(rc.bcc),
      R.messageDate(msg), R.toNum(R.safe(() => msg.messageSize, 0)), visible.length,
      R.safe(() => msg.messageClass), R.safe(() => msg.importance, 1), R.safe(() => msg.isRead, true) ? 1 : 0,
      R.convKeyOf(msg, id), R.safe(() => msg.internetMessageId), snippet,
    );
    for (const a of atts) insAtt.run(id, a.idx, a.name, a.ext, a.size, a.mime, a.cid, a.embedded ? 1 : 0, a.hidden ? 1 : 0);
    const recips = [...rc.to, ...rc.cc, ...rc.bcc].map((a) => `${a.name} ${a.email}`).join(' ');
    insFts.run(id, subject, `${sender.name} ${sender.email}`, recips, text.slice(0, BODY_LIMIT), atts.map((a) => a.name).join(' '));
  }
}

// ------------------------------------------------------------------ fase 2

async function indexAttachments(db, pst) {
  // txt_state: 0 pendiente, 1 indexado, 2 no aplica / error
  db.exec(`UPDATE attachments SET txt_state = 2 WHERE txt_state = 0 AND embedded = 0
    AND (hidden = 1 OR size > ${MAX_BYTES} OR ext NOT IN (${[...EXTRACTABLE].map((e) => `'${e}'`).join(',')}))`);
  const pending = db.prepare('SELECT msg_id, idx, ext, embedded FROM attachments WHERE txt_state = 0 ORDER BY msg_id, idx').all();
  const total = pending.length;
  const doneBefore = db.prepare('SELECT COUNT(*) n FROM attachments WHERE txt_state = 1').get().n;
  post({ type: 'phase', phase: 'attachments', attTotal: total + doneBefore, attDone: doneBefore });

  const ins = db.prepare('INSERT INTO attfts(rowid, content) VALUES (?, ?)');
  const upd = db.prepare('UPDATE attachments SET txt_state = ? WHERE msg_id = ? AND idx = ?');
  let done = 0;
  let lastPost = 0;
  let msg = null;
  let msgId = -1;
  let inTx = false;

  for (const a of pending) {
    if (careful) setMeta(db, 'crash_candidate', `a:${a.msg_id}:${a.idx}`);
    if (!inTx) { db.exec('BEGIN'); inTx = true; }
    let state = 2;
    try {
      if (a.msg_id !== msgId) {
        msgId = a.msg_id;
        msg = R.loadObject(pst, a.msg_id);
      }
      let text = '';
      if (a.embedded) {
        const emb = msg.getAttachment(a.idx).embeddedPSTMessage;
        if (emb) {
          const from = R.senderOf(emb);
          const rc = R.recipientsOf(emb);
          const names = R.listAttachments(emb).map((x) => x.name).join(' ');
          text = [R.safe(() => emb.subject), from.name, from.email, R.fmtList(rc.to), R.fmtList(rc.cc), names, R.bodyText(emb)].join('\n').slice(0, 200000);
        }
      } else {
        text = await extractText(R.readAttachmentData(msg, a.idx), a.ext);
      }
      if (text) {
        ins.run(a.msg_id * ATT_ROWID + a.idx, text);
        state = 1;
      }
    } catch { /* adjunto dañado o protegido con contraseña */ }
    upd.run(state, a.msg_id, a.idx);
    done++;
    if (careful || done % 25 === 0) {
      db.exec('COMMIT');
      inTx = false;
      const now = Date.now();
      if (now - lastPost > 400) {
        lastPost = now;
        post({ type: 'attProgress', attDone: doneBefore + done, attTotal: total + doneBefore });
      }
    }
  }
  if (inTx) db.exec('COMMIT');
  db.prepare("DELETE FROM meta WHERE k = 'crash_candidate'").run();
  setMeta(db, 'att_complete', '1');
  setMeta(db, 'att_indexed', db.prepare('SELECT COUNT(*) n FROM attachments WHERE txt_state = 1').get().n);
  post({ type: 'attProgress', attDone: doneBefore + done, attTotal: total + doneBefore });
}

process.once('message', (opts) => {
  run(opts)
    .then(() => process.exit(0))
    .catch((e) => {
      post({ type: 'error', error: e && e.message ? e.message : String(e) });
      setTimeout(() => process.exit(2), 100);
    });
});
// si el servidor desaparece, terminar también
process.on('disconnect', () => process.exit(0));
