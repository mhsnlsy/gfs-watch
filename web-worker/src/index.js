const SERVICES = {
  istanbul: "gfs-watch-istanbul-gfs",
  koy: "gfs-watch-koy-gfs",
  stations: "gfs-watch-stations",
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

function internalRequest(request, path) {
  const incoming = new URL(request.url);
  const target = new URL(path, "https://gfs-watch-internal.invalid");
  target.search = incoming.search;
  return new Request(target, request);
}

async function fetchArchiveObject(request, env, assetPath) {
  if (!env.LIVE_ARCHIVE) return null;
  const key = String(assetPath || "").replace(/^\/+/, "");
  if (!key || key.split("/").some(segment => segment === "." || segment === "..")) return null;

  let object;
  try {
    object = await env.LIVE_ARCHIVE.get(key);
  } catch (error) {
    console.error("R2 archive read failed:", String(error?.message || error));
    return null;
  }
  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-GFS-Archive-Source", "R2");
  headers.set(
    "Cache-Control",
    key.endsWith("/latest.json") || key.endsWith("latest.json")
      ? "no-store, max-age=0"
      : "public, max-age=3600, s-maxage=86400"
  );

  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers,
  });
}

function isArchivePath(path) {
  return path.startsWith("/data/notifications/") ||
    path.startsWith("/data/ecmwf/") ||
    path === "/data/istanbul-gfs-latest.json" ||
    path === "/data/istanbul-gfs-comparison.json" ||
    path.startsWith("/koy-data/gfs/");
}

async function callService(binding, request, path) {
  if (!binding || typeof binding.fetch !== "function") {
    return responseJson({ ok: false, error: "Cloudflare service binding is not configured" }, 503);
  }
  const response = await binding.fetch(internalRequest(request, path));
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-GFS-Watch-Gateway", "service-binding");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function fetchD1PublicationAsset(request, env, key) {
  const normalized = String(key || "").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some(part => part === "." || part === "..")) return null;
  const response = await callService(
    env.ISTANBUL_GFS,
    request,
    "/gfs/publication-asset/" + normalized
  );
  return response.ok ? response : null;
}

function stripStrayLiteralNewlineText(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) return response;

  return new HTMLRewriter()
    .on("*", {
      text(text) {
        if (text.text.trim() === "\\n") text.remove();
      },
    })
    .transform(response);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (path === "/favicon.svg" || path === "/favicon.ico") {
      const asset = await env.ASSETS.fetch(new Request(new URL("/favicon-48x48.png", url), request));
      if (!asset.ok) return asset;
      const headers = new Headers(asset.headers);
      headers.set("Content-Type", "image/png");
      headers.set("Cache-Control", "public, max-age=300, must-revalidate");
      return new Response(request.method === "HEAD" ? null : asset.body, { status: asset.status, headers });
    }

    if (path === "/__health") {
      const bindings = {
        istanbul: Boolean(env.ISTANBUL_GFS?.fetch),
        koy: Boolean(env.KOY_GFS?.fetch),
        stations: Boolean(env.STATIONS?.fetch),
      };
      return responseJson({
        ok: Object.values(bindings).every(Boolean),
        service: "gfs-watch-web",
        delivery: "Cloudflare Workers Static Assets",
        api_gateway: "Cloudflare Service Bindings",
        services: SERVICES,
        bindings,
        archive_storage: env.LIVE_ARCHIVE ? "R2" : "Static Assets fallback",
        checked_at_utc: new Date().toISOString(),
      }, Object.values(bindings).every(Boolean) ? 200 : 503);
    }

    if (path === "/gfs/notification-latest") {
      // The latest manifest is mutable: D1 is authoritative so a delayed R2
      // archive sync can never overwrite a newer native Worker publication.
      const published = await fetchD1PublicationAsset(request, env, "notifications/latest.json");
      if (published) return published;
      const archived = await fetchArchiveObject(request, env, "/data/notifications/latest.json");
      if (archived) return archived;
      const assetUrl = new URL("/data/notifications/latest.json", url);
      const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
      if (!asset.ok) {
        return responseJson({ ok: false, error: "Notification archive not published" }, 404);
      }
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "no-store, max-age=0");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(asset.body, { status: asset.status, headers });
    }

    // Immutable archives are served from R2 first. Mutable notification
    // manifests keep D1 first; all other stores are fallback layers.
    if (isArchivePath(path)) {
      const isMutableNotificationManifest = path === "/data/notifications/latest.json";
      if (isMutableNotificationManifest) {
        const published = await fetchD1PublicationAsset(request, env, "notifications/latest.json");
        if (published) return published;
      }

      const archived = await fetchArchiveObject(request, env, path);
      if (archived) return archived;

      if (path.startsWith("/data/notifications/") && !isMutableNotificationManifest) {
        const published = await fetchD1PublicationAsset(request, env, path.slice("/data/".length));
        if (published) return published;
      }
      if (path.startsWith("/data/ecmwf/")) {
        const published = await fetchD1PublicationAsset(request, env, path.slice(1));
        if (published) return published;
      }
      if (path.startsWith("/koy-data/gfs/")) {
        const assetKey = path.slice("/koy-data/gfs/".length);
        const published = await callService(
          env.KOY_GFS,
          request,
          "/api/publication-asset/" + assetKey
        );
        if (published.ok) return published;
      }

      const isStaticAssetFallback = await env.ASSETS.fetch(new Request(new URL(path, url), request));
      if (isStaticAssetFallback.ok) {
        const headers = new Headers(isStaticAssetFallback.headers);
        headers.set("X-GFS-Archive-Source", "Static-Assets-Fallback");
        return new Response(isStaticAssetFallback.body, {
          status: isStaticAssetFallback.status,
          statusText: isStaticAssetFallback.statusText,
          headers,
        });
      }
      return isStaticAssetFallback;
    }

    if (path === "/gfs/latest" || path === "/api/latest" || path === "/api/health" ||
        path === "/gfs/comparison" || path === "/api/comparison") {
      const targetPath = path.startsWith("/gfs/") ? path : path;
      return callService(env.ISTANBUL_GFS, request, targetPath);
    }

    if (path.startsWith("/api/koy-gfs/")) {
      const suffix = path.slice("/api/koy-gfs".length);
      return callService(env.KOY_GFS, request, "/api" + suffix);
    }

    if (path === "/api/koy-gfs") {
      return callService(env.KOY_GFS, request, "/api/health");
    }

    if (path === "/api/stations/health") {
      return callService(env.STATIONS, request, "/api/health");
    }

    if (path === "/api/stations" || path.startsWith("/api/stations/")) {
      return callService(env.STATIONS, request, path);
    }

    if (path.startsWith("/api/history/")) {
      return callService(env.STATIONS, request, path);
    }

    if (path.startsWith("/api/")) {
      return responseJson({ ok: false, error: "Unknown API route", path }, 404);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    return stripStrayLiteralNewlineText(assetResponse);
  },
};
