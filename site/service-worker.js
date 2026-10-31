const CACHE_NAME = "istanbul-hava-shell-v1";
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

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { body: event.data ? event.data.text() : "Yeni İstanbul hava raporu yayımlandı." };
  }
  const title = payload.title || "İstanbul'un Havası";
  const options = {
    body: payload.body || "Yeni hava raporu yayımlandı.",
    icon: "./icon.svg",
    badge: "./icon.svg",
    tag: payload.tag || "istanbul-gfs-report",
    data: { url: payload.url || "./#bildirimler" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const destination = new URL(
    event.notification.data && event.notification.data.url
      ? event.notification.data.url
      : "./#bildirimler",
    self.location.href
  ).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          client.navigate(destination);
          return client.focus();
        }
      }
      return clients.openWindow(destination);
    })
  );
});
