import { qAdd, qAll, qDel, cSet, cGet } from './idb.js';
import { createScanner } from './scanner.js';

/* ---------- Utilitaires ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = iso => iso ? new Date(iso).toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' }) : '';
const ST = { available: ['Disponible', 'var(--ok)'], in_event: ['En événement', 'var(--warn)'], damaged: ['Endommagé', 'var(--bad)'], missing: ['Manquant', 'var(--bad)'] };
const badge = s => `<span class="badge" style="--c:${ST[s]?.[1] || 'var(--mute)'}">${ST[s]?.[0] || esc(s)}</span>`;
const ROLES = { admin: 'Administrateur', manager: 'Responsable événement', technician: 'Technicien' };
const IC = { home: 'M3 11l9-8 9 8v10H3z', box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10', scan: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M4 12h16', cal: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4', menu: 'M4 6h16M4 12h16M4 18h16', log: 'M5 4h14v16H5zM9 9h6M9 13h6', user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6', cog: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 1-2-1-1-2h-4l-1 2-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1 1 2h4l1-2 2-1 2 1 2-4-2-1z', out: 'M10 4H4v16h6M15 8l4 4-4 4M19 12H9', sync: 'M20 8a8 8 0 00-14-2M4 4v4h4M4 16a8 8 0 0014 2M20 20v-4h-4' };
const ic = n => `<svg class="i" viewBox="0 0 24 24"><path d="${IC[n]}"/></svg>`;
const prefs = () => JSON.parse(localStorage.prefs || '{}');
const savePrefs = p => { localStorage.prefs = JSON.stringify({ ...prefs(), ...p }); applyPrefs(); };
let token = localStorage.token || '', me = JSON.parse(localStorage.me || 'null'), scanner = null;
const can = (...r) => me && r.includes(me.role);

function applyPrefs() {
  const p = prefs(), root = document.documentElement;
  root.dataset.theme = p.theme || 'light';
  if (p.accent) root.style.setProperty('--blue', p.accent); else root.style.removeProperty('--blue');
  const lg = $('#lg'); if (lg) lg.src = p.logo || '/icons/icon-192.png';
}
function toast(msg, bad) {
  const t = Object.assign(document.createElement('div'), { className: 'toast' + (bad ? ' bad' : ''), textContent: msg });
  document.body.append(t); setTimeout(() => t.remove(), 3200);
}
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body && JSON.stringify(body) });
  if (r.status === 401 && token) { logout(); throw new Error('auth'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { data: j, status: r.status });
  return j;
}
const main = html => { const m = $('#main'); m.innerHTML = html; return m; };
const form = f => Object.fromEntries(new FormData(f));
const q = s => encodeURIComponent(s);
const shrink = f => new Promise(res => {
  const i = new Image();
  i.onload = () => {
    const s = Math.min(1, 1280 / Math.max(i.width, i.height)), c = document.createElement('canvas');
    c.width = i.width * s; c.height = i.height * s; c.getContext('2d').drawImage(i, 0, 0, c.width, c.height);
    res(c.toDataURL('image/jpeg', .8));
  };
  i.src = URL.createObjectURL(f);
});

/* ---------- Connexion / coquille ---------- */
function login() {
  $('#app').innerHTML = `<form class="login" id="lf"><img id="lg" src="${prefs().logo || '/icons/icon-192.png'}" alt=""><h1>Simplimo +</h1>
    <input name="username" placeholder="Identifiant" autocomplete="username" required>
    <input name="password" type="password" placeholder="Mot de passe" autocomplete="current-password" required>
    <button class="btn" style="width:100%">Se connecter</button><p class="err" id="le"></p></form>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('/login', { method: 'POST', body: form(e.target) });
      token = localStorage.token = r.token; me = r.me; localStorage.me = JSON.stringify(me);
      boot();
    } catch (err) { $('#le').textContent = err instanceof TypeError ? 'Serveur injoignable' : err.message; }
  };
}
function logout() { token = ''; me = null; localStorage.removeItem('token'); localStorage.removeItem('me'); login(); }

const NAV = [['#/', 'Accueil', 'home'], ['#/items', 'Inventaire', 'box'], ['#/scanner', 'Scanner', 'scan'], ['#/events', 'Événements', 'cal']];
const more = () => [['#/audit', 'Journal d’audit', 'log', 'admin'], ['#/users', 'Utilisateurs', 'user', 'admin'], ['#/settings', 'Réglages', 'cog']].filter(l => !l[3] || can(l[3]));
const link = ([h, l, i]) => `<a href="${h}" data-h="${h}">${ic(i)}<span>${l}</span></a>`;

function boot() {
  $('#app').innerHTML = `<div class="shell${localStorage.min ? ' min' : ''}" id="sh">
    <aside class="side">${[...NAV, ...more()].map(link).join('')}<a href="#" id="mn">${ic('menu')}<span>Réduire le menu</span></a><a href="#" id="lo">${ic('out')}<span>Déconnexion</span></a></aside>
    <div><header class="top"><button class="burger" id="bg" aria-label="Ouvrir le menu">${ic('menu')}</button><img id="lg" alt="">
      <b>Simplimo +</b><span class="chip" id="st"></span></header><main id="main"></main></div>
    <nav class="bottom">${NAV.map(link).join('')}</nav><div class="scrim" id="sc"></div>
    <aside class="drawer" id="dr"><p class="mute" style="padding:0 .75rem">${esc(me.name)} · ${ROLES[me.role]}</p>
      ${[...NAV, ...more()].map(link).join('')}<a href="#" id="sy">${ic('sync')}<span>Synchroniser</span></a>
      <a href="#" id="lo2">${ic('out')}<span>Déconnexion</span></a></aside></div>`;
  $('#bg').onclick = () => drawer(true); $('#sc').onclick = () => drawer(false);
  $('#mn').onclick = e => { e.preventDefault(); $('#sh').classList.toggle('min'); localStorage.min = $('#sh').classList.contains('min') ? '1' : ''; };
  $('#lo').onclick = $('#lo2').onclick = e => { e.preventDefault(); logout(); };
  $('#sy').onclick = e => { e.preventDefault(); drawer(false); sync(true); };
  applyPrefs(); updateStatus(); route(); sync(); poll();
}
const drawer = o => { $('#dr')?.classList.toggle('open', o); $('#sc')?.classList.toggle('open', o); };
let sx = 0, sy = 0;
document.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
document.addEventListener('touchend', e => {   // glisser vers la droite = ouvrir le menu, vers la gauche = fermer
  if (!token || innerWidth >= 900) return;
  const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
  if (Math.abs(dy) > 45) return;
  if (dx > 80 && sx < innerWidth * .6) drawer(true); else if (dx < -70) drawer(false);
}, { passive: true });

async function updateStatus() {
  const n = (await qAll().catch(() => [])).length, s = $('#st'); if (!s) return;
  s.className = 'chip' + (navigator.onLine ? '' : ' off');
  s.textContent = !navigator.onLine ? 'Hors ligne' + (n ? ` · ${n}` : '') : n ? `${n} à synchroniser` : 'En ligne';
}

/* ---------- Routeur ---------- */
const routes = [[/^#\/?$/, dashboard], [/^#\/items(?:\?s=(\w+))?$/, items], [/^#\/items\/new$/, () => itemForm()], [/^#\/items\/(\d+)\/edit$/, itemForm], [/^#\/items\/(\d+)$/, itemView],
  [/^#\/events$/, events], [/^#\/events\/new$/, eventForm], [/^#\/events\/(\d+)$/, eventView], [/^#\/scan\/(\d+)\/(out|in)$/, eventScan], [/^#\/scanner$/, quickScan],
  [/^#\/audit$/, audit], [/^#\/users$/, users], [/^#\/settings$/, settings]];
async function route() {
  stopScan(); drawer(false);
  if (!token) return login();
  const h = location.hash || '#/';
  document.querySelectorAll('[data-h]').forEach(a => a.classList.toggle('on', a.dataset.h === '#/' ? h === '#/' : h.startsWith(a.dataset.h)));
  for (const [re, fn] of routes) {
    const m = re.exec(h);
    if (m) { try { await fn(...m.slice(1)); } catch (e) { if (e.message !== 'auth') main(`<p class="err">${esc(e.message)}</p>`); } scrollTo(0, 0); return; }
  }
  location.hash = '#/';
}
addEventListener('hashchange', route);

/* ---------- Accueil ---------- */
const SHORT = { scanner: ['#/scanner', 'Scanner'], 'items/new': ['#/items/new', 'Nouvel article'], 'events/new': ['#/events/new', 'Nouvel événement'], events: ['#/events', 'Calendrier'] };
const list = evs => evs.length ? evs.map(e => `<a class="row" href="#/events/${e.id}"><div class="grow"><b>${esc(e.name)}</b><small>${fmt(e.start_at)} → ${fmt(e.end_at)}</small></div>${badge(e.status === 'planned' ? 'available' : e.status === 'out' ? 'in_event' : 'available').replace(/>[^<]+</, `>${{ planned: 'Planifié', out: 'En cours', returned: 'Terminé' }[e.status]}<`)}</a>`).join('') : '<p class="mute">Aucun événement à venir.</p>';
async function dashboard() {
  const d = await api('/dashboard'), c = Object.fromEntries(d.counts.map(x => [x.status, +x.n]));
  const sc = prefs().shortcuts || ['scanner', 'items/new', 'events/new'];
  main(`<h2>Tableau de bord</h2><div class="stats">${Object.keys(ST).map(k => `<a class="stat" href="#/items?s=${k}" style="--c:${ST[k][1]}"><b>${c[k] || 0}</b><span>${ST[k][0]}</span></a>`).join('')}</div>
    ${d.late.length ? `<section class="alert"><h3>Retards de retour</h3>${d.late.map(e => `<a href="#/events/${e.id}">${esc(e.name)} : retour prévu ${fmt(e.end_at)}</a>`).join('')}</section>` : ''}
    <h3>Prochains événements</h3>${list(d.upcoming)}
    <div class="quick">${sc.filter(k => SHORT[k]).map(k => `<a class="btn ghost" href="${SHORT[k][0]}">${SHORT[k][1]}</a>`).join('')}</div>`);
}

/* ---------- Inventaire ---------- */
function printLabels(arr, type) {
  const w = open('', '_blank'); if (!w) return toast('Autorisez les fenêtres pop-up', true);
  w.document.write(`<title>Étiquettes</title><style>body{font:12px sans-serif;display:flex;flex-wrap:wrap;gap:6px;margin:8px}.l{width:55mm;border:1px dashed #999;padding:3mm;text-align:center;break-inside:avoid}img{max-width:100%;height:24mm;object-fit:contain}</style>` +
    arr.map(i => `<div class="l"><img src="/api/items/${i.id}/label.png?type=${type}&t=${token}"><div>${esc(i.name)}</div><div>${esc(i.code)}</div></div>`).join(''));
  w.document.close(); w.onload = () => setTimeout(() => w.print(), 300);
}
async function items(s = '') {
  main(`<h2>Inventaire</h2><div class="bar"><input id="q" type="search" placeholder="Nom, code, n° de série"><select id="st"><option value="">Tous les états</option>${Object.entries(ST).map(([k, v]) => `<option value="${k}"${k === s ? ' selected' : ''}>${v[0]}</option>`).join('')}</select>
    ${can('admin', 'manager') ? '<a class="btn" href="#/items/new">Ajouter</a>' : ''}</div><div id="rows"></div>
    <div class="bar" style="margin-top:1rem"><select id="lt"><option value="qrcode">QR code</option><option value="code128">Code 128</option><option value="datamatrix">Data Matrix</option></select><button class="btn ghost" id="lab">Imprimer les étiquettes affichées</button></div>`);
  let data = [];
  const draw = () => {
    $('#rows').innerHTML = data.length ? data.map(i => `<a class="row" href="#/items/${i.id}"><div class="grow"><b>${esc(i.name)}</b><small>${esc(i.code)}${i.category ? ' · ' + esc(i.category) : ''}${i.location ? ' · ' + esc(i.location) : ''}</small></div>${i.kind === 'consumable' ? `<small>${i.quantity} en stock</small>` : ''}${badge(i.status)}</a>`).join('') : '<p class="mute">Aucun article. Ajoutez-en un ou changez le filtre.</p>';
  };
  const load = async () => {
    const t = $('#q').value.trim().toLowerCase(), st = $('#st').value;
    try { data = await api(`/items?q=${q(t)}&status=${st}`); if (!t && !st) cSet('items', data); }
    catch (e) { if (!(e instanceof TypeError)) throw e; data = ((await cGet('items')) || []).filter(i => (!st || i.status === st) && (!t || [i.name, i.code, i.serial_number].join(' ').toLowerCase().includes(t))); }
    draw();
  };
  $('#q').oninput = load; $('#st').onchange = load; $('#lab').onclick = () => printLabels(data, $('#lt').value);
  await load();
}
async function itemForm(id) {
  let it = { kind: 'serialized', status: 'available', quantity: 1, min_quantity: 0 };
  if (id) it = (await api('/items/' + id)).item;
  const cats = await api('/categories').catch(() => []);
  main(`<h2>${id ? 'Modifier l’article' : 'Nouvel article'}</h2><form id="f">
    <label>Nom</label><input name="name" required value="${esc(it.name)}">
    <div class="grid2"><div><label>Type</label><select name="kind"><option value="serialized">Sérialisé (suivi à l’unité)</option><option value="consumable">Consommable (quantité)</option></select></div>
    <div><label>État</label><select name="status">${Object.entries(ST).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select></div></div>
    <label>Catégorie</label><input name="category" list="cats" value="${esc(it.category)}"><datalist id="cats">${cats.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist>
    <div class="grid2"><div><label>Emplacement</label><input name="location" value="${esc(it.location)}"></div><div><label>Numéro de série</label><input name="serial_number" value="${esc(it.serial_number)}"></div></div>
    <div class="grid2"><div><label>Quantité en stock</label><input type="number" min="0" name="quantity" value="${it.quantity}"></div><div><label>Seuil d’alerte</label><input type="number" min="0" name="min_quantity" value="${it.min_quantity}"></div></div>
    <label>Code (vide = généré automatiquement)</label><input name="code" value="${esc(it.code)}"><label>Notes</label><textarea name="notes" rows="3">${esc(it.notes)}</textarea>
    <button class="btn">Enregistrer</button> <p class="err" id="fe"></p></form>`);
  const f = $('#f'); f.kind.value = it.kind; f.status.value = it.status;
  f.onsubmit = async e => {
    e.preventDefault();
    try { const r = await api(id ? '/items/' + id : '/items', { method: id ? 'PUT' : 'POST', body: form(f) }); location.hash = '#/items/' + (id || r.id); }
    catch (err) { $('#fe').textContent = err.message; }
  };
}
async function itemView(id) {
  const { item: it, docs, history } = await api('/items/' + id), t = '?t=' + token, ed = can('admin', 'manager');
  main(`<h2>${esc(it.name)}</h2><p>${badge(it.status)} <span class="mute">${esc(it.code)}</span></p>
    ${it.photo_path ? `<img class="photo" src="/uploads/${it.photo_path}${t}" alt="">` : ''}
    <div class="card">${[['Catégorie', it.category], ['Type', it.kind === 'serialized' ? 'Sérialisé' : `Consommable (${it.quantity} en stock)`], ['Emplacement', it.location], ['N° de série', it.serial_number], ['Notes', it.notes]].filter(r => r[1]).map(r => `<div><span class="mute">${r[0]} :</span> ${esc(r[1])}</div>`).join('')}</div>
    ${ed ? `<a class="btn ghost" href="#/items/${id}/edit">Modifier</a>` : ''}
    <h3>Étiquettes</h3><div class="labels">${['qrcode', 'code128', 'datamatrix'].map(k => `<a href="#" data-l="${k}"><img src="/api/items/${id}/label.png?type=${k}&t=${token}" alt="${k}"></a>`).join('')}</div><p class="mute">Touchez une étiquette pour l’imprimer.</p>
    <h3>Notices et documents</h3>${docs.map(d => `<div><a href="/uploads/${d.path}${t}" target="_blank">${esc(d.title)}</a></div>`).join('') || '<p class="mute">Aucun document.</p>'}
    ${ed ? `<label>Ajouter une photo</label><input type="file" accept="image/*" data-k="photo"><label>Ajouter une notice (PDF)</label><input type="file" accept="application/pdf" data-k="doc">` : ''}
    <h3>Historique</h3>${history.map(h => `<div class="check"><div class="grow">${esc(h.action)}${h.note ? ' · ' + esc(h.note) : ''}<br><small class="mute">${esc(h.username || '')} · ${fmt(h.at)}</small></div></div>`).join('')}`);
  document.querySelectorAll('[data-l]').forEach(a => a.onclick = e => { e.preventDefault(); printLabels([it], a.dataset.l); });
  document.querySelectorAll('input[type=file]').forEach(inp => inp.onchange = async () => {
    const fd = new FormData(); fd.append('kind', inp.dataset.k); fd.append('file', inp.files[0]);
    const r = await fetch(`/api/items/${id}/files`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    r.ok ? itemView(id) : toast((await r.json()).error, true);
  });
}

/* ---------- Événements ---------- */
let cal = { y: new Date().getFullYear(), m: new Date().getMonth() };
async function events() {
  let evs; try { evs = await api('/events'); cSet('events', evs); } catch (e) { if (!(e instanceof TypeError)) throw e; evs = (await cGet('events')) || []; }
  const view = localStorage.evView || 'cal';
  let body;
  if (view === 'cal') {
    const start = (new Date(cal.y, cal.m, 1).getDay() + 6) % 7, days = new Date(cal.y, cal.m + 1, 0).getDate();
    const cells = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(d => `<div class="h">${d}</div>`);
    for (let i = 0; i < start; i++) cells.push('<div></div>');
    for (let d = 1; d <= days; d++) {
      const t0 = new Date(cal.y, cal.m, d).getTime(), t1 = t0 + 864e5;
      cells.push(`<div><b>${d}</b>${evs.filter(e => Date.parse(e.start_at) < t1 && Date.parse(e.end_at) >= t0).map(e => `<a href="#/events/${e.id}">${esc(e.name)}</a>`).join('')}</div>`);
    }
    body = `<div class="bar"><button class="btn ghost tiny" id="pv">◀</button><b style="flex:1;text-align:center">${new Date(cal.y, cal.m, 1).toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })}</b><button class="btn ghost tiny" id="nx">▶</button></div><div class="cal">${cells.join('')}</div>`;
  } else body = list(evs);
  main(`<h2>Événements</h2><div class="bar"><button class="btn ghost tiny" id="vw">${view === 'cal' ? 'Voir la liste' : 'Voir le calendrier'}</button>${can('admin', 'manager') ? '<a class="btn" href="#/events/new">Nouvel événement</a>' : ''}</div>${body}`);
  $('#vw').onclick = () => { localStorage.evView = view === 'cal' ? 'list' : 'cal'; events(); };
  if (view === 'cal') {
    $('#pv').onclick = () => { cal.m--; if (cal.m < 0) { cal.m = 11; cal.y--; } events(); };
    $('#nx').onclick = () => { cal.m++; if (cal.m > 11) { cal.m = 0; cal.y++; } events(); };
  }
}
async function eventForm() {
  let all; try { all = await api('/items'); } catch { all = []; }
  main(`<h2>Nouvel événement</h2><form id="f"><label>Nom</label><input name="name" required><label>Lieu</label><input name="location">
    <div class="grid2"><div><label>Début</label><input type="datetime-local" name="start" required></div><div><label>Fin</label><input type="datetime-local" name="end" required></div></div>
    <h3>Matériel requis</h3><input id="fi" type="search" placeholder="Filtrer le matériel"><div id="pick" style="max-height:40vh;overflow:auto"></div>
    <p class="err" id="fe"></p><button class="btn">Créer l’événement</button></form>`);
  const sel = new Map();
  const draw = () => {
    const t = $('#fi').value.toLowerCase();
    $('#pick').innerHTML = all.filter(i => !t || (i.name + i.code).toLowerCase().includes(t)).map(i => `<label class="check"><input type="checkbox" style="width:auto;margin:0" data-id="${i.id}"${sel.has(i.id) ? ' checked' : ''}>
      <span class="grow">${esc(i.name)}<br><small class="mute">${esc(i.code)}</small></span>${i.kind === 'consumable' ? `<input type="number" min="1" value="${sel.get(i.id) || 1}" style="width:5rem;margin:0" data-q="${i.id}" aria-label="Quantité">` : ''}${badge(i.status)}</label>`).join('');
    document.querySelectorAll('[data-id]').forEach(c => c.onchange = () => c.checked ? sel.set(+c.dataset.id, 1) : sel.delete(+c.dataset.id));
    document.querySelectorAll('[data-q]').forEach(n => n.oninput = () => sel.has(+n.dataset.q) && sel.set(+n.dataset.q, +n.value || 1));
  };
  $('#fi').oninput = draw; draw();
  $('#f').onsubmit = async e => {
    e.preventDefault(); const v = form(e.target);
    try {
      const r = await api('/events', { method: 'POST', body: { name: v.name, location: v.location, start_at: new Date(v.start).toISOString(), end_at: new Date(v.end).toISOString(), items: [...sel].map(([item_id, qty]) => ({ item_id, qty })) } });
      location.hash = '#/events/' + r.id;
    } catch (err) {
      $('#fe').innerHTML = esc(err.message) + (err.data?.conflicts ? '<br>' + err.data.conflicts.map(c => `${esc(c.item)} (${esc(c.code)}) est déjà réservé pour « ${esc(c.event)} »`).join('<br>') : '');
    }
  };
}
async function eventView(id) {
  let d; try { d = await api('/events/' + id); cSet('event:' + id, d); } catch (e) { if (!(e instanceof TypeError)) throw e; d = await cGet('event:' + id); if (!d) throw new Error('Événement non disponible hors ligne'); }
  const { ev, rows } = d, mg = can('admin', 'manager'), t = '?t=' + token;
  const ass = new Set(rows.map(r => r.item_id)), pool = mg ? (await api('/items').catch(() => cGet('items')) || []).filter(i => !ass.has(i.id)) : [];
  main(`<h2>${esc(ev.name)}</h2><p class="mute">${esc(ev.location || '')} · ${fmt(ev.start_at)} → ${fmt(ev.end_at)}</p>
    <div class="quick" style="margin:0 0 1rem"><a class="btn" href="#/scan/${id}/out">Scan de départ</a><a class="btn" href="#/scan/${id}/in">Scan de retour</a>
      <a class="btn ghost" href="/api/events/${id}/packing.pdf${t}">Bordereau PDF</a><a class="btn ghost" href="/api/events/${id}/packing.xlsx${t}">Excel</a></div>
    ${rows.map(r => `<div class="check"><div class="grow"><b>${esc(r.name)}</b>${r.kind === 'consumable' ? ' × ' + r.qty : ''}<br><small class="mute">${esc(r.code)}</small></div>
      ${r.in_scanned_at ? badge(r.return_state === 'ok' ? 'available' : r.return_state).replace(/>[^<]+</, `>Retour ${r.return_state === 'ok' ? 'OK' : ST[r.return_state][0]}<`) : r.out_scanned_at ? badge('in_event') : '<span class="mute">À sortir</span>'}
      ${mg && !r.out_scanned_at ? `<button class="btn ghost tiny" data-rm="${r.item_id}">Retirer</button>` : ''}</div>`).join('') || '<p class="mute">Aucun matériel attribué.</p>'}
    ${mg ? `<h3>Ajouter du matériel</h3><div class="bar"><select id="ad">${pool.map(i => `<option value="${i.id}">${esc(i.name)} (${esc(i.code)})</option>`).join('')}</select><button class="btn" id="adb">Ajouter</button></div><p class="err" id="fe"></p>
      ${ev.status === 'planned' ? '<button class="btn bad tiny" id="del">Supprimer l’événement</button>' : ''}` : ''}`);
  document.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { await api(`/events/${id}/items/${b.dataset.rm}`, { method: 'DELETE' }); eventView(id); });
  $('#adb') && ($('#adb').onclick = async () => {
    try { await api(`/events/${id}/items`, { method: 'POST', body: { item_id: $('#ad').value } }); eventView(id); }
    catch (err) { $('#fe').innerHTML = esc(err.message) + (err.data?.conflicts ? ' : ' + err.data.conflicts.map(c => `${esc(c.item)} déjà sur « ${esc(c.event)} »`).join(', ') : ''); }
  });
  $('#del') && ($('#del').onclick = async () => { if (confirm('Supprimer cet événement ?')) { await api('/events/' + id, { method: 'DELETE' }); location.hash = '#/events'; } });
}

