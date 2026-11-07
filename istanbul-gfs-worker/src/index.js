// Istanbul GFS Worker: canonical MeteoPT collector + D1 event dispatcher\nconst API_BASE = "https://api.meteopt.com/gfs/json";
const LOCATION = {
  name: "Istanbul",
  latitude: 41.014,
  longitude: 28.950,
  nearest_gfs_grid_latitude: 41.0,
  nearest_gfs_grid_longitude: 29.0,
};
const CYCLES = [18, 12, 6, 0];
const RETENTION_DAYS = 14;
const UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
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

function number(values, index) {
  const value = Number(values?.[index]);
  return Number.isFinite(value) ? value : null;
}

function parseRun(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 10) throw new Error("MeteoPT returned an invalid run identifier");
  const key = digits.slice(0, 10);
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(4, 6)) - 1;
  const day = Number(key.slice(6, 8));
  const hour = Number(key.slice(8, 10));
  const date = new Date(Date.UTC(year, month, day, hour));
  if (!Number.isFinite(date.getTime()) || date.getUTCHours() !== hour) {
    throw new Error("MeteoPT returned an invalid run date");
  }
  return date;
}

function utcIso(date) {
  return date.toISOString().replace(/\.000Z$/, "+00:00").replace(/Z$/, "+00:00");
}

function istanbulIso(date) {
  return new Date(date.getTime() + UTC_OFFSET_MS)
    .toISOString()
    .slice(0, 16) + "+03:00";
}

async function fetchCycle(requestedHour) {
  const url = new URL(API_BASE);
  url.searchParams.set("lat", String(LOCATION.latitude));
  url.searchParams.set("lon", String(LOCATION.longitude));
  url.searchParams.set("run", String(requestedHour).padStart(2, "0"));
  url.searchParams.set("lang", "en");

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "GFS-Watch-Istanbul-Cloudflare/1.0",
      "Cache-Control": "no-cache",
    },
  });
  if (!response.ok) throw new Error("MeteoPT HTTP " + response.status);

  const document = await response.json();
  if (!document || typeof document !== "object") {
    throw new Error("MeteoPT returned an invalid document");
  }
  const cycle = parseRun(document.run);
  if (cycle.getUTCHours() !== requestedHour) {
    throw new Error(
      "Requested " + String(requestedHour).padStart(2, "0") +
      "Z but MeteoPT returned " + utcIso(cycle)
    );
  }
  return { cycle, document, url: url.toString(), requestedHour };
}

