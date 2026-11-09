import webPush from "web-push";

const DEFAULT_ORIGIN = "https://gfs-watch-web.muhsin-ulusoy.workers.dev";
const GFS_12Z_URL = "https://api.meteopt.com/gfs/json?lat=41.014&lon=28.95&run=12&lang=en";
const ISTANBUL_TZ = "Europe/Istanbul"; // Istanbul local time for daily push — verified test path

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

async function readJson(request, maxBytes = 16_384) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maxBytes) throw new Error("Request body too large");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("Request body too large");
  return JSON.parse(text);
}

function toNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function formatTemperature(value) {
  return String(Math.round(Math.abs(value) * 10) / 10).replace(".", ",");
}

function dateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ISTANBUL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function localHour(date) {
  return Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: ISTANBUL_TZ,
    hour: "2-digit",
    hourCycle: "h23"
  }).format(date));
}

function cloudLabel(value) {
  return value < 40 ? "güneşli" : value < 70 ? "parçalı bulutlu" : "bulutlu";
}

async function buildTomorrowWeather() {
  const response = await fetch(GFS_12Z_URL, {
    headers: {
      "User-Agent": "IstanbulunHavasi-CloudflareTomorrowPush/1.0",
      "Cache-Control": "no-cache"
    },
    signal: AbortSignal.timeout(45_000)
  });

  if (!response.ok) throw new Error("MeteoPT HTTP " + response.status);

  const doc = await response.json();
  const digits = String(doc.run || "").replace(/\D/g, "").slice(0, 10);

  if (digits.length !== 10 || Number(digits.slice(8, 10)) !== 12) {
    throw new Error("Expected 12Z GFS, received: " + doc.run);
  }

  const cycle = new Date(Date.UTC(
    Number(digits.slice(0, 4)),
    Number(digits.slice(4, 6)) - 1,
    Number(digits.slice(6, 8)),
    12
  ));

  const steps = doc.steps?.values || [];
  const temps = doc.data?.tmp2m?.values || [];
  const precip = doc.data?.apcp?.values || [];
  const clouds = doc.data?.clouds?.values || [];
  const points = [];

  for (let i = 0; i < steps.length; i++) {
    const lead = toNumber(steps[i]);
    if (lead === null || lead < 0) continue;

    const valid = new Date(cycle.getTime() + lead * 3_600_000);
    points.push({
      date: dateKey(valid),
      hour: localHour(valid),
      temp: toNumber(temps[i]),
      precip: toNumber(precip[i]),
      clouds: toNumber(clouds[i])
    });
  }

  const today = dateKey(new Date());
  const tomorrow = dateKey(new Date(Date.now() + 86_400_000));

  const todayPoints = points.filter(p => p.date === today && p.temp !== null);
  const tomorrowPoints = points.filter(p => p.date === tomorrow && p.temp !== null);

  if (!todayPoints.length || !tomorrowPoints.length) {
    throw new Error("12Z GFS lacks today/tomorrow temperature data.");
  }

  const todayMax = Math.max(...todayPoints.map(p => p.temp));
  const tomorrowMax = Math.max(...tomorrowPoints.map(p => p.temp));

  const cloudPoint = tomorrowPoints
    .filter(p => p.clouds !== null)
    .sort((a, b) => Math.abs(a.hour - 15) - Math.abs(b.hour - 15))[0];

  if (!cloudPoint) throw new Error("12Z GFS lacks Clouds data for tomorrow.");

  const rainy = tomorrowPoints.some(
    p => p.precip !== null && p.precip > 0
  );

  const weather = rainy ? "yağmurlu" : cloudLabel(cloudPoint.clouds);
  const delta = tomorrowMax - todayMax;

  const comparison = Math.abs(delta) < 0.05
    ? "bugünle aynı sıcaklıkta"
    : "bugünden " + formatTemperature(delta) + "°C daha " + (delta > 0 ? "sıcak" : "soğuk");

  const body = "Yarın hava " + formatTemperature(tomorrowMax) + "°C, " + comparison + ", " + weather + ".";

  return {
    run: digits + "Z",
    tomorrow,
    id: "tomorrow-weather-" + digits + "Z-" + tomorrow,
    body
  };
}

