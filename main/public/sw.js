// Service Worker : coquille de l'app disponible hors ligne (réseau d'abord, cache en secours).
// Les données (articles, événements, scans en attente) sont gérées par IndexedDB côté app.
const V = 'simplimo-v1';
const SHELL = ['/', '/style.css', '/app.js', '/idb.js', '/scanner.js', '/vendor/zxing.js', '/manifest.json', '/icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/') || u.pathname.startsWith('/uploads/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'Simplimo +', body: 'Nouvelle notification' };
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icons/icon-192.png', data: { url: data.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const client = list[0];
    return client ? client.navigate(e.notification.data.url).then(() => client.focus()) : clients.openWindow(e.notification.data.url);
  }));
});
