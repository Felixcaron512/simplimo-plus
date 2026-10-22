require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const bwip = require('bwip-js');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { db, init, ins } = require('./db');
const { ldapLogin } = require('./ldap');

if (!process.env.JWT_SECRET) console.warn('⚠ JWT_SECRET absent : secret aléatoire (les sessions sautent à chaque redémarrage).');
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const UP = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
fs.mkdirSync(UP, { recursive: true });
const now = () => new Date().toISOString();

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' }));

/* ---------- Helpers ---------- */
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '') || req.query.t; // ?t= pour <img> et téléchargements
  try { req.user = jwt.verify(t, SECRET); next(); } catch { res.status(401).json({ error: 'Non authentifié' }); }
}
const need = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Droits insuffisants' });
const audit = (req, action, entity, entity_id, detail) => db('audit_logs').insert({
  user_id: req.user?.id ?? null, username: req.user?.username ?? detail?.username ?? null, action, entity,
  entity_id: entity_id ?? null, detail: detail ? JSON.stringify(detail) : null, ip: req.ip, at: now(),
});
const hist = (t, item_id, event_id, user, action, note, at) =>
  t('item_history').insert({ item_id, event_id, action, user_id: user.id, username: user.username, note: note || null, at: at || now() });
const genCode = () => 'SMP-' + crypto.randomBytes(4).toString('hex').toUpperCase();

function savePhoto(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const f = 'scan-' + crypto.randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UP, f), Buffer.from(m[2], 'base64'));
  return f;
}
async function catId(name) {
  name = (name || '').trim();
  if (!name) return null;
  const c = await db('categories').whereRaw('lower(name)=?', [name.toLowerCase()]).first();
  return c ? c.id : ins(db, 'categories', { name });
}

/* ---------- Authentification (local + LDAP) ---------- */
app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Identifiants requis' });
  let user = await db('users').where({ username }).first();
  let ok = false;
  if (user && user.source === 'local' && user.active) ok = await bcrypt.compare(password, user.password_hash || '');
  if (!ok && process.env.LDAP_ENABLED === 'true' && (!user || user.source === 'ldap')) {
    try {
      const l = await ldapLogin(username, password);
      if (l) {
        if (!l.role) return res.status(403).json({ error: 'Aucun groupe LDAP autorisé pour Simplimo +' });
        if (user) await db('users').where({ id: user.id }).update({ role: l.role, display_name: l.name }); // synchro des groupes à chaque connexion
        else await ins(db, 'users', { username, display_name: l.name, source: 'ldap', role: l.role, active: true, created_at: now() });
        user = await db('users').where({ username }).first();
        ok = !!user.active;
      }
    } catch (e) { console.error('LDAP :', e.message); }
  }
  if (!ok) { await audit(req, 'login_failed', 'user', null, { username }); return res.status(401).json({ error: 'Identifiants invalides' }); }
  const me = { id: user.id, username: user.username, name: user.display_name || user.username, role: user.role };
  req.user = me;
  await audit(req, 'login', 'user', user.id);
  res.json({ token: jwt.sign(me, SECRET, { expiresIn: '7d' }), me });
}));
app.get('/api/me', auth, (req, res) => res.json(req.user));

/* ---------- Inventaire ---------- */
const FIELDS = ['name', 'kind', 'status', 'location', 'serial_number', 'quantity', 'min_quantity', 'notes'];
const pickItem = b => {
  const o = {};
  for (const k of FIELDS) if (b[k] !== undefined) o[k] = b[k] === '' ? null : b[k];
  if (o.quantity != null) o.quantity = Math.max(0, parseInt(o.quantity, 10) || 0);
  if (o.min_quantity != null) o.min_quantity = Math.max(0, parseInt(o.min_quantity, 10) || 0);
  return o;
};

app.get('/api/items', auth, wrap(async (req, res) => {
  const { q, status } = req.query;
  const k = db('items as i').leftJoin('categories as c', 'c.id', 'i.category_id').select('i.*', 'c.name as category').orderBy('i.name');
  if (status) k.where('i.status', status);
  if (q) k.where(b => {
    const l = '%' + String(q).toLowerCase() + '%';
    b.whereRaw('lower(i.name) like ?', [l]).orWhereRaw('lower(i.code) like ?', [l]).orWhereRaw("lower(coalesce(i.serial_number,'')) like ?", [l]);
  });
  res.json(await k.limit(2000));
}));