/* ---------- Scanner, check-out / check-in ---------- */
function stopScan() { scanner?.stop(); scanner = null; }
async function startCam(onCode) {
  const cam = $('#cam'); if (!cam) return;
  scanner = createScanner($('#v'), onCode);
  try {
    await scanner.start();
    if (scanner.torchSupported()) { const b = $('#tl'); b.hidden = false; b.onclick = async () => { b.textContent = (await scanner.toggleTorch()) ? 'Flash : activé' : 'Flash : désactivé'; }; }
  } catch (e) { cam.insertAdjacentHTML('afterend', `<p class="err">Caméra indisponible (${esc(e.name)}). Sur téléphone, la caméra exige une connexion HTTPS et l’autorisation d’accès.</p>`); }
}
const camHtml = '<div class="cam" id="cam"><video id="v" playsinline muted></video><div class="ret"></div><button class="btn tiny" id="tl" hidden>Flash : désactivé</button></div>';
const flash = (cls, msg) => { const c = $('#cam'); if (!c) return; c.className = 'cam ' + cls; navigator.vibrate?.(cls === 'ok' ? 60 : [80, 60, 80]); if (msg) toast(msg, cls === 'bad'); setTimeout(() => c.className = 'cam', 700); };

async function eventScan(id, mode) {
  let d; try { d = await api('/events/' + id); cSet('event:' + id, d); } catch (e) { if (!(e instanceof TypeError)) throw e; d = await cGet('event:' + id); if (!d) throw new Error('Événement non disponible hors ligne'); }
  let dmg = false;
  const done = r => mode === 'out' ? r.out_scanned_at : r.in_scanned_at;
  main(`<h2>${mode === 'out' ? 'Départ' : 'Retour'} : ${esc(d.ev.name)}</h2>${camHtml}
    ${mode === 'in' ? '<label class="check"><input type="checkbox" id="dm" style="width:auto;margin:0"> <span>Signaler les articles endommagés (photo)</span></label>' : ''}
    <div id="pend"></div><h3 id="prog"></h3><div id="chk"></div>`);
  const draw = () => {
    const n = d.rows.filter(done).length; $('#prog').textContent = `${n} / ${d.rows.length} article(s) scanné(s)`;
    $('#chk').innerHTML = d.rows.map(r => `<div class="check${done(r) ? ' done' : ''}"><span>${done(r) ? '✔' : '○'}</span><div class="grow">${esc(r.name)}${r.kind === 'consumable' ? ' × ' + r.qty : ''}<br><small class="mute">${esc(r.code)}</small></div>
      ${mode === 'in' && r.out_scanned_at && !r.in_scanned_at ? `<button class="btn bad tiny" data-miss="${esc(r.code)}">Manquant</button>` : ''}</div>`).join('');
    document.querySelectorAll('[data-miss]').forEach(b => b.onclick = () => confirm('Signaler cet article comme manquant ?') && send({ code: b.dataset.miss, state: 'missing' }));
  };
  const send = async op => {
    op = { ...op, mode, event_id: +id, at: new Date().toISOString() };
    const r = d.rows.find(x => x.code === op.code);
    if (mode === 'out') r.out_scanned_at = op.at; else { r.in_scanned_at = op.at; r.return_state = op.state || 'ok'; }
    cSet('event:' + id, d); draw(); $('#pend').innerHTML = '';
    try {
      if (!navigator.onLine) throw new TypeError('hors ligne');
      await api(`/events/${id}/scan`, { method: 'POST', body: op });
    } catch (e) {
      if (e instanceof TypeError) { await qAdd(op); updateStatus(); toast('Enregistré hors ligne : synchronisation automatique au retour du réseau'); }
      else { toast(e.message, true); d = await api('/events/' + id); cSet('event:' + id, d); draw(); }
    }
  };
  const onCode = code => {
    const r = d.rows.find(x => x.code === code);
    if (!r) return flash('bad', 'Article non prévu : ' + code);
    if (done(r)) return flash('warn', 'Déjà scanné : ' + r.name);
    if (mode === 'in' && !r.out_scanned_at) return flash('bad', 'Aucun départ enregistré : ' + r.name);
    if (mode === 'in' && dmg) {
      flash('warn');
      $('#pend').innerHTML = `<div class="card"><b>Dommage : ${esc(r.name)}</b><label>Photo</label><input type="file" id="ph" accept="image/*" capture="environment"><label>Description</label><textarea id="nt" rows="2"></textarea>
        <button class="btn bad" id="ok">Enregistrer le dommage</button> <button class="btn ghost" id="no">Annuler</button></div>`;
      $('#no').onclick = () => $('#pend').innerHTML = '';
      $('#ok').onclick = async () => { const f = $('#ph').files[0]; send({ code, state: 'damaged', note: $('#nt').value, photo: f ? await shrink(f) : null }); };
      return;
    }
    const op = { code, state: 'ok' };
    if (mode === 'in' && r.kind === 'consumable') op.qty = +prompt(`Quantité rapportée pour « ${r.name} »`, r.qty) || 0;
    flash('ok'); send(op);
  };
  $('#dm') && ($('#dm').onchange = e => dmg = e.target.checked);
  draw(); startCam(onCode);
}
async function quickScan() {
  main(`<h2>Scanner</h2>${camHtml}<p class="mute">Visez le code d’un article pour ouvrir sa fiche.</p>`);
  startCam(async code => {
    let it = ((await cGet('items')) || []).find(i => i.code === code);
    if (!it) try { it = await api('/lookup/' + q(code)); } catch { return flash('bad', 'Code inconnu : ' + code); }
    flash('ok'); location.hash = '#/items/' + it.id;
  });
}