function normalize(candidate, now) {
  const steps = [];
  for (const value of candidate.document?.steps?.values || []) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) steps.push(Math.trunc(parsed));
  }
  if (!steps.length) throw new Error("MeteoPT returned no forecast steps");
  steps.sort((a, b) => a - b);

  const names = {
    tmp2m: "temperature_2m_c",
    tmp850mb: "temperature_850hpa_c",
    wind10m: "wind_speed_10m_kmh",
    winddir10m: "wind_direction_10m_deg",
    wind850: "wind_speed_850hpa_kmh",
    apcp: "precipitation_6h_mm",
  };
  const series = {};
  for (const key of Object.keys(names)) {
    series[key] = candidate.document?.data?.[key]?.values || [];
  }

  const points = [];
  for (let index = 0; index < steps.length; index += 1) {
    const lead = steps[index];
    if (lead <= 0) continue;
    const valid = new Date(candidate.cycle.getTime() + lead * 3600000);
    const point = {
      forecast_hour: lead,
      valid_time_utc: utcIso(valid),
      valid_time_istanbul: istanbulIso(valid),
    };
    for (const [sourceKey, outputKey] of Object.entries(names)) {
      point[outputKey] = number(series[sourceKey], index);
    }
    points.push(point);
  }

  const byDay = new Map();
  for (const point of points) {
    const day = point.valid_time_istanbul.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(point);
  }

  const daily = [];
  for (const [day, dayPoints] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const values = key => dayPoints
      .map(point => point[key])
      .filter(value => value !== null && Number.isFinite(value));
    const temp = values("temperature_2m_c");
    const temp850 = values("temperature_850hpa_c");
    const rain = values("precipitation_6h_mm");
    const wind = values("wind_speed_10m_kmh");
    const wind850 = values("wind_speed_850hpa_kmh");
    daily.push({
      date_istanbul: day,
      temperature_min_c: temp.length ? Math.min(...temp) : null,
      temperature_max_c: temp.length ? Math.max(...temp) : null,
      temperature_850hpa_min_c: temp850.length ? Math.min(...temp850) : null,
      temperature_850hpa_max_c: temp850.length ? Math.max(...temp850) : null,
      precipitation_total_mm: rain.reduce((sum, value) => sum + Math.max(0, value), 0),
      wind_speed_max_10m_kmh: wind.length ? Math.max(...wind) : null,
      wind_speed_max_850hpa_kmh: wind850.length ? Math.max(...wind850) : null,
    });
  }

  const hasF72 = steps.includes(72);
  const hasF180 = steps.includes(180);
  const first = points[0] || {};
  const payload = {
    schema: "gfs-watch.forecast.v1",
    model: "ncep_gfs_global",
    forecast_source: "meteopt",
    run_id_utc: utcIso(candidate.cycle),
    published_at_utc: utcIso(now),
    location: LOCATION,
    sources: {
      forecast: "MeteoPT GFS point forecast (Istanbul, TR)",
      forecast_url: candidate.url,
    },
    f72: {
      available: hasF72,
      forecast_hour: 72,
      source: "MeteoPT",
    },
    f180: {
      available: hasF180,
      forecast_hour: 180,
      source: "MeteoPT",
    },
    noaa_source_file: {
      f72_available: hasF72,
      f72_source_name: hasF72 ? "MeteoPT" : null,
      f180_available: hasF180,
      f180_source_name: hasF180 ? "MeteoPT" : null,
      f180_source_url: API_BASE,
    },
    current_conditions: {
      temperature_2m_c: first.temperature_2m_c ?? null,
      precipitation_mm: first.precipitation_6h_mm ?? null,
      wind_speed_10m_kmh: first.wind_speed_10m_kmh ?? null,
      mean_sea_level_pressure_hpa: null,
    },
    daily_summary: daily,
    forecast_6_hourly: points,
    forecast_horizon_hours: Math.max(...steps),
    forecast_valid_until_utc: points.length ? points[points.length - 1].valid_time_utc : null,
  };
  return { payload, hasF72, hasF180, stepCount: steps.length };
}

