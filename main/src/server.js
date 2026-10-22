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
const webpush = require('web-push');
const { db, init, ins } = require('./db');
const { ldapLogin } = require('./ldap');

if (!process.env.JWT_SECRET) console.warn('⚠ JWT_SECRET absent : secret aléatoire (les sessions sautent à chaque redémarrage).');
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const UP = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || './data/backups');
fs.mkdirSync(UP, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const now = () => new Date().toISOString();
const loginAttempts = new Map();
const vapidReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (vapidReady) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:simplimo@fcho.net', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

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

async function notifyAll(title, body, url) {
  if (!vapidReady) return;
  const rows = await db('push_subscriptions').select('id', 'subscription');
  await Promise.all(rows.map(async row => {
    try { await webpush.sendNotification(JSON.parse(row.subscription), JSON.stringify({ title, body, url })); }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await db('push_subscriptions').where({ id: row.id }).del();
      else console.error('Web Push :', e.message);
    }
  }));
}

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
  const key = `${req.ip}:${String(username).toLowerCase()}`, attempt = loginAttempts.get(key);
  if (attempt && attempt.until > Date.now()) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
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
  if (!ok) {
    const next = attempt && attempt.n < 4 ? attempt.n + 1 : 1;
    loginAttempts.set(key, { n: next, until: next >= 5 ? Date.now() + 5 * 60 * 1000 : Date.now() + 60 * 1000 });
    await audit(req, 'login_failed', 'user', null, { username }); return res.status(401).json({ error: 'Identifiants invalides' });
  }
  loginAttempts.delete(key);
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
  const { q, status, location, category } = req.query;
  const k = db('items as i').leftJoin('categories as c', 'c.id', 'i.category_id').select('i.*', 'c.name as category').orderBy('i.name');
  if (status) k.where('i.status', status);
  if (location) k.whereRaw('lower(coalesce(i.location, \'\')) like ?', ['%' + String(location).toLowerCase() + '%']);
  if (category) k.whereRaw('lower(coalesce(c.name, \'\')) = ?', [String(category).toLowerCase()]);
  if (q) k.where(b => {
    const l = '%' + String(q).toLowerCase() + '%';
    b.whereRaw('lower(i.name) like ?', [l]).orWhereRaw('lower(i.code) like ?', [l]).orWhereRaw("lower(coalesce(i.serial_number,'')) like ?", [l]);
  });
  res.json(await k.limit(2000));
}));

app.get('/api/items/export.csv', auth, wrap(async (req, res) => {
  const rows = await db('items as i').leftJoin('categories as c', 'c.id', 'i.category_id')
    .select('i.code', 'i.name', 'c.name as category', 'i.kind', 'i.status', 'i.location', 'i.serial_number', 'i.quantity', 'i.min_quantity');
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = ['code,name,category,kind,status,location,serial_number,quantity,min_quantity',
    ...rows.map(row => Object.values(row).map(cell).join(','))].join('\r\n');
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="simplimo-items.csv"').send('\uFEFF' + csv);
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
app.post('/api/categories', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim(); if (!name) return res.status(400).json({ error: 'Nom requis' });
  res.json({ id: await ins(db, 'categories', { name }) });
}));
app.delete('/api/categories/:id', auth, need('admin', 'manager'), wrap(async (req, res) => {
  await db('items').where({ category_id: +req.params.id }).update({ category_id: null });
  await db('categories').where({ id: +req.params.id }).del(); res.json({ ok: true });
}));
app.get('/api/locations', auth, wrap(async (req, res) => res.json(await db('locations').orderBy('name'))));
app.post('/api/locations', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim(); if (!name) return res.status(400).json({ error: 'Nom requis' });
  res.json({ id: await ins(db, 'locations', { name, created_at: now() }) });
}));
app.delete('/api/locations/:id', auth, need('admin', 'manager'), wrap(async (req, res) => {
  await db('locations').where({ id: +req.params.id }).del(); res.json({ ok: true });
}));

