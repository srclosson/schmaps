/**
 * Schmaps service worker — app-shell caching for offline launch.
 * Map tiles, geocoding, routing and traffic always go to the network.
 */

const VERSION = 'schmaps-v82';
const APP_SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/theme.js',
  'js/config.js',
  'js/errands.js',
  'js/geocode.js',
  'js/geocoders.js',
  'js/osm.js',
  'js/osrm.js',
  'js/eta.js',
  'js/categories.js',
  'js/hours.js',
  'js/driver-profile.js',
  'js/places.js',
  'js/places-store.js',
  'js/poi.js',
  'js/routing.js',
  'js/traffic.js',
  'js/obd.js',
  'js/voice.js',
  'data/ca-places.json',
  'data/ca-border.json',
  'vendor/maplibre-gl.js',
  'vendor/maplibre-gl.css',
  'manifest.webmanifest',
  'avro-arrow.png',
  'icons/icon-64.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) =>
        // Cache assets individually so one missing file can't abort install.
        // 'reload' bypasses the browser HTTP cache — otherwise a stale
        // max-age response can poison the fresh precache with an old file.
        Promise.allSettled(
          APP_SHELL.map((asset) => cache.add(new Request(asset, { cache: 'reload' })))
        )
      )
    // No skipWaiting() here — the new worker waits until the user taps
    // "Update", so a route in progress is never swapped mid-drive.
  );
});

// The page tells the waiting worker to take over once the user approves;
// it can also ask a worker which VERSION it is, so "not now" can be
// remembered per version.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') {
    (event.ports[0] ?? event.source)?.postMessage({ type: 'VERSION', version: VERSION });
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or cross-origin tiles — network only.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  // App shell: cache-first, fall back to network and cache the result.
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && event.request.method === 'GET') {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return res;
      });
    })
  );
});
