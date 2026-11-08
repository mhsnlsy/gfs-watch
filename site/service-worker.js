const SHELL_CACHE = "istanbul-hava-shell-v18";
const DATA_CACHE = "istanbul-hava-data-v4";
const APP_SHELL = ["./", "./manifest.webmanifest", "./favicon.svg"];
const MAX_DATA_ENTRIES = 180;

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith("istanbul-hava-shell-") && key !== SHELL_CACHE)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function canonicalRequest(requestUrl) {
  const url = new URL(requestUrl);
  url.search = "";
  url.hash = "";
  return new Request(url.href, { method: "GET", credentials: "same-origin" });
}

async function saveDataResponse(cache, key, response) {
  if (!response || !response.ok || response.type === "opaque") return;
  await cache.put(key, response.clone());
  const keys = await cache.keys();
  if (keys.length > MAX_DATA_ENTRIES) {
    for (const oldKey of keys.slice(0, keys.length - MAX_DATA_ENTRIES)) {
      await cache.delete(oldKey);
    }
  }
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: "no-store" });
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put("./", response.clone());
        }
        return response;
      } catch (_) {
        return new Response(
          "<!doctype html><html lang='tr'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><meta http-equiv='refresh' content='300'><meta name='theme-color' content='#081827'><title>Bağlantı kurulamadı · İstanbul Havası</title></head><body style='font:16px/1.6 system-ui,sans-serif;background:#071521;color:#edf5f8;padding:2rem;min-height:70vh;display:grid;place-items:center'><main style='max-width:440px;background:#102535;border:1px solid rgba(241,201,139,.35);border-radius:20px;padding:24px'><div style='font-size:12px;color:#f1c98b;font-weight:700;letter-spacing:.12em'>YENİLEME TAMAMLANAMADI</div><h1 style='font-size:25px;margin:12px 0'>Bağlantı kurulamadı</h1><p style='color:#c2d2dc'>Sayfa güncellenemedi. İnternet bağlantını kontrol et. Önceden kaydedilmiş bazı veriler cihazda bulunabilir.</p><button onclick='location.reload()' style='border:0;border-radius:12px;padding:12px 18px;background:#7dd3d7;color:#08202b;font-weight:700;font-size:14px'>Tekrar dene</button><p style='font-size:12px;color:#91a8b6;margin-top:16px'>Bağlantı geldiğinde otomatik olarak 5 dakikada bir yeniden denenecek.</p></main></body></html>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
    })());
    return;
  }

  // Forecasts, station observations, histories, report archives and chart images:
  // network first, with the last successful response available offline.
  if (url.pathname.includes("/data/")) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      const key = canonicalRequest(request.url);
      try {
        const response = await fetch(request, { cache: "no-store" });
        if (response.ok) await saveDataResponse(cache, key, response);
        return response;
      } catch (_) {
        const cached = await cache.match(key);
        if (cached) {
          const headers = new Headers(cached.headers);
          headers.set("X-Offline-Cache", "1");
          return new Response(await cached.arrayBuffer(), {
            status: cached.status,
            statusText: cached.statusText,
            headers
          });
        }
        return new Response("Çevrimdışı önbellekte bu veri bulunmuyor.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    })());
    return;
  }

  // Keep the app shell and its local icons available for repeat launches.
  if (url.pathname.endsWith(".webmanifest") || url.pathname.endsWith(".svg")) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(canonicalRequest(request.url));
      const network = fetch(request).then(response => {
        if (response.ok) cache.put(canonicalRequest(request.url), response.clone());
        return response;
      }).catch(() => null);
      return (await network) || cached || Response.error();
    })());
  }
});

self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (_) { payload = { body: "Yeni İstanbul GFS hava raporu yayımlandı." }; }
  event.waitUntil(self.registration.showNotification(payload.title || "İstanbul Havası", {
    body: payload.body || "Yeni GFS hava raporu yayımlandı.",
    tag: payload.tag || "istanbul-gfs-report",
    data: { url: payload.url || "./#bildirimler" }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || "./#bildirimler", self.location.href).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(windowClients => {
    for (const client of windowClients) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        client.navigate(destination);
        return client.focus();
      }
    }
    return clients.openWindow(destination);
  }));
});
