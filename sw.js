// ---------------------------------------------------------------------------
//  Service worker — makes the app open instantly and survive a dead network
//
//  Bump CACHE when shipping, so the old shell is thrown away.
// ---------------------------------------------------------------------------

const CACHE = 'splittywise-v6';

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/theme.js',
  './js/config.js',
  './js/db.js',
  './js/outbox.js',
  './js/ui.js',
  './js/auth.js',
  './js/balances.js',
  './js/shell.js',
  './js/emoji.js',
  './js/invite.js',
  './js/friends.js',
  './js/scan.js',
  './js/expense.js',
  './js/groups.js',
  './js/settle.js',
  './js/celebrate.js',
  './js/groupsettings.js',
  './js/recurring.js',
  './js/insights.js',
  './js/search.js',
  './js/realtime.js',
  './js/pwa.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // Added one at a time: addAll rejects the whole install if any single
      // file 404s, which would leave the app with no cache at all.
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () { /* skip what is missing */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys
        .filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;

  // Never touch anything but plain GETs.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never touch cross-origin traffic. Supabase calls carry auth and must
  // always be live; the CDNs manage their own HTTP caching.
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network so a deploy lands, fall back to the cached
  // shell so the app still opens with no signal.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (hit) {
          return hit || new Response(
            '<h1>Offline</h1><p>Reconnect and reopen SplittyWise.</p>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        });
      })
    );
    return;
  }

  // Static assets: serve from cache at once, refresh in the background.
  event.respondWith(
    caches.match(req).then(function (hit) {
      const live = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || live;
    })
  );
});
