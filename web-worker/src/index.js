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

async function callKoyService(binding, request, path) {
  // The public Köy API must remain same-origin. Prefer the Cloudflare Service
  // Binding, but keep a direct Worker fallback so a transient binding 404/5xx
  // cannot blank the entire Köy page.
  if (binding && typeof binding.fetch === "function") {
    try {
      const response = await binding.fetch(internalRequest(request, path));
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 404)) {
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
      console.warn("Köy Service Binding fallback:", response.status, path);
    } catch (error) {
      console.warn("Köy Service Binding error:", String(error?.message || error), path);
    }
  }

  const incoming = new URL(request.url);
  const direct = new URL("https://gfs-watch-koy-gfs.muhsin-ulusoy.workers.dev" + path);
  direct.search = incoming.search;
  const response = await fetch(new Request(direct, request), {
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-GFS-Watch-Gateway", "direct-koy-worker-fallback");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function callService(binding, request, path, fallbackBase = null) {
  // The custom-domain gateway must not go dark just because a Service
  // Binding is stale, temporarily unavailable, or returns a 5xx. The
  // dedicated Workers are also public canonical endpoints, so use them as
  // a last-resort data-path fallback.
  let response = null;
  let bindingError = null;

  if (binding && typeof binding.fetch === "function") {
    try {
      response = await binding.fetch(internalRequest(request, path));
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 404)) {
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
      bindingError = "Service Binding HTTP " + response.status;
    } catch (error) {
      bindingError = String(error?.message || error);
    }
  } else {
    bindingError = "Cloudflare service binding is not configured";
  }

  if (fallbackBase) {
    try {
      const incoming = new URL(request.url);
      const direct = new URL(fallbackBase.replace(/\/$/, "") + path);
      direct.search = incoming.search;
      const fallbackResponse = await fetch(new Request(direct, request), {
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      const headers = new Headers(fallbackResponse.headers);
      headers.set("Cache-Control", "no-store, max-age=0");
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("X-GFS-Watch-Gateway", "direct-worker-fallback");
      if (bindingError) headers.set("X-GFS-Watch-Binding-Error", bindingError.slice(0, 180));
      return new Response(fallbackResponse.body, {
        status: fallbackResponse.status,
        statusText: fallbackResponse.statusText,
        headers,
      });
    } catch (error) {
      return responseJson({
        ok: false,
        error: "Service Binding and direct Worker fallback failed",
        binding_error: bindingError,
        fallback_error: String(error?.message || error),
      }, 503);
    }
  }

  return responseJson({ ok: false, error: bindingError || "Service unavailable" }, 503);
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

function stripStrayLiteralNewlineText(response, requestPath = "") {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) return response;

  let rewriter = new HTMLRewriter().on("*", {
    text(text) {
      if (text.text.trim() === "\\n") text.remove();
    },
  });

  if (!requestPath.startsWith("/admin")) {
    rewriter = rewriter.on("body", {
      element(element) {
        element.append('<script src="/analytics.js?v=1" defer></script>', { html: true });
      }
    });
  }

  return rewriter.transform(response);
}

function basicAuthOk(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!env.ADMIN_PASSWORD || !header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    return separator > 0 &&
      decoded.slice(0, separator) === "admin" &&
      decoded.slice(separator + 1) === env.ADMIN_PASSWORD;
  } catch (_) {
    return false;
  }
}

function adminUnauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Istanbul Havası Admin", charset="UTF-8"',
      "Cache-Control": "no-store"
    }
  });
}

