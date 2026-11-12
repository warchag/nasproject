/* Personal NAS OS — Progressive Web App Service Worker */
const CACHE_NAME = 'personal-nas-shell-v40';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
            return null;
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache dynamic API endpoints, WebDAV mounts, or public share/drop streams
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/webdav') ||
    url.pathname.startsWith('/s/') ||
    url.pathname.startsWith('/d/')
  ) {
    return;
  }

  // Network-First strategy for static shell assets so UI updates are always fresh,
  // with seamless offline cache fallback when the server is unreachable.
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const cloned = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, cloned).catch(() => {});
          });
        }
        return networkResponse;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('Offline — ไม่สามารถเชื่อมต่อ Personal NAS Server ได้ในขณะนี้', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        })
      )
  );
});
