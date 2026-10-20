/* Study Hard — service worker
   Caches the app shell so the app opens and works fully offline.
   Bump CACHE_VERSION whenever index.html (or any shell file) changes
   so returning users pick up the new version. */
const CACHE_VERSION = 'v1';
const SHELL_CACHE = `study-hard-shell-${CACHE_VERSION}`;
const FONT_CACHE = 'study-hard-fonts';

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((k) => k !== SHELL_CACHE && k !== FONT_CACHE)
        .map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isFontRequest(url) {
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Google Fonts: stale-while-revalidate, so once cached they also work offline.
  if (isFontRequest(url)) {
    event.respondWith(
      caches.open(FONT_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const fetchPromise = fetch(req)
            .then((res) => {
              if (res && res.status === 200) cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // App shell / same-origin: cache-first, falling back to network, falling
  // back to the cached index.html for navigations (so deep refreshes work offline).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => {
            if (req.mode === 'navigate') return caches.match('./index.html');
          });
      })
    );
  }
});
