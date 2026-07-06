/* PH Business Continuity Advisory — offline app shell.
   Bump CACHE when you change app files. Data (feed) is always network-first. */
var CACHE = "pbca-shell-v5";
var SHELL = [
  ".", "index.html", "styles.css", "app.js", "feed-data.js",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
  "icons/wordmark.png", "icons/brand-logo.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  // Always try the network first for the data feed so the app shows fresh reports.
  if (url.pathname.endsWith("feed.json") || url.pathname.endsWith("feed-data.js")) {
    e.respondWith(
      fetch(e.request).then(function (r) {
        var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); return r;
      }).catch(function () { return caches.match(e.request); })
    );
    return;
  }
  // App shell: cache first, fall back to network.
  e.respondWith(caches.match(e.request).then(function (r) { return r || fetch(e.request); }));
});