app.post('/api/items/import.csv', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const lines = String(req.body?.csv || '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return res.status(400).json({ error: 'CSV vide ou incomplet' });
  const headers = lines.shift().split(',').map(x => x.trim().toLowerCase());
  const rows = lines.map(line => line.split(',').map(x => x.trim().replace(/^"|"$/g, '')))
    .map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] || ''])));
  let created = 0;
  for (const row of rows) {
    if (!row.name) continue;
    const category = row.category ? await catId(row.category) : null;
    await db('items').insert({ code: row.code || genCode(), name: row.name, category_id: category, kind: row.kind === 'consumable' ? 'consumable' : 'serialized', status: row.status || 'available', location: row.location || null, serial_number: row.serial_number || null, quantity: Math.max(0, +row.quantity || 1), min_quantity: Math.max(0, +row.min_quantity || 0), created_at: now(), updated_at: now() });
    created++;
  }
  res.json({ created });
}));

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
  if (!d.ev) return res.status(404).json({ error: 'Introuvable' });
  d.tasks = await db('event_tasks').where({ event_id: +req.params.id }).orderBy('id');
  d.report = await db('event_reports').where({ event_id: +req.params.id }).first();
  res.json(d);
}));

app.get('/api/events/:id/calendar.ics', auth, wrap(async (req, res) => {
  const ev = await db('events').where({ id: +req.params.id }).first();
  if (!ev) return res.sendStatus(404);
  const clean = value => String(value || '').replace(/[\\,;|]/g, ' ');
  const dt = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  res.type('text/calendar').set('Content-Disposition', `attachment; filename="event-${ev.id}.ics"`).send(
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Simplimo+//FR\r\nBEGIN:VEVENT\r\nUID:simplimo-${ev.id}@simplimo\r\nDTSTART:${dt(ev.start_at)}\r\nDTEND:${dt(ev.end_at)}\r\nSUMMARY:${clean(ev.name)}\r\nLOCATION:${clean(ev.location)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
}));
app.post('/api/events/:id/tasks', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const title = String(req.body?.title || '').trim(); if (!title) return res.status(400).json({ error: 'Tâche requise' });
  res.json({ id: await ins(db, 'event_tasks', { event_id: +req.params.id, title, assigned_to: req.body.assigned_to || null, created_at: now() }) });
}));
app.put('/api/events/:id/tasks/:taskId', auth, need('admin', 'manager'), wrap(async (req, res) => {
  await db('event_tasks').where({ id: +req.params.taskId, event_id: +req.params.id }).update({ done: !!req.body.done, assigned_to: req.body.assigned_to || null }); res.json({ ok: true });
}));
app.delete('/api/events/:id/tasks/:taskId', auth, need('admin', 'manager'), wrap(async (req, res) => {
  await db('event_tasks').where({ id: +req.params.taskId, event_id: +req.params.id }).del(); res.json({ ok: true });
}));
app.put('/api/events/:id/report', auth, wrap(async (req, res) => {
  await db('event_reports').insert({ event_id: +req.params.id, comment: req.body.comment || null, signature: req.body.signature || null, updated_at: now() })
    .onConflict('event_id').merge({ comment: req.body.comment || null, signature: req.body.signature || null, updated_at: now() });
  res.json({ ok: true });
}));

app.post('/api/events/:id/duplicate', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const source = await loadEvent(+req.params.id);
  if (!source.ev) return res.status(404).json({ error: 'Introuvable' });
  const start = req.body.start_at || source.ev.start_at;
  const end = req.body.end_at || source.ev.end_at;
  if (!validDates(start, end)) return res.status(400).json({ error: 'Période valide requise' });
  const itemIds = source.rows.map(r => r.item_id);
  const c = await conflicts(itemIds, start, end);
  if (c.length) return res.status(409).json({ error: 'Conflit de réservation', conflicts: c });
  const id = await db.transaction(async t => {
    const eid = await ins(t, 'events', {
      name: req.body.name || `${source.ev.name} (copie)`, location: req.body.location ?? source.ev.location,
      start_at: start, end_at: end, created_by: req.user.id, created_at: now(),
    });
    for (const row of source.rows) await t('event_items').insert({ event_id: eid, item_id: row.item_id, qty: row.qty });
    return eid;
  });
  await audit(req, 'event_duplicate', 'event', id, { source_id: source.ev.id });
  res.json({ id });
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
  if (['damaged', 'missing'].includes(req.body.state)) await notifyAll('Article à vérifier', `${req.body.code} est ${req.body.state === 'damaged' ? 'endommagé' : 'manquant'}.`, `#/events/${req.params.id}`);
  res.json(r);
}));