function parseAnalyticsUserAgent(ua) {
  const s = String(ua || "");
  const device = /iPad|Tablet/i.test(s) ? "Tablet" : (/Mobi|Android/i.test(s) ? "Mobil" : "Masaüstü");
  const os = /iPhone|iPad|iPod/i.test(s) ? "iOS" :
    (/Android/i.test(s) ? "Android" :
    (/Windows/i.test(s) ? "Windows" :
    (/Mac OS X/i.test(s) ? "macOS" :
    (/Linux/i.test(s) ? "Linux" : "Diğer"))));
  const browser = /SamsungBrowser/i.test(s) ? "Samsung Internet" :
    (/Edg\//i.test(s) ? "Edge" :
    (/OPR\//i.test(s) ? "Opera" :
    (/Chrome\//i.test(s) ? "Chrome" :
    (/Safari\//i.test(s) && !/Chrome\//i.test(s) ? "Safari" :
    (/Firefox\//i.test(s) ? "Firefox" : "Diğer")))));
  return { device, os, browser };
}

function analyticsMeta(request) {
  const parsed = parseAnalyticsUserAgent(request.headers.get("User-Agent") || "");
  const cf = request.cf || {};
  return {
    city: cf.city || null,
    country: cf.country || request.headers.get("CF-IPCountry") || null,
    device: parsed.device,
    os: parsed.os,
    browser: parsed.browser,
    referrer: (request.headers.get("Referer") || "").slice(0, 500) || null
  };
}

function analyticsDayStartUtc(daysAgo) {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const [y, m, d] = local.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d) - 3 * 60 * 60 * 1000);
  start.setUTCDate(start.getUTCDate() - Number(daysAgo || 0));
  return start.toISOString();
}

function classifySource(referrer) {
  const r = String(referrer || "").toLowerCase();
  if (!r) return "Direkt";
  if (/google\.|bing\.|yahoo\.|duckduckgo\./.test(r)) return "Arama";
  if (/instagram\.com/.test(r)) return "Instagram";
  if (/t\.me|telegram\./.test(r)) return "Telegram";
  if (/x\.com|twitter\.com/.test(r)) return "X";
  if (/facebook\.com/.test(r)) return "Facebook";
  if (/youtube\.com|youtu\.be/.test(r)) return "YouTube";
  return "Diğer";
}

function analyticsSessionId(request, body) {
  const fromBody = String(body?.session_id || "").trim();
  if (fromBody) return fromBody.slice(0, 120);
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)ih_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]).slice(0, 120) : crypto.randomUUID();
}

