const API_BASE = "https://api.meteopt.com/gfs/json";
const LOCATION = {
  name: "Giresun / Çanakçı",
  latitude: 40.9557,
  longitude: 39.0065,
};
const CYCLES = [18, 12, 6, 0];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function runKey(value) {
  const digits = String(value || "").replace(/\\D/g, "");
  return digits.length >= 10 ? digits.slice(0, 10) : digits;
}

function parseRun(value, fallback) {
  const key = runKey(value);
  if (key.length === 10) {
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(4, 6)) - 1;
    const d = Number(key.slice(6, 8));
    const h = Number(key.slice(8, 10));
    const date = new Date(Date.UTC(y, m, d, h, 0, 0));
    if (Number.isFinite(date.getTime())) return date;
  }
  return fallback;
}

function asNumber(values, index) {
  try {
    const n = Number(values?.[index]);
    return Number.isFinite(n) && Math.abs(n) !== Infinity ? n : null;
  } catch (_) {
    return null;
  }
}

async function fetchCycle(requestedHour) {
  const url = new URL(API_BASE);
  url.searchParams.set("lat", String(LOCATION.latitude));
  url.searchParams.set("lon", String(LOCATION.longitude));
  url.searchParams.set("run", String(requestedHour).padStart(2, "0"));
  url.searchParams.set("lang", "en");

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "GFS-Watch-Koy-Cloudflare/1.0",
      "Cache-Control": "no-cache",
    },
  });
  if (!response.ok) throw new Error("MeteoPT HTTP " + response.status);

  const document = await response.json();
  const apiRun = String(document?.run || "").trim();
  if (!apiRun) throw new Error("MeteoPT returned no run id");

  return { apiRun, document, url: url.toString() };
}

async function fetchNewestCycle() {
  const candidates = [];
  for (const requestedHour of CYCLES) {
    try {
      candidates.push(await fetchCycle(requestedHour));
    } catch (error) {
      console.log(JSON.stringify({
        event: "meteopt_cycle_unavailable",
        requested_hour: requestedHour,
        message: String(error?.message || error),
      }));
    }
  }

  if (!candidates.length) {
    throw new Error("MeteoPT returned no usable GFS cycle");
  }

  candidates.sort((a, b) => runKey(b.apiRun).localeCompare(runKey(a.apiRun)));
  return candidates[0];
}

function normalizeDocument(candidate, now) {
  const fallbackCycle = new Date(now);
  fallbackCycle.setUTCMinutes(0, 0, 0);
  const cycle = parseRun(candidate.apiRun, fallbackCycle);
  const runId = cycle.toISOString().slice(0, 13).replace(/[-:T]/g, "");

  const steps = [];
  for (const value of (candidate.document?.steps?.values || [])) {
    const n = Number(value);
    if (Number.isFinite(n)) steps.push(n);
  }
  if (!steps.length) throw new Error("MeteoPT returned no forecast steps");

  const data = candidate.document?.data || {};
  const series = name => data?.[name]?.values || [];

  const points = [];
  for (let i = 0; i < steps.length; i += 1) {
    const lead = steps[i];
    if (lead <= 0) continue;
    const valid = new Date(cycle.getTime() + lead * 3600000);
    points.push({
      forecast_hour: lead,
      valid_time_utc: valid.toISOString().slice(0, 16),
      temperature_2m_c: asNumber(series("tmp2m"), i),
      temperature_850hpa_c: asNumber(series("tmp850mb"), i),
      wind_speed_10m_kmh: asNumber(series("wind10m"), i),
      wind_speed_850hpa_kmh: asNumber(series("wind850"), i),
      precipitation_6h_mm: asNumber(series("apcp"), i),
    });
  }

  const base = {
    location: LOCATION,
    source: "MeteoPT GFS",
    source_url: candidate.url,
    run_id_utc: cycle.toISOString().slice(0, 19),
    published_at_utc: new Date(now).toISOString().slice(0, 19),
    forecast_source: "meteopt",
  };

  const f72 = steps.includes(72)
    ? {
        ...base,
        schema: "koy-gfs.first72.v1",
        forecast_6_hourly: points.filter(p => p.forecast_hour > 0 && p.forecast_hour <= 72),
      }
    : null;

  const ready180 = steps.includes(180) && points.filter(p => p.forecast_hour > 0 && p.forecast_hour <= 180).length >= 60;
  const full = ready180
    ? {
        ...base,
        schema: "koy-gfs.run.v1",
        forecast_6_hourly: points,
      }
    : null;

  return {
    runId,
    f72,
    full,
    maxForecastHour: Math.max(...steps),
    stepCount: steps.length,
  };
}