app.post('/api/events/:id/finish', auth, wrap(async (req, res) => {
  const ev = await db('events').where({ id: +req.params.id }).first();
  if (!ev) return res.status(404).json({ error: 'Événement introuvable' });
  const mode = req.body?.mode === 'out' ? 'out' : 'in';
  const pending = await db('event_items').where({ event_id: ev.id }).whereNull(mode === 'out' ? 'out_scanned_at' : 'in_scanned_at');
  if (pending.length) return res.status(409).json({ error: `${pending.length} article(s) doivent encore être traité(s) avant la clôture`, pending: pending.length });
  const tasks = await db('event_tasks').where({ event_id: ev.id, done: false });
  if (tasks.length) return res.status(409).json({ error: `${tasks.length} tâche(s) de préparation ne sont pas terminée(s)`, tasks: tasks.length });
  await db('events').where({ id: ev.id }).update({ status: 'finished' });
  await audit(req, 'event_finish', 'event', ev.id, { name: ev.name });
  await notifyAll('Rapport terminé', `${ev.name} a terminé son rapport.`, `#/events/${ev.id}`);
  res.json({ ok: true });
}));

app.get('/api/push/config', auth, (req, res) => {
  if (!vapidReady) return res.status(503).json({ error: 'Notifications push non configurées sur le serveur' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', auth, wrap(async (req, res) => {
  if (!vapidReady) return res.status(503).json({ error: 'Notifications push non configurées sur le serveur' });
  const subscription = req.body?.subscription;
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth)
    return res.status(400).json({ error: 'Abonnement push invalide' });
  await db('push_subscriptions').insert({ user_id: req.user.id, subscription: JSON.stringify(subscription), created_at: now() }).onConflict('subscription').merge({ user_id: req.user.id });
  res.json({ ok: true });
}));

app.post('/api/push/test', auth, wrap(async (req, res) => {
  if (!vapidReady) return res.status(503).json({ error: 'Notifications push non configurées sur le serveur' });
  await notifyAll('Notification de test', `${req.user.name} a envoyé une notification de test.`, '#/settings');
  res.json({ ok: true });
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

app.post('/api/inventories', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const name = String(req.body?.name || `Inventaire ${new Date().toLocaleDateString('fr-CA')}`).trim();
  res.json({ id: await ins(db, 'inventory_sessions', { name, created_by: req.user.id, created_at: now() }) });
}));
app.get('/api/inventories', auth, wrap(async (req, res) => res.json(await db('inventory_sessions').orderBy('id', 'desc'))));
app.get('/api/inventories/:id', auth, wrap(async (req, res) => {
  const session = await db('inventory_sessions').where({ id: +req.params.id }).first();
  if (!session) return res.sendStatus(404);
  const scans = await db('inventory_scans as s').join('items as i', 'i.id', 's.item_id').where('s.session_id', session.id).select('s.*', 'i.code', 'i.name', 'i.quantity as expected_quantity', 'i.location');
  res.json({ session, scans });
}));
app.post('/api/inventories/:id/scan', auth, wrap(async (req, res) => {
  const session = await db('inventory_sessions').where({ id: +req.params.id, status: 'open' }).first();
  const item = await db('items').where({ code: String(req.body?.code || '') }).first();
  if (!session || !item) return res.status(422).json({ error: !session ? 'Inventaire fermé ou introuvable' : 'Code inconnu' });
  await db('inventory_scans').insert({ session_id: session.id, item_id: item.id, quantity: Math.max(1, +req.body.quantity || 1), scanned_at: now(), scanned_by: req.user.id })
    .onConflict(['session_id', 'item_id']).merge({ quantity: Math.max(1, +req.body.quantity || 1), scanned_at: now(), scanned_by: req.user.id });
  res.json({ ok: true, item });
}));
app.post('/api/inventories/:id/close', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const session = await db('inventory_sessions').where({ id: +req.params.id, status: 'open' }).first();
  if (!session) return res.status(404).json({ error: 'Inventaire introuvable ou déjà fermé' });
  await db('inventory_sessions').where({ id: session.id }).update({ status: 'closed', closed_at: now() });
  res.json({ ok: true });
}));

