/* ActionLog service worker — offline app shell + cached ML libraries */
const VERSION = 'actionlog-v6';

const SHELL = [
  './',
  './index.html',
  './style.css',
  './js/actions.js',
  './js/pose-engine.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

/* Big third-party bundles — cache-first so the app starts offline. */
const LIB_PREFIXES = [
  'https://cdn.jsdelivr.net/npm/@tensorflow/',
  'https://storage.googleapis.com/tfjs-models/',
  'https://tfhub.dev/',
  'https://storage.googleapis.com/mediapipe-models/'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) =>
        /* no-cache: always revalidate, otherwise a stale HTTP cache entry
           would be copied into the fresh versioned cache */
        Promise.allSettled(
          SHELL.map((u) =>
            fetch(u, { cache: 'no-cache' })
              .then((res) => (res && res.ok ? cache.put(u, res) : null))
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

function isLibrary(url) {
  return LIB_PREFIXES.some((p) => url.startsWith(p));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (req.headers.has('range')) return;

  /* Navigations: network first, fall back to the cached shell. */
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  /* Same-origin assets and ML bundles: cache first. */
  const cacheable = url.origin === self.location.origin || isLibrary(req.url);
  if (!cacheable) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: false }).then((hit) => {
      if (hit) return hit;
      return fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
    })
  );
});