async function currentRun(env, key) {
  const row = await env.GFS_DB.prepare(
    "SELECT run_id_utc, payload_json, updated_at_utc FROM gfs_current WHERE key = ?"
  ).bind(key).first();
  if (!row) return null;
  return {
    run_id_utc: row.run_id_utc,
    payload: JSON.parse(row.payload_json),
    updated_at_utc: row.updated_at_utc,
  };
}

async function persistRun(env, full) {
  const existing = await env.GFS_DB.prepare(
    "SELECT run_id_utc FROM gfs_runs WHERE run_id_utc = ?"
  ).bind(full.run_id_utc).first();

  if (existing) return false;

  const storedAt = new Date().toISOString();
  await env.GFS_DB.prepare(
    "INSERT INTO gfs_runs (run_id_utc, payload_json, published_at_utc, stored_at_utc) VALUES (?, ?, ?, ?)"
  ).bind(
    full.run_id_utc,
    JSON.stringify(full),
    full.published_at_utc,
    storedAt,
  ).run();

  return true;
}

async function persistF72(env, f72) {
  const stored = await currentRun(env, "f72");
  if (stored?.run_id_utc === f72.run_id_utc) return false;

  await env.GFS_DB.prepare(
    "INSERT INTO gfs_current (key, run_id_utc, payload_json, updated_at_utc) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET run_id_utc=excluded.run_id_utc, payload_json=excluded.payload_json, updated_at_utc=excluded.updated_at_utc"
  ).bind(
    "f72",
    f72.run_id_utc,
    JSON.stringify(f72),
    new Date().toISOString(),
  ).run();

  return true;
}

async function collect(env) {
  const now = new Date();
  const candidate = await fetchNewestCycle();
  const normalized = normalizeDocument(candidate, now);

  let f72Changed = false;
  let f180Changed = false;

  if (normalized.f72) {
    f72Changed = await persistF72(env, normalized.f72);
  }

  if (normalized.full) {
    f180Changed = await persistRun(env, normalized.full);

    // Keep the F72 endpoint on the same canonical F180-ready cycle once it exists.
    if (f180Changed) {
      f72Changed = await persistF72(env, normalized.full) || f72Changed;
    }
  }

  console.log(JSON.stringify({
    event: "koy_gfs_collect",
    run_id_utc: normalized.runId,
    f72_ready: Boolean(normalized.f72),
    f72_changed: f72Changed,
    f180_ready: Boolean(normalized.full),
    f180_changed: f180Changed,
    max_forecast_hour: normalized.maxForecastHour,
    step_count: normalized.stepCount,
  }));

  return {
    ok: true,
    run_id_utc: normalized.runId,
    f72_ready: Boolean(normalized.f72),
    f72_changed: f72Changed,
    f180_ready: Boolean(normalized.full),
    f180_changed: f180Changed,
    max_forecast_hour: normalized.maxForecastHour,
    step_count: normalized.stepCount,
    checked_at_utc: now.toISOString(),
  };
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\\/+$/, "");

  if (request.method === "OPTIONS") return json({ ok: true });
  if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  if (path === "/api/health") {
    try {
      const current = await currentRun(env, "f72");
      const count = await env.GFS_DB.prepare("SELECT COUNT(*) AS count FROM gfs_runs").first();
      return json({
        ok: true,
        service: "gfs-watch-koy-gfs",
        storage: "D1",
        cron: "*/10 * * * *",
        location: LOCATION,
        latest_run_id_utc: current?.run_id_utc || null,
        latest_updated_at_utc: current?.updated_at_utc || null,
        archived_runs: Number(count?.count || 0),
      });
    } catch (error) {
      return json({ ok: false, service: "gfs-watch-koy-gfs", error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/f72") {
    try {
      const current = await currentRun(env, "f72");
      if (!current) return json({ ok: false, error: "F72 data not collected yet" }, 404);
      return json(current.payload);
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/comparison") {
    try {
      const result = await env.GFS_DB.prepare(
        "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
      ).all();
      const runs = (result.results || []).map(row => JSON.parse(row.payload_json));
      return json({
        schema: "koy-gfs.comparison.v1",
        location: LOCATION,
        updated_at_utc: runs[0]?.published_at_utc || null,
        runs,
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/latest") {
    try {
      const current = await currentRun(env, "f72");
      const comparison = await env.GFS_DB.prepare(
        "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
      ).all();
      return json({
        ok: true,
        f72: current?.payload || null,
        comparison: {
          schema: "koy-gfs.comparison.v1",
          location: LOCATION,
          updated_at_utc: current?.updated_at_utc || null,
          runs: (comparison.results || []).map(row => JSON.parse(row.payload_json)),
        },
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  return json({ ok: false, error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    return api(request, env);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      collect(env).catch(error => {
        console.error(JSON.stringify({
          event: "koy_gfs_cron_error",
          message: String(error?.message || error),
          scheduled_time: new Date(controller.scheduledTime).toISOString(),
        }));
      })
    );
  },
};
