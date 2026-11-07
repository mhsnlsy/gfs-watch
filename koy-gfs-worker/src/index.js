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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function runKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
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

async function fetchAvailableCycles() {
  const candidates = [];
  // Fetch all four available MeteoPT cycle selectors on every Cloudflare poll.
  // This deliberately keeps the previous three cycles available for the four-run
  // comparison instead of only persisting the newest cycle.
  const preferred = [6, ...CYCLES.filter(h => h !== 6)];
  for (const requestedHour of preferred) {
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

  const unique = new Map();
  for (const candidate of candidates) {
    const key = runKey(candidate.apiRun);
    if (key) unique.set(key, candidate);
  }

  const sorted = [...unique.values()].sort((a, b) =>
    runKey(b.apiRun).localeCompare(runKey(a.apiRun))
  );

  if (!sorted.length) {
    throw new Error("MeteoPT returned no usable GFS cycle");
  }

  return sorted;
}

async function fetchNewestCycle() {
  return (await fetchAvailableCycles())[0];
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
      valid_time_utc: valid.toISOString(),
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
    run_id_utc: cycle.toISOString(),
    published_at_utc: new Date(now).toISOString(),
    forecast_source: "meteopt",
  };

  const f72Ready = Math.max(...steps) >= 72 && points.filter(p => p.forecast_hour > 0 && p.forecast_hour <= 72).length >= 12;
  const f72 = f72Ready
    ? {
        ...base,
        schema: "koy-gfs.first72.v1",
        forecast_6_hourly: points.filter(p => p.forecast_hour > 0 && p.forecast_hour <= 72),
      }
    : null;

  const ready180 = Math.max(...steps) >= 180 && points.filter(p => p.forecast_hour > 0 && p.forecast_hour <= 180).length >= 30;
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

async function getPublicationAsset(env, key) {
  return await env.GFS_DB.prepare(
    "SELECT asset_key, run_id_utc, content_type, body, updated_at_utc " +
    "FROM gfs_publication_assets WHERE asset_key = ?"
  ).bind(key).first();
}

async function putPublicationAsset(env, asset) {
  await env.GFS_DB.prepare(
    "INSERT INTO gfs_publication_assets (asset_key, run_id_utc, content_type, body, updated_at_utc) " +
    "VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(asset_key) DO UPDATE SET run_id_utc=excluded.run_id_utc, " +
    "content_type=excluded.content_type, body=excluded.body, updated_at_utc=excluded.updated_at_utc"
  ).bind(
    asset.key,
    asset.run_id_utc || null,
    asset.content_type,
    asset.body,
    new Date().toISOString(),
  ).run();
}

function decodePublicationAsset(row) {
  const headers = new Headers({
    "Content-Type": row.content_type || "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=3600, s-maxage=86400",
    "Access-Control-Allow-Origin": "*",
    "X-GFS-Publication-Source": "D1",
  });
  if (row.updated_at_utc) headers.set("Last-Modified", row.updated_at_utc);
  return new Response(row.body, { status: 200, headers });
}

async function handlePublicationUpload(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const authorization = request.headers.get("Authorization") || "";
  if (!env.GFS_DISPATCH_TOKEN || authorization !== "Bearer " + env.GFS_DISPATCH_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const key = String(payload?.key || "").replace(/^\\/+/, "");
  const body = typeof payload?.body === "string" ? payload.body : "";
  const contentType = String(payload?.content_type || "image/svg+xml; charset=utf-8");
  const runId = payload?.run_id_utc ? String(payload.run_id_utc) : null;
  if (!/^media\\/koy-gfs-[0-9]{8}T[0-9]{2}Z-comparison\\.svg$/.test(key)) {
    return json({ ok: false, error: "Unsupported Köy publication asset path" }, 400);
  }
  if (!body || body.length > 1900000) {
    return json({ ok: false, error: "SVG body is empty or exceeds the D1 row safety limit" }, 413);
  }
  if (!contentType.startsWith("image/svg+xml")) {
    return json({ ok: false, error: "Only SVG publication assets are accepted" }, 415);
  }
  if (!body.includes("<svg") || !body.includes("</svg>")) {
    return json({ ok: false, error: "SVG document is incomplete" }, 400);
  }

  try {
    await putPublicationAsset(env, { key, body, content_type: contentType, run_id_utc: runId });
    return json({ ok: true, key, bytes: body.length, source: "D1" });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error) }, 500);
  }
}