async function getCurrent(env, key) {
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

async function writeCurrent(env, key, payload) {
  const updatedAt = new Date().toISOString();
  await env.GFS_DB.prepare(
    "INSERT INTO gfs_current (key, run_id_utc, payload_json, updated_at_utc) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET run_id_utc=excluded.run_id_utc, " +
    "payload_json=excluded.payload_json, updated_at_utc=excluded.updated_at_utc"
  ).bind(key, payload.run_id_utc, JSON.stringify(payload), updatedAt).run();
}

async function archiveRun(env, payload) {
  const storedAt = new Date().toISOString();
  const result = await env.GFS_DB.prepare(
    "INSERT OR IGNORE INTO gfs_runs (run_id_utc, payload_json, published_at_utc, stored_at_utc) VALUES (?, ?, ?, ?)"
  ).bind(payload.run_id_utc, JSON.stringify(payload), payload.published_at_utc, storedAt).run();
  return Number(result.meta?.changes || 0) > 0;
}

async function listRuns(env, limit = 4) {
  const result = await env.GFS_DB.prepare(
    "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT ?"
  ).bind(limit).all();
  return (result.results || []).map(row => JSON.parse(row.payload_json));
}

async function enqueueReportDispatch(env, runId, createdAt) {
  await env.GFS_DB.prepare(
    "INSERT OR IGNORE INTO gfs_report_dispatch_queue (run_id_utc, status, attempts, created_at_utc) " +
    "VALUES (?, 'pending', 0, ?)"
  ).bind(runId, createdAt).run();
}

async function dispatchQueuedReports(env) {
  const result = await env.GFS_DB.prepare(
    "SELECT run_id_utc, attempts FROM gfs_report_dispatch_queue " +
    "WHERE status = 'pending' AND attempts < 5 ORDER BY run_id_utc ASC LIMIT 1"
  ).all();
  const jobs = result.results || [];
  if (!jobs.length) return { queued: 0, dispatched: 0, failed: 0 };
  if (!env.GFS_DISPATCH_TOKEN) {
    console.error(JSON.stringify({
      event: "gfs_report_dispatch_secret_missing",
      queued: jobs.length,
    }));
    return { queued: jobs.length, dispatched: 0, failed: jobs.length };
  }

  let dispatched = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const response = await fetch(
        "https://api.github.com/repos/mhsnlsy/gfs-watch/actions/workflows/istanbul-gfs-10min.yml/dispatches",
        {
          method: "POST",
          headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + env.GFS_DISPATCH_TOKEN,
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "gfs-watch-istanbul-gfs-worker",
          },
          body: JSON.stringify({
            ref: "main",
            inputs: { run_id: job.run_id_utc },
          }),
          signal: AbortSignal.timeout(12000),
        },
      );
      if (!response.ok) {
        throw new Error("GitHub workflow dispatch HTTP " + response.status);
      }

      const dispatchedAt = new Date().toISOString();
      await env.GFS_DB.prepare(
        "UPDATE gfs_report_dispatch_queue " +
        "SET status = 'dispatched', attempts = attempts + 1, dispatched_at_utc = ?, last_error = NULL " +
        "WHERE run_id_utc = ? AND status = 'pending'"
      ).bind(dispatchedAt, job.run_id_utc).run();
      dispatched += 1;
      console.log(JSON.stringify({
        event: "gfs_report_dispatch_accepted",
        run_id_utc: job.run_id_utc,
        dispatched_at_utc: dispatchedAt,
      }));
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      await env.GFS_DB.prepare(
        "UPDATE gfs_report_dispatch_queue " +
        "SET attempts = attempts + 1, last_error = ? " +
        "WHERE run_id_utc = ? AND status = 'pending'"
      ).bind(message, job.run_id_utc).run();
      failed += 1;
      console.error(JSON.stringify({
        event: "gfs_report_dispatch_retry",
        run_id_utc: job.run_id_utc,
        message,
      }));
    }
  }

  const remaining = await env.GFS_DB.prepare(
    "SELECT COUNT(*) AS count FROM gfs_report_dispatch_queue WHERE status = 'pending'"
  ).first();
  return {
    queued: jobs.length,
    dispatched,
    failed,
    pending: Number(remaining?.count || 0),
  };
}