app.post('/api/items', auth, need('admin', 'manager'), wrap(async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Nom requis' });
  const row = { ...pickItem(req.body), code: (req.body.code || '').trim() || genCode(), category_id: await catId(req.body.category), created_at: now(), updated_at: now() };
  const id = await ins(db, 'items', row);
  await hist(db, id, null, req.user, 'created');
  await audit(req, 'item_create', 'item', id, { code: row.code, name: row.name });
  res.json({ id });
}));

app.get('/api/items/:id', auth, wrap(async (req, res) => {
  const item = await db('items as i').leftJoin('categories as c', 'c.id', 'i.category_id').select('i.*', 'c.name as category').where('i.id', req.params.id).first();
  if (!item) return res.status(404).json({ error: 'Introuvable' });
  res.json({
    item,
    docs: await db('item_documents').where({ item_id: item.id }),
    history: await db('item_history').where({ item_id: item.id }).orderBy('at', 'desc').limit(200),
  });
}));

app.put('/api/items/:id', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const old = await db('items').where({ id: req.params.id }).first();
  if (!old) return res.status(404).json({ error: 'Introuvable' });
  const row = { ...pickItem(req.body), updated_at: now() };
  if (req.body.category !== undefined) row.category_id = await catId(req.body.category);
  if (req.body.code && req.body.code !== old.code) row.code = req.body.code.trim();
  await db('items').where({ id: old.id }).update(row);
  if (row.status && row.status !== old.status) await hist(db, old.id, null, req.user, 'status:' + row.status);
  await audit(req, 'item_update', 'item', old.id, row);
  res.json({ ok: true });
}));

app.get('/api/lookup/:code', auth, wrap(async (req, res) => {
  const it = await db('items').where({ code: req.params.code }).first();
  it ? res.json(it) : res.status(404).json({ error: 'Code inconnu' });
}));
app.get('/api/categories', auth, wrap(async (req, res) => res.json(await db('categories').orderBy('name'))));