async function sendTomorrowWeatherPush(env) {
  const weather = await buildTomorrowWeather();

  const rows = await env.DB
    .prepare("SELECT subscription_json FROM push_subscriptions LIMIT 500")
    .all();

  const subscriptions = (rows.results || [])
    .map(row => {
      try { return JSON.parse(row.subscription_json); } catch (_) { return null; }
    })
    .filter(Boolean);

  if (!subscriptions.length) {
    console.log("19:45 push: no subscriptions");
    return { ok: true, delivered: 0, reason: "no-subscriptions", ...weather };
  }

  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    throw new Error("VAPID keys not configured.");
  }

  webPush.setVapidDetails(
    env.VAPID_SUBJECT || DEFAULT_ORIGIN + "/",
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

  const payload = JSON.stringify({
    title: "İstanbul · Yarın hava nasıl?",
    body: weather.body,
    tag: "gfs-tomorrow-weather",
    url: DEFAULT_ORIGIN + "/#bildirimler"
  });

  let delivered = 0;

  for (const sub of subscriptions) {
    try {
      await webPush.sendNotification(sub, payload, {
        TTL: 86_400,
        urgency: "normal"
      });
      delivered++;
    } catch (error) {
      const status = Number(error.statusCode || 0);
      console.error("Web push failed:", status || error.message);

      if (status === 404 || status === 410) {
        await env.DB
          .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
          .bind(sub.endpoint)
          .run();
      }
    }
  }

  console.log(
    "19:45 push:",
    JSON.stringify({
      run: weather.run,
      tomorrow: weather.tomorrow,
      body: weather.body,
      delivered,
      subscriptions: subscriptions.length
    })
  );

  return {
    ok: true,
    delivered,
    subscriptions: subscriptions.length,
    ...weather
  };
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
        if (!env.VAPID_PUBLIC_KEY) {
          return json({ error: "Push service is not configured" }, 503, headers);
        }
        return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, headers);
      }

      if (url.pathname === "/admin/send-tomorrow-weather" && request.method === "POST") {
        const token = env.PUSH_ADMIN_TOKEN;
        if (!token || request.headers.get("Authorization") !== "Bearer " + token) {
          return json({ error: "Unauthorized" }, 401, headers);
        }
        const result = await sendTomorrowWeatherPush(env);
        return json({ ...result, manual: true }, 200, headers);
      }

      if (url.pathname === "/subscribe" && request.method === "POST") {
        if (origin !== allowedOrigin) {
          return json({ error: "Origin not allowed" }, 403, headers);
        }

        const subscription = await readJson(request);
        const endpoint = subscription && subscription.endpoint;
        const keys = subscription && subscription.keys;

        if (
          typeof endpoint !== "string" ||
          !endpoint.startsWith("https://") ||
          !keys ||
          typeof keys.p256dh !== "string" ||
          typeof keys.auth !== "string"
        ) {
          return json({ error: "Invalid push subscription" }, 400, headers);
        }

        const now = new Date().toISOString();

        await env.DB
          .prepare(
            "INSERT INTO push_subscriptions (endpoint, subscription_json, created_at, updated_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json, updated_at = excluded.updated_at"
          )
          .bind(endpoint, JSON.stringify(subscription), now, now)
          .run();

        return json({ ok: true, subscribed: true }, 201, headers);
      }


      return json({ error: "Not found" }, 404, headers);
    } catch (error) {
      console.error(
        "Push API error:",
        error && error.message ? error.message : error
      );
      return json({ error: "Internal server error" }, 500, headers);
    }
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "45 16 * * *") {
      ctx.waitUntil(sendTomorrowWeatherPush(env));
    }
  }
};
