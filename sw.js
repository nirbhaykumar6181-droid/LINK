const CACHE = 'link-shell-v1.2';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname.startsWith('/s/') || url.pathname.startsWith('/p/')) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok && ['/', '/manifest.webmanifest', '/icon.svg'].includes(url.pathname)) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy));
    }
    return response;
  }).catch(() => caches.match(request).then(hit => hit || new Response('LINK is offline. Reconnect to send and receive messages.', {
    status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  }))));
});