const upload = multer({
  storage: multer.diskStorage({
    destination: UP,
    filename: (q, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});
app.post('/api/items/:id/files', auth, need('admin', 'manager'), upload.single('file'), wrap(async (req, res) => {
  const f = req.file;
  const kind = req.body.kind === 'photo' ? 'photo' : 'doc';
  const okType = kind === 'photo' ? f && f.mimetype.startsWith('image/') : f && f.mimetype === 'application/pdf';
  if (!okType) { if (f) fs.unlink(f.path, () => {}); return res.status(400).json({ error: kind === 'photo' ? 'Image attendue' : 'PDF attendu' }); }
  if (kind === 'photo') await db('items').where({ id: req.params.id }).update({ photo_path: f.filename });
  else await db('item_documents').insert({ item_id: req.params.id, title: f.originalname, path: f.filename, created_at: now() });
  await audit(req, 'item_file_' + kind, 'item', +req.params.id, { file: f.originalname });
  res.json({ ok: true });
}));

app.get('/api/items/:id/label.png', auth, wrap(async (req, res) => {
  const it = await db('items').where({ id: req.params.id }).first();
  if (!it) return res.sendStatus(404);
  const t = ['qrcode', 'code128', 'datamatrix'].includes(req.query.type) ? req.query.type : 'qrcode';
  const opts = { bcid: t, text: it.code, scale: 4, paddingwidth: 4, paddingheight: 4 };
  if (t === 'code128') Object.assign(opts, { height: 12, includetext: true, textxalign: 'center' });
  res.type('png').send(await bwip.toBuffer(opts));
}));
app.use('/uploads', auth, express.static(UP));

/* ---------- Événements ---------- */
// Conflit = même article sérialisé sur un autre événement non terminé dont la période chevauche
async function conflicts(itemIds, start, end, excludeId) {
  if (!itemIds.length) return [];
  const q = db('event_items as ei').join('events as e', 'e.id', 'ei.event_id').join('items as i', 'i.id', 'ei.item_id')
    .whereIn('ei.item_id', itemIds).where('i.kind', 'serialized').whereIn('e.status', ['planned', 'out'])
    .where('e.start_at', '<', end).where('e.end_at', '>', start)
    .select('i.id as item_id', 'i.name as item', 'i.code', 'e.id as event_id', 'e.name as event');
  if (excludeId) q.whereNot('e.id', excludeId);
  return q;
}
async function loadEvent(id) {
  const ev = await db('events').where({ id }).first();
  if (!ev) return {};
  const rows = await db('event_items as ei').join('items as i', 'i.id', 'ei.item_id').where('ei.event_id', id)
    .select('ei.*', 'i.code', 'i.name', 'i.kind', 'i.location', 'i.serial_number', 'i.status as item_status').orderBy('i.name');
  return { ev, rows };
}
const validDates = (s, e) => s && e && !isNaN(Date.parse(s)) && !isNaN(Date.parse(e)) && Date.parse(e) > Date.parse(s);

app.get('/api/events', auth, wrap(async (req, res) => {
  res.json(await db('events as e').leftJoin('event_items as ei', 'ei.event_id', 'e.id').groupBy('e.id').orderBy('e.start_at', 'desc')
    .select('e.*').count('ei.id as n_items'));
}));

app.post('/api/events', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const { name, location, start_at, end_at, items = [] } = req.body;
  if (!name || !validDates(start_at, end_at)) return res.status(400).json({ error: 'Nom et période valide requis' });
  const c = await conflicts(items.map(i => +i.item_id), start_at, end_at);
  if (c.length) return res.status(409).json({ error: 'Conflit de réservation', conflicts: c });
  const id = await db.transaction(async t => {
    const eid = await ins(t, 'events', { name, location: location || null, start_at, end_at, created_by: req.user.id, created_at: now() });
    for (const i of items) await t('event_items').insert({ event_id: eid, item_id: +i.item_id, qty: Math.max(1, +i.qty || 1) });
    return eid;
  });
  await audit(req, 'event_create', 'event', id, { name, n: items.length });
  res.json({ id });
}));

app.get('/api/events/:id', auth, wrap(async (req, res) => {
  const d = await loadEvent(req.params.id);
  d.ev ? res.json(d) : res.status(404).json({ error: 'Introuvable' });
}));

app.post('/api/events/:id/items', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const ev = await db('events').where({ id: req.params.id }).first();
  if (!ev) return res.status(404).json({ error: 'Introuvable' });
  const c = await conflicts([+req.body.item_id], ev.start_at, ev.end_at, ev.id);
  if (c.length) return res.status(409).json({ error: 'Conflit de réservation', conflicts: c });
  await db('event_items').insert({ event_id: ev.id, item_id: +req.body.item_id, qty: Math.max(1, +req.body.qty || 1) });
  await audit(req, 'event_add_item', 'event', ev.id, { item_id: req.body.item_id });
  res.json({ ok: true });
}));

app.delete('/api/events/:id/items/:itemId', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const n = await db('event_items').where({ event_id: req.params.id, item_id: req.params.itemId }).whereNull('out_scanned_at').del();
  await audit(req, 'event_remove_item', 'event', +req.params.id, { item_id: req.params.itemId });
  res.json({ removed: n });
}));

app.delete('/api/events/:id', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const ev = await db('events').where({ id: req.params.id }).first();
  if (!ev || ev.status !== 'planned') return res.status(409).json({ error: 'Seul un événement planifié peut être supprimé' });
  await db('event_items').where({ event_id: ev.id }).del();
  await db('events').where({ id: ev.id }).del();
  await audit(req, 'event_delete', 'event', ev.id, { name: ev.name });
  res.json({ ok: true });
}));

