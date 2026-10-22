// Usage : node scripts/migrate-sqlite-to-pg.js ./data/simplimo.db postgres://simplimo:MOT_DE_PASSE@hote:5432/simplimo
const knex = require('knex');
(async () => {
  const [, , file, url] = process.argv;
  if (!file || !url) { console.error('Usage : node scripts/migrate-sqlite-to-pg.js <fichier.db> <url postgres>'); process.exit(1); }
  const src = knex({ client: 'better-sqlite3', connection: { filename: file }, useNullAsDefault: true });
  process.env.DB_CLIENT = 'pg'; process.env.PG_URL = url;
  const { db: dst, init } = require('../src/db');
  await init();
  // Ordre imposé par les clés étrangères
  for (const t of ['users', 'categories', 'items', 'item_documents', 'events', 'event_items', 'item_history', 'audit_logs']) {
    const rows = await src(t).select();
    if (!rows.length) continue;
    await dst(t).del();
    for (let i = 0; i < rows.length; i += 200) await dst(t).insert(rows.slice(i, i + 200));
    await dst.raw(`SELECT setval(pg_get_serial_sequence('${t}','id'), (SELECT MAX(id) FROM ${t}))`);
    console.log(`${t} : ${rows.length} ligne(s)`);
  }
  await src.destroy(); await dst.destroy();
  console.log('Terminé. Copiez aussi le dossier data/uploads vers le volume "uploads".');
})().catch(e => { console.error(e); process.exit(1); });