async function recordAnalyticsEvent(request, env) {
  if (!env.ANALYTICS_DB) return null;
  const body = await request.json().catch(() => ({}));
  const type = body.type === "heartbeat" ? "heartbeat" : "pageview";
  const sessionId = analyticsSessionId(request, body);
  const path = String(body.path || "/").slice(0, 500);
  const now = new Date().toISOString();
  const meta = analyticsMeta(request);

  await env.ANALYTICS_DB.prepare(
    `INSERT INTO analytics_sessions
      (session_id, first_seen_utc, last_seen_utc, last_path, city, country, device, os, browser, referrer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
      last_seen_utc=excluded.last_seen_utc,
      last_path=excluded.last_path,
      city=excluded.city,
      country=excluded.country,
      device=excluded.device,
      os=excluded.os,
      browser=excluded.browser,
      referrer=COALESCE(analytics_sessions.referrer, excluded.referrer)`
  ).bind(sessionId, now, now, path, meta.city, meta.country, meta.device, meta.os, meta.browser, meta.referrer).run();

  if (type === "pageview") {
    await env.ANALYTICS_DB.prepare(
      `INSERT INTO analytics_events
       (session_id, ts_utc, event_type, path, city, country, device, os, browser, referrer)
       VALUES (?, ?, 'pageview', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(sessionId, now, path, meta.city, meta.country, meta.device, meta.os, meta.browser, meta.referrer).run();
  }
  return sessionId;
}

async function analyticsStats(env) {
  const db = env.ANALYTICS_DB;
  if (!db) return { ok: false, error: "analytics_db_missing" };
  const todayStart = analyticsDayStartUtc(0);
  const weekStart = analyticsDayStartUtc(6);
  const monthStart = analyticsDayStartUtc(29);
  const activeCutoff = new Date(Date.now() - 90000).toISOString();

  const q = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results || [];
  const one = async (sql, ...args) => (await db.prepare(sql).bind(...args).first()) || {};

  const live = await one(
    "SELECT COUNT(*) AS n FROM analytics_sessions WHERE last_seen_utc >= ?",
    activeCutoff
  );
  const livePages = await q(
    "SELECT last_path AS path, COUNT(*) AS count FROM analytics_sessions WHERE last_seen_utc >= ? GROUP BY last_path ORDER BY count DESC LIMIT 10",
    activeCutoff
  );

  const uniqueToday = Number((await one(
    "SELECT COUNT(DISTINCT session_id) AS n FROM analytics_events WHERE ts_utc >= ?",
    todayStart
  )).n || 0);
  const pageviewsToday = Number((await one(
    "SELECT COUNT(*) AS n FROM analytics_events WHERE ts_utc >= ?",
    todayStart
  )).n || 0);
  const newToday = Number((await one(
    "SELECT COUNT(*) AS n FROM analytics_events e JOIN analytics_sessions s ON s.session_id=e.session_id WHERE e.ts_utc >= ? AND s.first_seen_utc >= ?",
    todayStart, todayStart
  )).n || 0);
  const returningToday = Math.max(0, uniqueToday - newToday);

  const group = async (field) => q(
    `SELECT COALESCE(${field}, 'Bilinmiyor') AS label, COUNT(*) AS count
     FROM analytics_events WHERE ts_utc >= ?
     GROUP BY ${field} ORDER BY count DESC LIMIT 10`,
    todayStart
  );
  const pages = await q(
    "SELECT path AS label, COUNT(*) AS count FROM analytics_events WHERE ts_utc >= ? GROUP BY path ORDER BY count DESC LIMIT 10",
    todayStart
  );
  const sourceRows = await q(
    "SELECT referrer, COUNT(*) AS count FROM analytics_events WHERE ts_utc >= ? GROUP BY referrer ORDER BY count DESC LIMIT 30",
    todayStart
  );
  const sourceMap = {};
  sourceRows.forEach(row => {
    const label = classifySource(row.referrer);
    sourceMap[label] = (sourceMap[label] || 0) + Number(row.count || 0);
  });

  const recent = await q(
    "SELECT ts_utc, city, device, browser, path FROM analytics_events WHERE event_type='pageview' ORDER BY id DESC LIMIT 12"
  );
  const dayRows = await q(
    "SELECT substr(ts_utc,1,10) AS day, COUNT(DISTINCT session_id) AS visitors, COUNT(*) AS pageviews FROM analytics_events WHERE ts_utc >= ? GROUP BY day ORDER BY day DESC",
    weekStart
  );
  const monthRows = await q(
    "SELECT substr(ts_utc,1,10) AS day, COUNT(DISTINCT session_id) AS visitors, COUNT(*) AS pageviews FROM analytics_events WHERE ts_utc >= ? GROUP BY day ORDER BY day DESC",
    monthStart
  );

  const makeGroups = async (field) => (await group(field)).map(r => [r.label, Number(r.count || 0), pageviewsToday]);

  return {
    ok: true,
    live: {
      active_visitors: Number(live.n || 0),
      pages: livePages.map(r => ({ path: r.path, count: Number(r.count || 0) }))
    },
    today: {
      unique_visitors: uniqueToday,
      pageviews: pageviewsToday,
      new_visitors: newToday,
      returning_visitors: returningToday,
      devices: await makeGroups("device"),
      os: await makeGroups("os"),
      browsers: await makeGroups("browser"),
      cities: await makeGroups("city"),
      sources: Object.entries(sourceMap).sort((a,b) => b[1] - a[1]).map(r => [r[0], r[1], pageviewsToday]),
      pages: pages.map(r => [r.label, Number(r.count || 0), pageviewsToday]),
      recent: recent.map(r => ({
        time: new Date(r.ts_utc).toLocaleTimeString("tr-TR", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit" }),
        city: r.city,
        device: r.device,
        browser: r.browser,
        path: r.path
      }))
    },
    days: dayRows.map(r => ({ day: r.day, visitors: Number(r.visitors || 0), pageviews: Number(r.pageviews || 0) })),
    month: monthRows.map(r => ({ day: r.day, visitors: Number(r.visitors || 0), pageviews: Number(r.pageviews || 0 }))
  };
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

    if (path.startsWith("/admin")) {
      if (!basicAuthOk(request, env)) return adminUnauthorized();
      const adminAsset = path === "/admin" || path === "/admin/" ? "/admin/index.html" : path;
      const response = await env.ASSETS.fetch(new Request(new URL(adminAsset, url), request));
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store, max-age=0");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    if (path === "/api/analytics/event" && request.method === "POST") {
      const sessionId = await recordAnalyticsEvent(request, env);
      const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      if (!request.headers.get("Cookie")?.match(/(?:^|;\s*)ih_session=/) && sessionId) {
        headers.append("Set-Cookie", "ih_session=" + encodeURIComponent(sessionId) + "; Max-Age=31536000; Path=/; SameSite=Lax; Secure");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    if (path === "/api/admin/analytics") {
      if (!basicAuthOk(request, env)) return adminUnauthorized();
      return responseJson(await analyticsStats(env));
    }

    if (path === "/favicon.svg" || path === "/favicon.ico") {
      const asset = await env.ASSETS.fetch(new Request(new URL(path, url), request));
      if (!asset.ok) return asset;
      const headers = new Headers(asset.headers);
      headers.set("Content-Type", path === "/favicon.svg" ? "image/svg+xml; charset=utf-8" : "image/x-icon");
      headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      return new Response(request.method === "HEAD" ? null : asset.body, { status: asset.status, headers });
    }

    if (path === "/__health") {
      const bindings = {
        istanbul: Boolean(env.ISTANBUL_GFS?.fetch),
        koy: Boolean(env.KOY_GFS?.fetch),
        stations: Boolean(env.STATIONS?.fetch),
      };

      async function probe(binding, targetPath) {
        const started = Date.now();
        if (!binding || typeof binding.fetch !== "function") {
          return { ok: false, status: 503, latency_ms: 0, error: "binding_missing" };
        }
        try {
          const response = await binding.fetch(internalRequest(request, targetPath));
          const body = await response.clone().json().catch(() => null);
          return {
            ok: response.ok,
            status: response.status,
            latency_ms: Date.now() - started,
            payload_ok: body?.ok === true,
            error: body?.error || null,
            latest_run_id_utc: body?.latest_run_id_utc || body?.station?.last_success_utc || null,
          };
        } catch (error) {
          return {
            ok: false,
            status: 503,
            latency_ms: Date.now() - started,
            error: String(error?.message || error),
          };
        }
      }

      async function probeWithFallback(binding, targetPath, fallbackBase) {
        const primary = await probe(binding, targetPath);
        if (primary.ok) return primary;
        const started = Date.now();
        try {
          const incoming = new URL(request.url);
          const direct = new URL(fallbackBase.replace(/\\\/$/, "") + targetPath);
          direct.search = incoming.search;
          const response = await fetch(new Request(direct, request), {
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          const body = await response.clone().json().catch(() => null);
          return {
            ok: response.ok,
            status: response.status,
            latency_ms: Date.now() - started,
            payload_ok: body?.ok === true,
            error: body?.error || null,
            latest_run_id_utc: body?.latest_run_id_utc || body?.station?.last_success_utc || null,
            source: "direct-worker-fallback",
          };
        } catch (error) {
          return {
            ok: false,
            status: 503,
            latency_ms: Date.now() - started,
            payload_ok: false,
            error: String(error?.message || error),
            source: "direct-worker-fallback",
          };
        }
      }

      const [istanbul, stations] = await Promise.all([
        probeWithFallback(env.ISTANBUL_GFS, "/api/health", "https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev"),
        probeWithFallback(env.STATIONS, "/api/health", "https://gfs-watch-stations.muhsin-ulusoy.workers.dev"),
      ]);
      const ok = istanbul.ok && stations.ok;

      return responseJson({
        ok,
        service: "gfs-watch-web",
        delivery: "Cloudflare Workers Static Assets",
        api_gateway: "Cloudflare Service Bindings",
        services: SERVICES,
        bindings,
        probes: { istanbul_gfs: istanbul, stations },
        archive_storage: env.LIVE_ARCHIVE ? "R2" : "Static Assets fallback",
        checked_at_utc: new Date().toISOString(),
      }, ok ? 200 : 503);
    }

    if (path === "/gfs/notification-latest") {
      // Ask the Istanbul service for its native D1 publication manifest first.
      // This also rebuilds the manifest from gfs_report_publications when the
      // mutable notifications/latest.json publication asset is missing.
      const nativeManifest = await callService(
        env.ISTANBUL_GFS,
        request,
        "/gfs/notification-latest",
        "https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev"
      );
      if (nativeManifest.ok) return nativeManifest;

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
      const isLiveEcmwfLatest = path === "/data/ecmwf/latest.json";

      if (isMutableNotificationManifest) {
        const published = await fetchD1PublicationAsset(request, env, "notifications/latest.json");
        if (published) return published;
      }

      // ECMWF latest is a live model payload, not a static archive. The
      // Istanbul GFS service is authoritative because it refreshes directly
      // from the canonical MeteoPT ECMWF source and rejects partial cycles.
      // R2 remains the fallback for outage resilience.
      if (isLiveEcmwfLatest) {
        const published = await callService(
          env.ISTANBUL_GFS,
          request,
          "/ecmwf/latest",
          "https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev"
        );
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

    // Dedicated ECMWF page. GFS routing and GFS behavior remain unchanged.
    // ECMWF live-data verification: service binding now refreshes stale MeteoPT point data.
    // Keep this route explicit so /ecmwf is served as a first-class page on the custom domain.
    if (path === "/ecmwf" || path === "/ecmwf/") {
      const assetUrl = new URL("/ecmwf/index.html", url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // Direct, canonical D1 publication-asset routes used by the live homepage charts.
    // These must be Worker-first on the custom domain; otherwise Static Assets returns 404.
    if (path.startsWith("/gfs/publication-asset/")) {
      return callService(
        env.ISTANBUL_GFS,
        request,
        path,
        "https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev"
      );
    }

    if (path.startsWith("/api/publication-asset/")) {
      return callKoyService(env.KOY_GFS, request, path);
    }

    if (path === "/gfs/latest" || path === "/api/latest" ||
        path === "/gfs/f72" || path === "/api/f72" ||
        path === "/ecmwf/latest" || path === "/api/ecmwf/latest" ||
        path === "/api/health" || path === "/gfs/comparison" || path === "/api/comparison") {
      const targetPath = path.startsWith("/gfs/") ? path : path;
      return callService(
        env.ISTANBUL_GFS,
        request,
        targetPath,
        "https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev"
      );
    }

    if (path.startsWith("/api/koy-gfs/")) {
      const suffix = path.slice("/api/koy-gfs".length);
      return callKoyService(env.KOY_GFS, request, "/api" + suffix);
    }

    if (path === "/api/koy-gfs") {
      return callKoyService(env.KOY_GFS, request, "/api/health");
    }

    if (path === "/api/stations/health") {
      return callService(
        env.STATIONS,
        request,
        "/api/health",
        "https://gfs-watch-stations.muhsin-ulusoy.workers.dev"
      );
    }

    if (path === "/api/stations" || path.startsWith("/api/stations/")) {
      return callService(
        env.STATIONS,
        request,
        path,
        "https://gfs-watch-stations.muhsin-ulusoy.workers.dev"
      );
    }

    if (path.startsWith("/api/history/")) {
      return callService(
        env.STATIONS,
        request,
        path,
        "https://gfs-watch-stations.muhsin-ulusoy.workers.dev"
      );
    }

    if (path.startsWith("/api/")) {
      return responseJson({ ok: false, error: "Unknown API route", path }, 404);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get("content-type") || "";
    if (contentType.toLowerCase().includes("text/html")) {
      const headers = new Headers(assetResponse.headers);
      headers.set("Cache-Control", "no-store, max-age=0");
      headers.set("CDN-Cache-Control", "no-store");
      return stripStrayLiteralNewlineText(new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers }), path);
    }
    return stripStrayLiteralNewlineText(assetResponse, path);
  },
};