/* ---------- Check-out / Check-in ---------- */
async function applyScan(t, user, eventId, op) {
  const at = op.at && !isNaN(Date.parse(op.at)) ? new Date(op.at).toISOString() : now();
  const item = await t('items').where({ code: String(op.code || '') }).first();
  if (!item) return { ok: false, error: 'Code inconnu' };
  const ei = await t('event_items').where({ event_id: eventId, item_id: item.id }).first();
  if (!ei) return { ok: false, error: 'Article non prévu pour cet événement' };

  if (op.mode !== 'in') {                                   // ----- DÉPART
    if (ei.out_scanned_at) return { ok: true, duplicate: true };
    await t('event_items').where({ id: ei.id }).update({ out_scanned_at: at, out_by: user.id });
    if (item.kind === 'serialized') await t('items').where({ id: item.id }).update({ status: 'in_event', updated_at: now() });
    else await t('items').where({ id: item.id }).update({ quantity: Math.max(0, item.quantity - ei.qty), updated_at: now() });
    await hist(t, item.id, eventId, user, 'checkout', null, at);
  } else {                                                  // ----- RETOUR
    if (!ei.out_scanned_at) return { ok: false, error: 'Départ non enregistré pour cet article' };
    if (ei.in_scanned_at) return { ok: true, duplicate: true };
    const state = ['ok', 'damaged', 'missing'].includes(op.state) ? op.state : 'ok';
    await t('event_items').where({ id: ei.id }).update({
      in_scanned_at: at, in_by: user.id, return_state: state, note: op.note || null, photo_path: savePhoto(op.photo),
    });
    if (item.kind === 'serialized') await t('items').where({ id: item.id }).update({ status: state === 'ok' ? 'available' : state, updated_at: now() });
    else {
      const back = op.qty != null && Number.isFinite(+op.qty) ? Math.max(0, +op.qty) : ei.qty;
      await t('items').where({ id: item.id }).update({ quantity: item.quantity + back, updated_at: now() });
    }
    await hist(t, item.id, eventId, user, 'checkin:' + state, op.note, at);
  }
  const rows = await t('event_items').where({ event_id: eventId });
  const status = rows.every(r => r.in_scanned_at) ? 'returned' : rows.some(r => r.out_scanned_at) ? 'out' : 'planned';
  await t('events').where({ id: eventId }).update({ status });
  return { ok: true, status };
}

app.post('/api/events/:id/scan', auth, wrap(async (req, res) => {
  const r = await db.transaction(t => applyScan(t, req.user, +req.params.id, req.body));
  if (!r.ok) return res.status(422).json(r);
  await audit(req, 'scan_' + (req.body.mode === 'in' ? 'in' : 'out'), 'event', +req.params.id, { code: req.body.code, state: req.body.state });
  res.json(r);
}));

// Synchronisation des scans faits hors ligne (File d'attente IndexedDB du client)
app.post('/api/sync', auth, wrap(async (req, res) => {
  const results = [];
  for (const op of req.body.ops || []) {
    try { results.push(await db.transaction(t => applyScan(t, req.user, +op.event_id, op))); }
    catch (e) { results.push({ ok: false, error: e.message }); }
  }
  await audit(req, 'sync', 'event', null, { n: results.length, errors: results.filter(r => !r.ok).length });
  res.json({ results });
}));

/* ---------- Tableau de bord, alertes, exports ---------- */
app.get('/api/dashboard', auth, wrap(async (req, res) => {
  const late = await db('events').where('status', 'out').where('end_at', '<', now()).orderBy('end_at');
  res.json({
    counts: await db('items').select('status').count('* as n').groupBy('status'),
    upcoming: await db('events').whereIn('status', ['planned', 'out']).where('end_at', '>=', now()).orderBy('start_at').limit(5),
    late,
  });
}));
app.get('/api/alerts', auth, wrap(async (req, res) =>
  res.json(await db('events').where('status', 'out').where('end_at', '<', now()))));

app.get('/api/events/:id/packing.pdf', auth, wrap(async (req, res) => {
  const { ev, rows } = await loadEvent(req.params.id);
  if (!ev) return res.sendStatus(404);
  res.type('pdf').set('Content-Disposition', `attachment; filename="bordereau-${ev.id}.pdf"`);
  const d = new PDFDocument({ margin: 40, size: 'A4' });
  d.pipe(res);
  const f = s => new Date(s).toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' });
  d.fontSize(18).text('Bordereau de matériel : ' + ev.name);
  d.fontSize(10).fillColor('#555').text(`${ev.location || ''}   ${f(ev.start_at)} au ${f(ev.end_at)}`).moveDown();
  d.fillColor('#000').fontSize(10);
  const line = (a, b, c, e, g, bold) => {
    if (d.y > 780) d.addPage();
    const y = d.y; d.font(bold ? 'Helvetica-Bold' : 'Helvetica');
    d.text(a, 40, y, { width: 85 }).text(b, 130, y, { width: 230 }).text(c, 365, y, { width: 40 })
      .text(e, 410, y, { width: 70 }).text(g, 485, y, { width: 70 });
    d.y = y + 18;
  };
  line('Code', 'Article', 'Qté', 'Départ', 'Retour', true);
  rows.forEach(r => line(r.code, r.name, String(r.qty), r.out_scanned_at ? '[x]' : '[ ]', r.in_scanned_at ? '[x] ' + r.return_state : '[ ]'));
  d.end();
}));

