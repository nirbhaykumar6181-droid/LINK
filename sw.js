const CACHE = 'link-shell-v1.1-enhancements';
const SHELL = ['/', '/manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/s/') || url.pathname.startsWith('/p/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && (url.pathname === '/' || url.pathname === '/manifest.webmanifest')) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then(hit => hit || new Response('You are offline. Reconnect to use LINK.', { status: 503, headers: { 'Content-Type': 'text/plain' } }))));
});

self.addEventListener('push', event => {
  let data = {}; try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || 'LINK';
  const options = { body: 'New message', tag: 'link-room-' + (data.room || 'message'), renotify: false, data: { room: data.room || '' } };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close(); const room = event.notification.data && event.notification.data.room;
  const target = new URL('/', self.location.origin); if (room) target.searchParams.set('room', room);
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) if ('focus' in client) { if ('navigate' in client) client.navigate(target.href); return client.focus(); }
    return clients.openWindow(target.href);
  }));
});
