const CACHE_NAME = "istanbul-hava-shell-v3";
const APP_SHELL = ["./", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  // Forecast and notification JSON always use the network so stale reports are not replayed.
  if (request.url.includes("/data/")) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("./"))
    );
  }
});