/* ---------- Administration & réglages ---------- */
async function audit() {
  const l = await api('/audit?limit=300');
  main(`<h2>Journal d’audit</h2>${l.map(a => `<div class="check"><div class="grow"><b>${esc(a.action)}</b> ${esc(a.entity || '')} ${a.entity_id ?? ''}<br><small class="mute">${esc(a.username || '?')} · ${fmt(a.at)} · ${esc(a.ip || '')}</small>${a.detail ? `<br><small>${esc(a.detail)}</small>` : ''}</div></div>`).join('')}`);
}
async function users() {
  const u = await api('/users');
  main(`<h2>Utilisateurs</h2>${u.map(x => `<div class="check"><div class="grow"><b>${esc(x.display_name || x.username)}</b> <small class="mute">${esc(x.username)} · ${x.source === 'ldap' ? 'LDAP' : 'local'}</small></div>
    <select data-u="${x.id}" style="width:auto;margin:0">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}"${k === x.role ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <button class="btn ghost tiny" data-a="${x.id}" data-v="${x.active ? 0 : 1}">${x.active ? 'Désactiver' : 'Activer'}</button></div>`).join('')}
    <h3>Nouveau compte local</h3><form id="f"><input name="username" placeholder="Identifiant" required><input name="display_name" placeholder="Nom affiché"><input name="password" type="password" minlength="8" placeholder="Mot de passe (8 caractères min.)" required>
    <select name="role">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><button class="btn">Créer</button><p class="err" id="fe"></p></form>`);
  document.querySelectorAll('[data-u]').forEach(s => s.onchange = () => api('/users/' + s.dataset.u, { method: 'PUT', body: { role: s.value } }).then(() => toast('Rôle mis à jour')));
  document.querySelectorAll('[data-a]').forEach(b => b.onclick = () => api('/users/' + b.dataset.a, { method: 'PUT', body: { active: b.dataset.v === '1' } }).then(users));
  $('#f').onsubmit = async e => { e.preventDefault(); try { await api('/users', { method: 'POST', body: form(e.target) }); users(); } catch (err) { $('#fe').textContent = err.message; } };
}
function settings() {
  const p = prefs(), sc = p.shortcuts || ['scanner', 'items/new', 'events/new'];
  main(`<h2>Réglages</h2><div class="card"><label>Thème</label><select id="th"><option value="light">Clair</option><option value="dark">Sombre</option></select>
    <label>Couleur d’accent</label><div class="bar">${['#B0C4DE', '#A8D5BA', '#F2C6B4', '#C9B8E6', '#F5E3A1'].map(c => `<button class="btn tiny" data-c="${c}" style="background:${c};width:44px;height:36px" aria-label="${c}"></button>`).join('')}</div>
    <label>Logo (affiché en haut et à la connexion)</label><input type="file" id="lg2" accept="image/*"><button class="btn ghost tiny" id="lgr">Rétablir le logo par défaut</button></div>
    <div class="card"><b>Raccourcis de l’accueil</b>${Object.entries(SHORT).map(([k, v]) => `<label class="check"><input type="checkbox" style="width:auto;margin:0" data-s="${k}"${sc.includes(k) ? ' checked' : ''}> ${v[1]}</label>`).join('')}</div>
    <div class="card"><b>Alertes de retard</b><p class="mute">Une notification s’affiche quand un retour est en retard et que l’application est ouverte.</p><button class="btn ghost" id="nt">Autoriser les notifications</button></div>`);
  $('#th').value = p.theme || 'light'; $('#th').onchange = e => savePrefs({ theme: e.target.value });
  document.querySelectorAll('[data-c]').forEach(b => b.onclick = () => savePrefs({ accent: b.dataset.c }));
  $('#lg2').onchange = async e => savePrefs({ logo: await shrink(e.target.files[0]) }); $('#lgr').onclick = () => savePrefs({ logo: '' });
  document.querySelectorAll('[data-s]').forEach(c => c.onchange = () => savePrefs({ shortcuts: [...document.querySelectorAll('[data-s]:checked')].map(x => x.dataset.s) }));
  $('#nt').onclick = () => Notification.requestPermission().then(r => toast(r === 'granted' ? 'Notifications activées' : 'Notifications refusées', r !== 'granted'));
}

/* ---------- Synchronisation hors ligne & alertes ---------- */
let syncing = false;
async function sync(manual) {
  if (!token || syncing || !navigator.onLine) return;
  const ops = await qAll(); if (!ops.length) return manual && toast('Rien à synchroniser');
  syncing = true;
  try {
    const r = await api('/sync', { method: 'POST', body: { ops } });
    await qDel(ops.map(o => o.qid));
    const bad = r.results.filter(x => !x.ok);
    toast(`${ops.length - bad.length} scan(s) synchronisé(s)` + (bad.length ? ` · ${bad.length} refusé(s) : ${bad[0].error}` : ''), !!bad.length);
  } catch (e) { if (!(e instanceof TypeError)) console.error(e); }
  syncing = false; updateStatus();
}
const notified = new Set();
async function poll() {
  if (!token || !navigator.onLine) return;
  try {
    for (const e of await api('/alerts')) if (!notified.has(e.id)) {
      notified.add(e.id);
      if (window.Notification && Notification.permission === 'granted') new Notification('Retour en retard', { body: `${e.name} (prévu ${fmt(e.end_at)})`, icon: '/icons/icon-192.png' });
    }
  } catch { /* hors ligne */ }
}
addEventListener('online', () => { updateStatus(); sync(); }); addEventListener('offline', updateStatus);
setInterval(() => { sync(); poll(); }, 60000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
applyPrefs();
token ? boot() : login();