app.get('/api/preferences/notifications', auth, wrap(async (req, res) => {
  const p = await db('notification_preferences').where({ user_id: req.user.id }).first();
  res.json(p || { late_returns: true, low_stock: true, event_reminders: true, scan_alerts: true });
}));
app.put('/api/preferences/notifications', auth, wrap(async (req, res) => {
  const row = { user_id: req.user.id, late_returns: req.body.late_returns !== false, low_stock: req.body.low_stock !== false, event_reminders: req.body.event_reminders !== false, scan_alerts: req.body.scan_alerts !== false };
  await db('notification_preferences').insert(row).onConflict('user_id').merge(row); res.json({ ok: true });
}));

app.get('/api/templates', auth, need('admin', 'manager'), wrap(async (req, res) => res.json(await db('event_templates').orderBy('name'))));
app.post('/api/templates', auth, need('admin', 'manager'), wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim(); if (!name) return res.status(400).json({ error: 'Nom requis' });
  const id = await ins(db, 'event_templates', { name, items: JSON.stringify(req.body.items || []), tasks: JSON.stringify(req.body.tasks || []), created_by: req.user.id, created_at: now() });
  res.json({ id });
}));
app.delete('/api/templates/:id', auth, need('admin', 'manager'), wrap(async (req, res) => { await db('event_templates').where({ id: +req.params.id }).del(); res.json({ ok: true }); }));

/* ---------- Tableau de bord, alertes, exports ---------- */
app.get('/api/dashboard', auth, wrap(async (req, res) => {
  const late = await db('events').where('status', 'out').where('end_at', '<', now()).orderBy('end_at');
  const lowStock = await db('items').where('kind', 'consumable').whereRaw('quantity <= min_quantity').orderBy('quantity').limit(10);
  const recent = await db('item_history').orderBy('at', 'desc').limit(10);
  res.json({
    counts: await db('items').select('status').count('* as n').groupBy('status'),
    upcoming: await db('events').whereIn('status', ['planned', 'out']).where('end_at', '>=', now()).orderBy('start_at').limit(5),
    late,
    lowStock,
    recent,
  });
}));
app.get('/api/alerts', auth, wrap(async (req, res) => res.json({
  late: await db('events').where('status', 'out').where('end_at', '<', now()),
  lowStock: await db('items').where('kind', 'consumable').whereRaw('quantity <= min_quantity').limit(20),
})));

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
const backupTables = ['users', 'categories', 'items', 'item_documents', 'events', 'event_items', 'item_history', 'audit_logs', 'push_subscriptions'];
app.get('/api/admin/backups', auth, need('admin'), wrap(async (req, res) => {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort().reverse();
  res.json(files.map(name => ({ name, size: fs.statSync(path.join(BACKUP_DIR, name)).size })));
}));
app.post('/api/admin/backups', auth, need('admin'), wrap(async (req, res) => {
  const snapshot = { version: 1, created_at: now(), tables: {} };
  for (const table of backupTables) snapshot.tables[table] = await db(table);
  const name = `simplimo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(snapshot));
  await audit(req, 'backup_create', 'system', null, { name });
  res.json({ name });
}));
app.get('/api/admin/backups/:name', auth, need('admin'), (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(BACKUP_DIR, name);
  if (!name.endsWith('.json') || !fs.existsSync(file)) return res.sendStatus(404);
  res.download(file, name);
});
app.post('/api/admin/backups/:name/restore', auth, need('admin'), wrap(async (req, res) => {
  const name = path.basename(req.params.name), file = path.join(BACKUP_DIR, name);
  if (!name.endsWith('.json') || !fs.existsSync(file)) return res.sendStatus(404);
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const allowed = backupTables.filter(table => Array.isArray(snapshot.tables?.[table]));
  await db.transaction(async t => {
    for (const table of [...allowed].reverse()) await t(table).del();
    for (const table of allowed) if (snapshot.tables[table].length) await t(table).insert(snapshot.tables[table]);
  });
  await audit(req, 'backup_restore', 'system', null, { name });
  res.json({ ok: true });
}));
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
