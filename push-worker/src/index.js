const DEFAULT_ORIGIN = "https://mhsnlsy.github.io";

function corsHeaders(request, env) {
  const headers = new Headers({
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  });
  const origin = request.headers.get("Origin");
  if (origin && origin === (env.ALLOWED_ORIGIN || DEFAULT_ORIGIN)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function json(data, status = 200, headers = new Headers()) {
  const out = new Headers(headers);
  out.set("Content-Type", "application/json; charset=utf-8");
  out.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: out });
}

function authorized(request, env) {
  const token = env.PUSH_ADMIN_TOKEN;
  return Boolean(token && request.headers.get("Authorization") === `Bearer ${token}`);
}

async function readJson(request, maxBytes = 16_384) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maxBytes) throw new Error("Request body too large");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("Request body too large");
  return JSON.parse(text);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request, env);
    const origin = request.headers.get("Origin");
    const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;

    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers });
    }

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true, service: "gfs-watch-push" }, 200, headers);
      }

      if (url.pathname === "/vapid-public-key" && request.method === "GET") {
        if (!env.VAPID_PUBLIC_KEY) return json({ error: "Push service is not configured" }, 503, headers);
        return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, headers);
      }

      if (url.pathname === "/subscribe" && request.method === "POST") {
        if (origin !== allowedOrigin) return json({ error: "Origin not allowed" }, 403, headers);
        const subscription = await readJson(request);
        const endpoint = subscription && subscription.endpoint;
        const keys = subscription && subscription.keys;
        if (typeof endpoint !== "string" || !endpoint.startsWith("https://") ||
            !keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
          return json({ error: "Invalid push subscription" }, 400, headers);
        }
        await env.DB.prepare(
          "INSERT INTO push_subscriptions (endpoint, subscription_json, created_at, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json, updated_at = excluded.updated_at"
        ).bind(endpoint, JSON.stringify(subscription), new Date().toISOString(), new Date().toISOString()).run();
        return json({ ok: true, subscribed: true }, 201, headers);
      }

      if (url.pathname.startsWith("/admin/")) {
        if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);

        if (url.pathname === "/admin/subscriptions" && request.method === "GET") {
          const result = await env.DB.prepare(
            "SELECT subscription_json FROM push_subscriptions ORDER BY created_at ASC LIMIT 500"
          ).all();
          const subscriptions = (result.results || []).map(row => {
            try { return JSON.parse(row.subscription_json); } catch (_) { return null; }
          }).filter(Boolean);
          return json({ subscriptions }, 200, headers);
        }

        if (url.pathname === "/admin/subscriptions/delete" && request.method === "POST") {
          const body = await readJson(request);
          if (typeof body.endpoint !== "string" || !body.endpoint.startsWith("https://")) {
            return json({ error: "Invalid endpoint" }, 400, headers);
          }
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(body.endpoint).run();
          return json({ ok: true }, 200, headers);
        }

        if (url.pathname === "/admin/notification-sent" && request.method === "GET") {
          const id = url.searchParams.get("id") || "";
          if (!id || id.length > 200) return json({ error: "Invalid notification id" }, 400, headers);
          const row = await env.DB.prepare("SELECT id, sent_at, recipient_count FROM sent_notifications WHERE id = ?").bind(id).first();
          return json({ sent: Boolean(row), record: row || null }, 200, headers);
        }

        if (url.pathname === "/admin/notification-sent" && request.method === "POST") {
          const body = await readJson(request);
          if (typeof body.id !== "string" || !body.id || body.id.length > 200 ||
              !Number.isInteger(body.recipient_count) || body.recipient_count < 1) {
            return json({ error: "Invalid sent notification record" }, 400, headers);
          }
          await env.DB.prepare(
            "INSERT OR IGNORE INTO sent_notifications (id, sent_at, recipient_count) VALUES (?, ?, ?)"
          ).bind(body.id, new Date().toISOString(), body.recipient_count).run();
          return json({ ok: true }, 201, headers);
        }
      }

      return json({ error: "Not found" }, 404, headers);
    } catch (error) {
      console.error("Push API error:", error && error.message ? error.message : error);
      return json({ error: "Internal server error" }, 500, headers);
    }
  }
};
