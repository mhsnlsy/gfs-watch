const BACKENDS = {
  istanbul: "https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev",
  koy: "https://gfs-watch-koy-gfs.muhsin-ulusoy.workers.dev",
  stations: "https://gfs-watch-stations.muhsin-ulusoy.workers.dev",
};

function responseJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function proxy(request, upstreamUrl) {
  const upstream = new Request(upstreamUrl, request);
  const response = await fetch(upstream);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/__health") {
      return responseJson({
        ok: true,
        service: "gfs-watch-web",
        delivery: "Cloudflare Workers Static Assets",
        api_gateway: true,
        backends: BACKENDS,
        checked_at_utc: new Date().toISOString(),
      });
    }

    if (path === "/gfs/notification-latest") {
      const assetUrl = new URL("/data/notifications/latest.json", url);
      const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
      if (!asset.ok) return responseJson({ ok: false, error: "Notification archive not published" }, 404);
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "no-store, max-age=0");
      return new Response(asset.body, { status: asset.status, headers });
    }

    if (path.startsWith("/gfs/")) {
      const target = new URL(path + url.search, BACKENDS.istanbul);
      return proxy(request, target);
    }

    if (path.startsWith("/api/koy-gfs/")) {
      const suffix = path.slice("/api/koy-gfs".length);
      const target = new URL("/api" + suffix + url.search, BACKENDS.koy);
      return proxy(request, target);
    }

    if (path === "/api/koy-gfs") {
      return proxy(request, new URL("/api/health" + url.search, BACKENDS.koy));
    }

    if (path.startsWith("/api/stations/")) {
      const suffix = path.slice("/api/stations".length);
      const target = new URL("/api" + suffix + url.search, BACKENDS.stations);
      return proxy(request, target);
    }

    if (path === "/api/stations") {
      return proxy(request, new URL("/api/health" + url.search, BACKENDS.stations));
    }

    if (path.startsWith("/api/")) {
      return responseJson({ ok: false, error: "Unknown API route" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