async function collect(env) {
  const now = new Date();
  const candidates = await fetchAvailableCycles();
  const normalizedRuns = candidates.map(candidate => normalizeDocument(candidate, now));
  const normalized = normalizedRuns[0];

  let f72Changed = false;
  let f180Changed = false;
  let archivedRunsChanged = 0;

  // The newest cycle remains the canonical F72/F180 output.
  if (normalized.f72) {
    f72Changed = await persistF72(env, normalized.f72);
  }

  // Persist every available F180-ready cycle. This backfills the previous three
  // cycles on the first Cloudflare poll and maintains the four-run comparison
  // automatically thereafter.
  for (const run of normalizedRuns) {
    if (run.full && await persistRun(env, run.full)) {
      archivedRunsChanged += 1;
      f180Changed = true;
    }
  }

  // Keep the F72 endpoint on the same canonical F180-ready cycle once it exists.
  if (normalized.full && f180Changed) {
    f72Changed = await persistF72(env, normalized.full) || f72Changed;
  }

  console.log(JSON.stringify({
    event: "koy_gfs_collect",
    run_id_utc: normalized.runId,
    fetched_cycles: normalizedRuns.length,
    archived_runs_changed: archivedRunsChanged,
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
    fetched_cycles: normalizedRuns.length,
    archived_runs_changed: archivedRunsChanged,
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
  const path = url.pathname.replace(/\/+$/, "");

  if (request.method === "OPTIONS") return json({ ok: true });

  // The authenticated publisher is the only write route; keep it ahead of the GET-only API guard.
  if (path === "/api/publication-upload") {
    return handlePublicationUpload(request, env);
  }
  if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  if (path.startsWith("/api/publication-asset/")) {
    const key = decodeURIComponent(path.slice("/api/publication-asset/".length)).replace(/^\\/+/, "");
    try {
      const row = await getPublicationAsset(env, key);
      if (!row) return json({ ok: false, error: "Publication asset not found" }, 404);
      return decodePublicationAsset(row);
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/health") {
    try {
      const current = await currentRun(env, "f72");
      const count = await env.GFS_DB.prepare("SELECT COUNT(*) AS count FROM gfs_runs").first();
      const assetCount = await env.GFS_DB.prepare("SELECT COUNT(*) AS count FROM gfs_publication_assets").first();
      return json({
        ok: true,
        service: "gfs-watch-koy-gfs",
        storage: "D1",
        cron: "*/10 * * * *",
        location: LOCATION,
        latest_run_id_utc: current?.run_id_utc || null,
        latest_updated_at_utc: current?.updated_at_utc || null,
        archived_runs: Number(count?.count || 0),
        publication_assets: Number(assetCount?.count || 0),
        publication_upload_configured: Boolean(env.GFS_DISPATCH_TOKEN),
      });
    } catch (error) {
      return json({ ok: false, service: "gfs-watch-koy-gfs", error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/f72") {
    try {
      let current = await currentRun(env, "f72");
      // Bootstrap the first dataset on demand. This removes the cold-start gap
      // between Worker deployment and the first 10-minute Cron tick.
      if (!current) {
        await collect(env);
        current = await currentRun(env, "f72");
      }
      if (!current) return json({ ok: false, error: "F72 data not collected yet" }, 404);
      return json(current.payload);
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/comparison") {
    try {
      let result = await env.GFS_DB.prepare(
        "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
      ).all();
      let runs = (result.results || []).map(row => JSON.parse(row.payload_json));

      // If the comparison archive is incomplete (for example immediately after
      // migration), fetch all currently available MeteoPT cycles before replying.
      if (runs.length < 4) {
        await collect(env);
        result = await env.GFS_DB.prepare(
          "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
        ).all();
        runs = (result.results || []).map(row => JSON.parse(row.payload_json));
      }

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
      let current = await currentRun(env, "f72");
      // Same cold-start bootstrap for clients that use the aggregate endpoint.
      if (!current) {
        await collect(env);
        current = await currentRun(env, "f72");
      }
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
