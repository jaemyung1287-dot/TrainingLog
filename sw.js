// TrainLog Service Worker — network-first, auto-update
const CACHE = 'trainlog-v1';
const CACHE_URLS = ['./TrainLog.html', './'];

// Install: cache app shell immediately
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CACHE_URLS).catch(() => {}))
  );
  // Skip waiting so new SW activates immediately
  self.skipWaiting();
});

// Activate: delete old caches, take control of all clients
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for HTML navigation, cache-first for other assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Network-first for the main HTML document
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for everything else
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
