import webPush from "web-push";

const DEFAULT_ORIGIN = "https://gfs-watch-web.muhsin-ulusoy.workers.dev";
const GFS_12Z_URL = "https://api.meteopt.com/gfs/json?lat=41.014&lon=28.95&run=12&lang=en";

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

        if (url.pathname === "/admin/test-tomorrow-weather-push" && request.method === "POST") {
        const rows = await env.DB.prepare("SELECT subscription_json FROM push_subscriptions ORDER BY created_at ASC LIMIT 500").all();
        const subscriptions = (rows.results || []).map(row => { try { return JSON.parse(row.subscription_json); } catch (_) { return null; } }).filter(Boolean);
        if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return json({ error: "VAPID keys not configured" }, 503, headers);
        webPush.setVapidDetails(env.VAPID_SUBJECT || DEFAULT_ORIGIN + "/", env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
        const payload = JSON.stringify({ title: "İstanbul · Web Push test", body: "Web Push bağlantısı çalışıyor.", tag: "gfs-test-" + Date.now(), url: DEFAULT_ORIGIN + "/#bildirimler" });
        let delivered = 0;
        for (const sub of subscriptions) {
          try { await webPush.sendNotification(sub, payload, { TTL: 3600, urgency: "normal" }); delivered++; }
          catch (error) {
            const status = Number(error.statusCode || 0);
            console.error("Test push failed:", status || error.message);
            if (status === 404 || status === 410) await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
          }
        }
        return json({ ok: true, subscriptions: subscriptions.length, delivered }, 200, headers);
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
  },
  async scheduled(event, env, ctx) {
    if (event.cron !== "45 16 * * *") return;
    ctx.waitUntil((async () => {
      const response = await fetch(GFS_12Z_URL, {
        headers: { "User-Agent": "IstanbulunHavasi-CloudflareTomorrowPush/1.0", "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(45000)
      });
      if (!response.ok) throw new Error("MeteoPT HTTP " + response.status);
      const doc = await response.json();
      const digits = String(doc.run || "").replace(/\D/g, "").slice(0, 10);
      if (digits.length !== 10 || Number(digits.slice(8, 10)) !== 12) throw new Error("Expected 12Z GFS, received: " + doc.run);

      const tz = "Europe/Istanbul";
      const dateKey = d => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
      const hour = d => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(d));
      const n = v => Number.isFinite(Number(v)) ? Number(v) : null;
      const fmt = v => String(Math.round(Math.abs(v) * 10) / 10).replace(".", ",");
      const cloudLabel = v => v < 40 ? "güneşli" : v < 70 ? "parçalı bulutlu" : "bulutlu";
      const cycle = new Date(Date.UTC(Number(digits.slice(0,4)), Number(digits.slice(4,6))-1, Number(digits.slice(6,8)), 12));
      const steps = doc.steps?.values || [];
      const tmp = doc.data?.tmp2m?.values || [];
      const rain = doc.data?.apcp?.values || [];
      const clouds = doc.data?.clouds?.values || [];
      const points = [];
      for (let i=0; i<steps.length; i++) {
        const lead=n(steps[i]); if (lead===null || lead<=0) continue;
        const valid=new Date(cycle.getTime()+lead*3600000);
        points.push({date:dateKey(valid),hour:hour(valid),temp:n(tmp[i]),precip:n(rain[i]),clouds:n(clouds[i])});
      }
      const today=dateKey(new Date()), tomorrow=dateKey(new Date(Date.now()+86400000));
      const tp=points.filter(p=>p.date===today&&p.temp!==null);
      const mp=points.filter(p=>p.date===tomorrow&&p.temp!==null);
      if (!tp.length || !mp.length) throw new Error("12Z GFS lacks today/tomorrow temperature data.");
      const todayMax=Math.max(...tp.map(p=>p.temp)), tomorrowMax=Math.max(...mp.map(p=>p.temp));
      const cp=mp.filter(p=>p.clouds!==null).sort((a,b)=>Math.abs(a.hour-15)-Math.abs(b.hour-15))[0];
      if (!cp) throw new Error("12Z GFS lacks Clouds data for tomorrow.");
      const rainy=mp.some(p=>p.precip!==null&&p.precip>0);
      const weather=rainy?"yağmurlu":cloudLabel(cp.clouds);
      const delta=tomorrowMax-todayMax;
      const comparison=Math.abs(delta)<0.05?"bugünle aynı sıcaklıkta":"bugünden "+fmt(delta)+"°C daha "+(delta>0?"sıcak":"soğuk");
      const body="Yarın hava "+fmt(tomorrowMax)+"°C, "+comparison+", "+weather+".";
      const id="tomorrow-weather-"+digits+"Z-"+tomorrow;
      if (await env.DB.prepare("SELECT id FROM sent_notifications WHERE id = ?").bind(id).first()) return;
      const rows=await env.DB.prepare("SELECT subscription_json FROM push_subscriptions ORDER BY created_at ASC LIMIT 500").all();
      const subscriptions=(rows.results||[]).map(row=>{try{return JSON.parse(row.subscription_json)}catch(_){return null}}).filter(Boolean);
      if (!subscriptions.length) return;
      if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error("VAPID keys not configured.");
      webPush.setVapidDetails(env.VAPID_SUBJECT||DEFAULT_ORIGIN+"/",env.VAPID_PUBLIC_KEY,env.VAPID_PRIVATE_KEY);
      const payload=JSON.stringify({title:"İstanbul · Yarın hava nasıl?",body,tag:"gfs-"+id,url:DEFAULT_ORIGIN+"/#bildirimler"});
      let delivered=0;
      for (const sub of subscriptions) {
        try { await webPush.sendNotification(sub,payload,{TTL:86400,urgency:"normal"}); delivered++; }
        catch(error) {
          const status=Number(error.statusCode||0);
          console.error("Tomorrow push failed:",status||error.message);
          if(status===404||status===410) await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
        }
      }
      if(delivered>0) await env.DB.prepare("INSERT OR IGNORE INTO sent_notifications (id,sent_at,recipient_count) VALUES (?,?,?)").bind(id,new Date().toISOString(),delivered).run();
      console.log("19:45 tomorrow weather push:",JSON.stringify({id,body,delivered}));
    })());
  }
};
