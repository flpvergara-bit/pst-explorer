'use strict';
// Proceso de consolidación de la biblioteca: detecta los correos repetidos
// entre respaldos (mismo Message-ID, o mismo asunto+fecha+remitente si no
// tiene) y precalcula las conversaciones globales. Corre aparte porque con
// cientos de miles de correos tarda algunos segundos.
const { openDb, createLibrarySchema, setMeta } = require('./db');

function run({ libDbPath, files, sig }) {
  const t0 = Date.now();
  const db = openDb(libDbPath);
  createLibrarySchema(db);
  db.exec('PRAGMA temp_store = FILE;');
  for (const f of files) db.prepare(`ATTACH DATABASE ? AS f${f.id}`).run(f.dbPath);

  db.exec(`DROP TABLE IF EXISTS temp.allm;
    CREATE TEMP TABLE allm(f INTEGER, id INTEGER, ord INTEGER, dkey TEXT, conv_key TEXT, date INTEGER, att INTEGER, unread INTEGER, sender TEXT);`);
  files.forEach((f, ord) => {
    db.exec(`INSERT INTO allm SELECT ${f.id}, id, ${ord},
      CASE WHEN message_id IS NOT NULL AND message_id <> '' THEN 'i:' || message_id
           WHEN date IS NOT NULL THEN 's:' || IFNULL(subject, '') || '|' || date || '|' || IFNULL(sender_email, sender_name)
           ELSE 'u:${f.id}:' || id END,
      conv_key, date, att_count > 0, is_read = 0, sender_name FROM f${f.id}.messages`);
  });
  db.exec(`CREATE INDEX temp.ix_allm_dkey ON allm(dkey, ord);
    CREATE INDEX temp.ix_allm_fid ON allm(f, id);
    DROP TABLE IF EXISTS temp.prim;
    CREATE TEMP TABLE prim AS SELECT dkey, MIN(ord) AS mo, COUNT(DISTINCT f) AS nf FROM allm GROUP BY dkey;
    CREATE UNIQUE INDEX temp.ix_prim ON prim(dkey);
    DROP TABLE IF EXISTS temp.oth;
    CREATE TEMP TABLE oth AS SELECT a.dkey, group_concat(DISTINCT a.f) AS others
      FROM allm a JOIN prim p ON p.dkey = a.dkey WHERE p.nf > 1 AND a.ord > p.mo GROUP BY a.dkey;
    CREATE UNIQUE INDEX temp.ix_oth ON oth(dkey);`);

  db.exec('BEGIN');
  db.exec(`DELETE FROM main.dup;
    INSERT INTO main.dup(f, id) SELECT a.f, a.id FROM allm a JOIN prim p ON p.dkey = a.dkey WHERE a.ord > p.mo;
    DELETE FROM main.copies;
    INSERT INTO main.copies(f, id, others)
      SELECT a.f, a.id, o.others FROM allm a JOIN prim p ON p.dkey = a.dkey JOIN oth o ON o.dkey = a.dkey WHERE a.ord = p.mo;
    DELETE FROM main.gconvs;
    INSERT INTO main.gconvs(conv_key, n, last_date, f, id, att, unread, senders)
      SELECT conv_key, COUNT(*), MAX(date), f, id, SUM(att) > 0, SUM(unread) > 0, substr(group_concat(DISTINCT sender), 1, 300)
      -- f, id: columnas del correo más reciente (única función MAX de la consulta)
      FROM allm a WHERE NOT EXISTS (SELECT 1 FROM main.dup d WHERE d.f = a.f AND d.id = a.id) GROUP BY conv_key;`);
  setMeta(db, 'consolidatedAt', new Date().toISOString());
  setMeta(db, 'files', files.map((f) => f.id).join(','));
  setMeta(db, 'sig', sig || '');
  db.exec('COMMIT');
  const stats = {
    messages: db.prepare('SELECT COUNT(*) AS n FROM allm').get().n,
    duplicates: db.prepare('SELECT COUNT(*) AS n FROM main.dup').get().n,
    conversations: db.prepare('SELECT COUNT(*) AS n FROM main.gconvs').get().n,
    ms: Date.now() - t0,
  };
  db.exec('DROP TABLE temp.allm; DROP TABLE temp.prim; DROP TABLE temp.oth;');
  for (const f of files) db.exec(`DETACH DATABASE f${f.id}`);
  db.close();
  return stats;
}

process.once('message', (opts) => {
  try {
    const stats = run(opts);
    process.send({ type: 'done', stats });
    process.exit(0);
  } catch (e) {
    process.send({ type: 'error', error: e && e.message ? e.message : String(e) });
    setTimeout(() => process.exit(2), 100);
  }
});
process.on('disconnect', () => process.exit(0));