async function collect(env) {
  const started = new Date();
  const settled = await Promise.allSettled(CYCLES.map(hour => fetchCycle(hour)));
  const candidates = [];
  const warnings = [];
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index];
    if (outcome.status === "fulfilled") candidates.push(outcome.value);
    else warnings.push({
      requested_hour: CYCLES[index],
      message: String(outcome.reason?.message || outcome.reason),
    });
  }

  candidates.sort((a, b) => b.cycle.getTime() - a.cycle.getTime());
  const normalized = [];
  for (const candidate of candidates) {
    try {
      normalized.push({
        candidate,
        result: normalize(candidate, started),
      });
    } catch (error) {
      warnings.push({
        requested_hour: candidate.requestedHour,
        message: String(error?.message || error),
      });
    }
  }

  if (!normalized.length) throw new Error("No usable Istanbul GFS cycle from MeteoPT");

  let archived = 0;
  let f72Updated = false;
  for (const entry of normalized) {
    const { payload } = entry.result;
    if (entry.result.hasF72) {
      const currentF72 = await getCurrent(env, "f72");
      if (!currentF72 || Date.parse(payload.run_id_utc) > Date.parse(currentF72.run_id_utc)) {
        const f72 = {
          ...payload,
          milestone: "F72",
          forecast_horizon_hours: Math.min(72, payload.forecast_horizon_hours),
          forecast_6_hourly: payload.forecast_6_hourly.filter(point => point.forecast_hour <= 72),
        };
        await writeCurrent(env, "f72", f72);
        f72Updated = true;
      }
    }
    if (entry.result.hasF180 && await archiveRun(env, payload)) {
      archived += 1;
      await enqueueReportDispatch(env, payload.run_id_utc, started.toISOString());
    }
  }

  const latestRuns = await listRuns(env, 1);
  if (latestRuns[0]) {
    const current = await getCurrent(env, "latest");
    if (!current || Date.parse(latestRuns[0].run_id_utc) >= Date.parse(current.run_id_utc)) {
      await writeCurrent(env, "latest", latestRuns[0]);
    }
  }

  await env.GFS_DB.prepare(
    "DELETE FROM gfs_runs WHERE run_id_utc < ?"
  ).bind(new Date(started.getTime() - RETENTION_DAYS * 86400000).toISOString()).run();

  await env.GFS_DB.prepare(
    "DELETE FROM gfs_report_dispatch_queue WHERE status = 'dispatched' AND dispatched_at_utc < ?"
  ).bind(new Date(started.getTime() - 30 * 86400000).toISOString()).run();

  const reportDispatch = await dispatchQueuedReports(env);
  const runs = await listRuns(env, 4);
  const latest = runs[0] || null;
  const result = {
    ok: Boolean(latest),
    run_id_utc: latest?.run_id_utc || null,
    fetched_cycles: candidates.length,
    archived_runs_changed: archived,
    archived_runs: runs.length,
    report_dispatch: reportDispatch,
    f72_updated: f72Updated,
    f180_ready: normalized.some(item => item.result.hasF180),
    warnings,
    checked_at_utc: started.toISOString(),
  };
  console.log(JSON.stringify({ event: "istanbul_gfs_collect", ...result }));
  return result;
}

async function latestPayload(env, bootstrap = true) {
  let current = await getCurrent(env, "latest");
  if (!current && bootstrap) {
    await collect(env);
    current = await getCurrent(env, "latest");
  }
  if (!current) return null;
  const runs = await listRuns(env, 4);
  return {
    ...current.payload,
    comparison_runs: runs,
  };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") return json({ ok: true });
  if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  if (path === "/api/health") {
    try {
      const current = await getCurrent(env, "latest");
      const count = await env.GFS_DB.prepare("SELECT COUNT(*) AS count FROM gfs_runs").first();
      const pendingDispatch = await env.GFS_DB.prepare(
        "SELECT COUNT(*) AS count FROM gfs_report_dispatch_queue WHERE status = 'pending'"
      ).first();
      return json({
        ok: true,
        service: "gfs-watch-istanbul-gfs",
        storage: "D1",
        cron: "*/10 * * * *",
        latest_run_id_utc: current?.run_id_utc || null,
        latest_updated_at_utc: current?.updated_at_utc || null,
        archived_runs: Number(count?.count || 0),
        report_dispatch_configured: Boolean(env.GFS_DISPATCH_TOKEN),
        pending_report_dispatches: Number(pendingDispatch?.count || 0),
        location: LOCATION,
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/gfs/latest" || path === "/api/latest") {
    try {
      const latest = await latestPayload(env);
      if (!latest) return json({ ok: false, error: "No F180-ready Istanbul GFS run is available yet" }, 503);
      return json(latest);
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/gfs/comparison" || path === "/api/comparison") {
    try {
      let runs = await listRuns(env, 4);
      if (runs.length < 4) {
        await collect(env);
        runs = await listRuns(env, 4);
      }
      return json({
        schema: "istanbul-gfs.comparison.v1",
        location: { name: "Istanbul", latitude: LOCATION.latitude, longitude: LOCATION.longitude },
        updated_at_utc: runs[0]?.published_at_utc || null,
        runs,
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  return json({ ok: false, error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    return handleApi(request, env);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      collect(env).catch(error => {
        console.error(JSON.stringify({
          event: "istanbul_gfs_cron_error",
          message: String(error?.message || error),
          scheduled_time: new Date(controller.scheduledTime).toISOString(),
        }));
      })
    );
  },
};