app.get('/api/events/:id/packing.xlsx', auth, wrap(async (req, res) => {
  const { ev, rows } = await loadEvent(req.params.id);
  if (!ev) return res.sendStatus(404);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Bordereau');
  ws.columns = [
    { header: 'Code', key: 'code', width: 16 }, { header: 'Article', key: 'name', width: 34 }, { header: 'Qté', key: 'qty', width: 6 },
    { header: 'Emplacement', key: 'location', width: 18 }, { header: 'N° série', key: 'serial_number', width: 18 },
    { header: 'Départ', key: 'out', width: 20 }, { header: 'Retour', key: 'in', width: 20 }, { header: 'État', key: 'state', width: 12 },
  ];
  rows.forEach(r => ws.addRow({ ...r, out: r.out_scanned_at || '', in: r.in_scanned_at || '', state: r.return_state || '' }));
  ws.getRow(1).font = { bold: true };
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="bordereau-${ev.id}.xlsx"` });
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}));

/* ---------- Administration ---------- */
app.get('/api/users', auth, need('admin'), wrap(async (req, res) =>
  res.json(await db('users').select('id', 'username', 'display_name', 'source', 'role', 'active').orderBy('username'))));
app.post('/api/users', auth, need('admin'), wrap(async (req, res) => {
  const { username, password, role = 'technician', display_name } = req.body;
  if (!username || !password || password.length < 8) return res.status(400).json({ error: 'Identifiant et mot de passe (8 caractères min.) requis' });
  const id = await ins(db, 'users', { username, display_name: display_name || username, password_hash: await bcrypt.hash(password, 11), source: 'local', role, active: true, created_at: now() });
  await audit(req, 'user_create', 'user', id, { username, role });
  res.json({ id });
}));
app.put('/api/users/:id', auth, need('admin'), wrap(async (req, res) => {
  const u = {};
  if (req.body.role) u.role = req.body.role;
  if (req.body.active !== undefined) u.active = !!req.body.active;
  if (req.body.password) u.password_hash = await bcrypt.hash(req.body.password, 11);
  await db('users').where({ id: req.params.id }).update(u);
  await audit(req, 'user_update', 'user', +req.params.id, { ...u, password_hash: undefined });
  res.json({ ok: true });
}));
app.get('/api/audit', auth, need('admin'), wrap(async (req, res) =>
  res.json(await db('audit_logs').orderBy('id', 'desc').limit(Math.min(+req.query.limit || 200, 1000)))));

/* ---------- Statique, erreurs, démarrage ---------- */
app.use('/vendor/zxing.js', (q, r) => r.sendFile(path.resolve(__dirname, '../node_modules/@zxing/library/umd/index.min.js')));
app.use(express.static(path.join(__dirname, '../public')));
app.use((e, req, res, next) => {
  const dup = /UNIQUE|23505|duplicate/i.test(String(e.code) + e.message);
  if (!dup) console.error(e);
  res.status(dup ? 409 : e.status || 500).json({ error: dup ? 'Valeur déjà utilisée (code, identifiant…)' : e.message });
});

(async () => {
  await init();
  const { ADMIN_USER: u, ADMIN_PASSWORD: p } = process.env;
  if (u && p && !(await db('users').where({ username: u }).first()))
    await ins(db, 'users', { username: u, display_name: 'Administrateur', password_hash: await bcrypt.hash(p, 11), source: 'local', role: 'admin', active: true, created_at: now() });
  const port = +process.env.PORT || 3000;
  const { SSL_CERT, SSL_KEY } = process.env;
  const server = SSL_CERT && SSL_KEY
    ? require('https').createServer({ cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) }, app)
    : require('http').createServer(app);
  server.listen(port, () => console.log(`Simplimo + : ${SSL_CERT ? 'https' : 'http'}://localhost:${port}`));
})().catch(e => { console.error(e); process.exit(1); });
