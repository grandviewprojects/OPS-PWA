// public/service-worker.js
const CACHE_NAME = 'onsite-ops-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/api.js',
  '/js/app.js',
  '/js/calendar.js',
  '/js/workorders.js',
  '/js/team.js',
  '/js/reports.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or uploaded files — always go to network so data stays fresh.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    event.respondWith(fetch(event.request).catch(() => new Response(JSON.stringify({ error: 'Offline — please reconnect.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // App shell: cache-first, fall back to network, then update cache.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && event.request.method === 'GET') {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        }
        return res;
      }).catch(() => caches.match('/index.html'));
    })
  );
});

// ---- Push notifications: show a real phone/desktop notification ----
self.addEventListener('push', (event) => {
  let data = { title: 'Onsite Ops', body: 'You have a new update.', link: '#/dashboard' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { link: data.link || '#/dashboard' }
    })
  );
});

// Tapping the notification opens the app (or focuses it if already open) at the right page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '#/dashboard';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ('focus' in client) {
          client.navigate('/' + link);
          return client.focus();
        }
      }
      return self.clients.openWindow('/' + link);
    })
  );
});
