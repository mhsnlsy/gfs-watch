import { buildIstanbulInteractiveSvg, buildIstanbulReportText } from "./publication.js";
import { METEOPT_ECMWF_API, METEOPT_ECMWF_WEB, METEOPT_GFS_API, METEOPT_SOURCE_POLICY, meteoptSourceMetadata } from "../../shared/meteopt-source.js";
import { loadIstanbulTelegramFont, renderIstanbulPhotoPng } from "./photo.js";
// Istanbul GFS Worker: canonical MeteoPT collector + D1 event dispatcher
const API_BASE = METEOPT_GFS_API;
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
const ECMWF_API_BASE = METEOPT_ECMWF_API;
const ECMWF_SOURCE_URL = METEOPT_ECMWF_WEB + "?lat=41.0901&lon=28.9436";
const ECMWF_LOCATION = {
  name: "Istanbul",
  latitude: 41.0901,
  longitude: 28.9436,
};
const ECMWF_SCHEMA = "gfs-watch.ecmwf-eps.v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
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
    signal: AbortSignal.timeout(45000),
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
    rh2m: "humidity_2m_percent",
    snlevel: "snowln",
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
    const humidity = values("humidity_2m_percent");
    const temp850 = values("temperature_850hpa_c");
    const rain = values("precipitation_6h_mm");
    const wind = values("wind_speed_10m_kmh");
    const wind850 = values("wind_speed_850hpa_kmh");
    const windPeak = dayPoints
      .filter(point => number(point.wind_speed_10m_kmh) !== null)
      .sort((a, b) => Number(b.wind_speed_10m_kmh) - Number(a.wind_speed_10m_kmh))[0] || null;
    daily.push({
      date_istanbul: day,
      temperature_min_c: temp.length ? Math.min(...temp) : null,
      temperature_max_c: temp.length ? Math.max(...temp) : null,
      humidity_min_percent: humidity.length ? Math.min(...humidity) : null,
      humidity_max_percent: humidity.length ? Math.max(...humidity) : null,
      temperature_850hpa_min_c: temp850.length ? Math.min(...temp850) : null,
      temperature_850hpa_max_c: temp850.length ? Math.max(...temp850) : null,
      precipitation_total_mm: rain.length
        ? rain.reduce((sum, value) => sum + Math.max(0, value), 0)
        : null,
      wind_speed_max_10m_kmh: wind.length ? Math.max(...wind) : null,
      wind_direction_max_10m_deg: windPeak ? windPeak.wind_direction_10m_deg ?? null : null,
      wind_speed_max_850hpa_kmh: wind850.length ? Math.max(...wind850) : null,
    });
  }

  const hasF72 = steps.includes(72);
  const hasF180 = steps.includes(180);
  const first = points[0] || {};
  const payload = {
    schema: "gfs-watch.forecast.v1",
    source_policy: METEOPT_SOURCE_POLICY,
    model: "ncep_gfs_global",
    forecast_source: "meteopt",
    source_policy: METEOPT_SOURCE_POLICY,
    run_id_utc: utcIso(candidate.cycle),
    published_at_utc: utcIso(now),
    location: LOCATION,
    sources: meteoptSourceMetadata({
      forecast: "MeteoPT GFS point forecast (Istanbul, TR)",
      forecast_url: candidate.url,
    }),
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

async function fetchActiveEnkaStationObservation(env) {
  if (!env.STATIONS?.fetch) throw new Error("Active station Service Binding is unavailable");
  const response = await env.STATIONS.fetch("https://internal/api/stations/enka?report=" + Date.now(), {
    headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" }
  });
  if (!response.ok) throw new Error("Active ENKA station panel returned HTTP " + response.status);
  const payload = await response.json();
  if (payload?.ok !== true || !payload?.station) {
    throw new Error("Active ENKA station panel returned no current observation");
  }
  return payload.station;
}

async function processQueuedReports(env) {
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const result = await env.GFS_DB.prepare(
    "SELECT run_id_utc, attempts FROM gfs_report_dispatch_queue " +
    "WHERE attempts < 288 AND (status = 'pending' OR (status = 'processing' AND dispatched_at_utc < ?)) " +
    "ORDER BY run_id_utc DESC LIMIT 1"
  ).bind(staleBefore).all();
  const job = (result.results || [])[0];
  if (!job) return { queued: 0, published: 0, failed: 0 };

  const claimTime = new Date().toISOString();
  const claim = await env.GFS_DB.prepare(
    "UPDATE gfs_report_dispatch_queue SET status = 'processing', attempts = attempts + 1, " +
    "dispatched_at_utc = ?, last_error = NULL WHERE run_id_utc = ? AND " +
    "(status = 'pending' OR (status = 'processing' AND dispatched_at_utc < ?))"
  ).bind(claimTime, job.run_id_utc, staleBefore).run();
  if (Number(claim.meta?.changes || 0) !== 1) {
    return { queued: 1, published: 0, failed: 0, claimed: false };
  }

  try {
    const archive = await env.GFS_DB.prepare(
      "SELECT payload_json FROM gfs_runs WHERE run_id_utc <= ? ORDER BY run_id_utc DESC LIMIT 4"
    ).bind(job.run_id_utc).all();
    const runs = (archive.results || []).map(row => JSON.parse(row.payload_json))
      .sort((a, b) => Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc));
    if (!runs.some(run => run.run_id_utc === job.run_id_utc)) {
      await env.GFS_DB.prepare(
        "UPDATE gfs_report_dispatch_queue SET status = 'pending', attempts = MAX(0, attempts - 1), " +
        "dispatched_at_utc = NULL WHERE run_id_utc = ? AND status = 'processing'"
      ).bind(job.run_id_utc).run();
      console.log(JSON.stringify({
        event: "istanbul_report_waiting_for_archived_cycle",
        run_id_utc: job.run_id_utc,
        available_cycles: runs.length,
      }));
      return { queued: 1, published: 0, failed: 0, waiting_for_archive: true };
    }

    const target = runs[runs.length - 1];
    const chart = buildIstanbulInteractiveSvg(runs);
    let stationObservation = null;
    try {
      stationObservation = await fetchActiveEnkaStationObservation(env);
    } catch (stationError) {
      console.error(JSON.stringify({
        event: "istanbul_report_station_fetch_error",
        run_id_utc: target.run_id_utc,
        message: String(stationError?.message || stationError),
      }));
    }
    const reportText = buildIstanbulReportText(target, new Date(), stationObservation);
    if (!env.ECMWF_ARCHIVE) throw new Error("R2 image archive binding is unavailable");
    const pngAssetKey = "data/" + chart.key.replace(/^notifications\//, "notifications/").replace(/\.svg$/i, "-telegram-home-4panel-v3.png");
    const telegramFont = await loadIstanbulTelegramFont(env.ECMWF_ARCHIVE);
    const pngBytes = await renderIstanbulPhotoPng(chart.body, telegramFont);
    await env.ECMWF_ARCHIVE.put(pngAssetKey, pngBytes, {
      httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=3600" },
    });
    const now = new Date().toISOString();
    const imagePath = chart.key.slice("notifications/".length);
    const images = [{
      label: runs.length + " GFS döngüsü · aynı geçerlilik saatleri (TSİ)",
      path: imagePath,
    }];

    await putPublicationAsset(env, {
      key: chart.key,
      run_id_utc: chart.run_id_utc,
      content_type: "image/svg+xml; charset=utf-8",
      encoding: "utf8",
      body: chart.body,
    });

    const existingLatest = await getPublicationAsset(env, "notifications/latest.json");
    let shouldUpdateLatest = true;
    let previousItems = [];
    if (existingLatest?.body) {
      try {
        const existing = JSON.parse(existingLatest.body);
        if (existing.run_id_utc && Date.parse(existing.run_id_utc) > Date.parse(target.run_id_utc)) {
          shouldUpdateLatest = false;
        }
        if (Array.isArray(existing.items)) previousItems = existing.items;
        else if (existing.run_id_utc && existing.report_text) {
          previousItems = [{
            id: existing.run_id_utc,
            run_id_utc: existing.run_id_utc,
            published_at_utc: existing.published_at_utc || existing.updated_at_utc || existing.run_id_utc,
            title: existing.title || "İstanbul GFS · F180 tamamlandı",
            cycle_label: existing.cycle_label || "MeteoPT GFS",
            report_text: existing.report_text,
            images: Array.isArray(existing.images) ? existing.images : [],
          }];
        }
      } catch (_) {
        // Replace a malformed legacy manifest with a validated native manifest.
      }
    }

    await env.GFS_DB.prepare(
      "INSERT OR IGNORE INTO gfs_report_publications " +
      "(run_id_utc, report_text, svg_asset_key, png_asset_key, status, attempts, created_at_utc, updated_at_utc) " +
      "VALUES (?, ?, ?, ?, 'pending', 0, ?, ?) " +
      "ON CONFLICT(run_id_utc) DO UPDATE SET report_text=excluded.report_text, " +
      "svg_asset_key=excluded.svg_asset_key, png_asset_key=excluded.png_asset_key, " +
      "updated_at_utc=excluded.updated_at_utc WHERE gfs_report_publications.status <> 'sent'"
    ).bind(target.run_id_utc, reportText, chart.key, pngAssetKey, now, now).run();

    const currentItem = {
      id: target.run_id_utc,
      run_id_utc: target.run_id_utc,
      published_at_utc: now,
      title: "İstanbul GFS · F180 tamamlandı",
      cycle_label: "MeteoPT GFS",
      report_text: reportText,
      images,
    };
    const uniqueItems = new Map();
    for (const item of previousItems) {
      const runId = String(item?.run_id_utc || item?.id || "");
      if (runId && Number.isFinite(Date.parse(runId))) uniqueItems.set(runId, item);
    }
    uniqueItems.set(target.run_id_utc, currentItem);
    const retainedItems = [...uniqueItems.values()]
      .sort((a, b) => Date.parse(b.run_id_utc || b.id) - Date.parse(a.run_id_utc || a.id))
      .slice(0, 4);

    const manifest = {
      schema: "gfs-watch.notifications.v1",
      updated_at_utc: now,
      run_id_utc: retainedItems[0]?.run_id_utc || target.run_id_utc,
      published_at_utc: retainedItems[0]?.published_at_utc || now,
      title: retainedItems[0]?.title || "İstanbul GFS · F180 tamamlandı",
      cycle_label: retainedItems[0]?.cycle_label || "MeteoPT GFS",
      report_text: retainedItems[0]?.report_text || reportText,
      images: retainedItems[0]?.images || images,
      items: retainedItems,
    };
    if (shouldUpdateLatest) {
      await putPublicationAsset(env, {
        key: "notifications/latest.json",
        run_id_utc: target.run_id_utc,
        content_type: "application/json; charset=utf-8",
        encoding: "utf8",
        body: JSON.stringify(manifest),
      });
    }

    await env.GFS_DB.prepare(
      "UPDATE gfs_report_dispatch_queue SET status = 'published', dispatched_at_utc = ?, " +
      "last_error = NULL WHERE run_id_utc = ? AND status = 'processing'"
    ).bind(now, job.run_id_utc).run();

    console.log(JSON.stringify({
      event: "istanbul_report_published_in_cloudflare",
      run_id_utc: target.run_id_utc,
      svg_asset_key: chart.key,
      common_valid_time_count: chart.common_valid_time_count,
      latest_manifest_updated: shouldUpdateLatest,
    }));
    return {
      queued: 1,
      published: 1,
      failed: 0,
      run_id_utc: target.run_id_utc,
      common_valid_time_count: chart.common_valid_time_count,
    };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    await env.GFS_DB.prepare(
      "UPDATE gfs_report_dispatch_queue SET status = 'pending', dispatched_at_utc = NULL, last_error = ? " +
      "WHERE run_id_utc = ? AND status = 'processing'"
    ).bind(message, job.run_id_utc).run();
    console.error(JSON.stringify({
      event: "istanbul_native_report_retry",
      run_id_utc: job.run_id_utc,
      message,
    }));
    return { queued: 1, published: 0, failed: 1, error: message };
  }
}

async function telegramApi(env, method, body, isForm = false) {
  const token = env.TELEGRAM_TOKEN;
  const url = "https://api.telegram.org/bot" + token + "/" + method;
  const response = await fetch(url, {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    throw new Error("Telegram " + method + " failed: HTTP " + response.status + " " +
      String(payload.description || "unknown error").slice(0, 300));
  }
  return payload.result || {};
}

async function deliverPendingTelegram(env) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { configured: false, delivered: 0, waiting: true };
  }
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const leaseUntil = new Date(nowDate.getTime() + 5 * 60 * 1000).toISOString();
  const result = await env.GFS_DB.prepare(
    "SELECT run_id_utc, report_text, svg_asset_key, png_asset_key, status, attempts, " +
    "text_message_id, photo_message_id FROM gfs_report_publications " +
    "WHERE attempts < 288 AND (status IN ('pending', 'partial') OR " +
    "(status = 'sending' AND lease_until_utc < ?)) " +
    "ORDER BY created_at_utc ASC LIMIT 1"
  ).bind(now).all();
  const publication = (result.results || [])[0];
  if (!publication) return { configured: true, delivered: 0 };

  const claimed = await env.GFS_DB.prepare(
    "UPDATE gfs_report_publications SET status = 'sending', attempts = attempts + 1, " +
    "lease_until_utc = ?, updated_at_utc = ? WHERE run_id_utc = ? AND attempts < 288 AND " +
    "(status IN ('pending', 'partial') OR (status = 'sending' AND lease_until_utc < ?))"
  ).bind(leaseUntil, now, publication.run_id_utc, now).run();
  if (Number(claimed.meta?.changes || 0) !== 1) {
    return { configured: true, delivered: 0, claimed: false };
  }

  try {
    if (!publication.text_message_id) {
      const message = await telegramApi(env, "sendMessage", {
        chat_id: env.TELEGRAM_CHAT_ID,
        text: publication.report_text,
        disable_web_page_preview: true,
      });
      publication.text_message_id = String(message.message_id);
      await env.GFS_DB.prepare(
        "UPDATE gfs_report_publications SET text_message_id = ?, updated_at_utc = ? " +
        "WHERE run_id_utc = ? AND status = 'sending'"
      ).bind(publication.text_message_id, new Date().toISOString(), publication.run_id_utc).run();
    }

    if (!publication.photo_message_id) {
      const svgKey = String(publication.svg_asset_key || "");
      const pngKey = svgKey
        ? "data/" + svgKey.replace(/^notifications\//, "notifications/").replace(/\.svg$/i, "-telegram-home-4panel-v3.png")
        : publication.png_asset_key;
      let object = pngKey ? await env.ECMWF_ARCHIVE.get(pngKey) : null;
      let pngBytes;
      if (object) {
        pngBytes = new Uint8Array(await object.arrayBuffer());
      } else {
        const asset = await getPublicationAsset(env, publication.svg_asset_key);
        if (!asset || typeof asset.body !== "string") {
          throw new Error("Published SVG asset is missing from D1: " + publication.svg_asset_key);
        }
        const telegramFont = await loadIstanbulTelegramFont(env.ECMWF_ARCHIVE);
        pngBytes = await renderIstanbulPhotoPng(asset.body, telegramFont);
        await env.ECMWF_ARCHIVE.put(pngKey, pngBytes, {
          httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=3600" },
        });
        await env.GFS_DB.prepare(
          "UPDATE gfs_report_publications SET png_asset_key = ?, updated_at_utc = ? " +
          "WHERE run_id_utc = ? AND status = 'sending'"
        ).bind(pngKey, new Date().toISOString(), publication.run_id_utc).run();
      }
      const filename = (pngKey.split("/").pop() || "istanbul-gfs-comparison-telegram-home-4panel-v3.png").replace(/\.svg$/i, ".png");
      const form = new FormData();
      form.set("chat_id", env.TELEGRAM_CHAT_ID);
      form.set("caption", "📊 İstanbul GFS · dört döngülü geçerlilik saati karşılaştırması");
      form.set("photo", new Blob([pngBytes], { type: "image/png" }), filename);
      const message = await telegramApi(env, "sendPhoto", form, true);
      publication.photo_message_id = String(message.message_id);
      await env.GFS_DB.prepare(
        "UPDATE gfs_report_publications SET photo_message_id = ?, updated_at_utc = ? " +
        "WHERE run_id_utc = ? AND status = 'sending'"
      ).bind(publication.photo_message_id, new Date().toISOString(), publication.run_id_utc).run();
    }

    const sentAt = new Date().toISOString();
    await env.GFS_DB.prepare(
      "UPDATE gfs_report_publications SET photo_message_id = ?, status = 'sent', " +
      "lease_until_utc = NULL, updated_at_utc = ?, sent_at_utc = ?, last_error = NULL " +
      "WHERE run_id_utc = ? AND status = 'sending'"
    ).bind(publication.photo_message_id, sentAt, sentAt, publication.run_id_utc).run();
    await env.GFS_DB.prepare(
      "UPDATE gfs_report_dispatch_queue SET status = 'completed', dispatched_at_utc = ?, last_error = NULL " +
      "WHERE run_id_utc = ?"
    ).bind(sentAt, publication.run_id_utc).run();

    console.log(JSON.stringify({
      event: "istanbul_telegram_report_delivered",
      run_id_utc: publication.run_id_utc,
      text_message_id: publication.text_message_id,
      photo_message_id: publication.photo_message_id,
    }));
    return { configured: true, delivered: 1, run_id_utc: publication.run_id_utc };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    await env.GFS_DB.prepare(
      "UPDATE gfs_report_publications SET status = ?, lease_until_utc = NULL, " +
      "updated_at_utc = ?, last_error = ? WHERE run_id_utc = ? AND status = 'sending'"
    ).bind(publication.text_message_id ? "partial" : "pending", new Date().toISOString(),
      message, publication.run_id_utc).run();
    console.error(JSON.stringify({
      event: "istanbul_telegram_delivery_retry",
      run_id_utc: publication.run_id_utc,
      message,
    }));
    return { configured: true, delivered: 0, failed: 1, error: message };
  }
}

function ecmwfRunCandidate(now = new Date()) {
  const hour = now.getUTCHours() >= 12 ? 12 : 0;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour));
}

function ecmwfNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ecmwfSeries(document, name) {
  const values = document?.data?.[name]?.values;
  return Array.isArray(values) ? values : [];
}

async function fetchEcmwfDocument(runDt) {
  const url = new URL(ECMWF_API_BASE);
  url.searchParams.set("lat", ECMWF_LOCATION.latitude.toFixed(4));
  url.searchParams.set("lon", ECMWF_LOCATION.longitude.toFixed(4));
  url.searchParams.set("date", runDt.toISOString().slice(0, 10).replaceAll("-", ""));
  url.searchParams.set("run", String(runDt.getUTCHours()).padStart(2, "0"));
  url.searchParams.set("lang", "en");
  const response = await fetch(url.toString(), {
    headers: { "User-Agent": "GFS-Watch-Istanbul-Cloudflare/1.0", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("MeteoPT ECMWF HTTP " + response.status);
  const raw = await response.json();
  const expected = runDt.toISOString().slice(0, 13).replace(/[-:T]/g, "");
  if (String(raw?.run || "") !== expected) {
    throw new Error("MeteoPT ECMWF returned run " + String(raw?.run || "empty") + ", expected " + expected);
  }
  const steps = (raw?.steps?.values || [])
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0 && value % 3 === 0);
  const temperature = ecmwfSeries(raw, "tmp2m");
  const temperature850 = ecmwfSeries(raw, "tmp850mb");
  const wind = ecmwfSeries(raw, "wind10m");
  const windDirection = ecmwfSeries(raw, "wind10mdir");
  const wind850 = ecmwfSeries(raw, "wind850");
  const rain = ecmwfSeries(raw, "apcp");
  const pressure = ecmwfSeries(raw, "prmsl");
  const forecasts = [];
  let previousHour = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const values = {
      temperature: ecmwfNumber(temperature[i]),
      temperature850: ecmwfNumber(temperature850[i]),
      wind: ecmwfNumber(wind[i]),
      windDirection: ecmwfNumber(windDirection[i]),
      wind850: ecmwfNumber(wind850[i]),
      rain: ecmwfNumber(rain[i]),
      pressure: ecmwfNumber(pressure[i]),
    };
    if (Object.values(values).some(value => value === null)) continue;
    const valid = new Date(runDt.getTime() + steps[i] * 3600000);
    const local = new Date(valid.getTime() + UTC_OFFSET_MS);
    forecasts.push({
      forecast_hour: steps[i],
      valid_time_utc: valid.toISOString().replace(".000Z", "+00:00"),
      valid_time_istanbul: local.toISOString().slice(0, 16) + "+03:00",
      temperature_2m_c: Math.round(values.temperature * 100) / 100,
      temperature_2m_stddev_c: null,
      wind_speed_10m_kmh: Math.round(Math.max(0, values.wind) * 100) / 100,
      wind_direction_10m_deg: Math.round(((values.windDirection % 360) + 360) % 360),
      wind_speed_10m_stddev_kmh: null,
      precipitation_interval_mm: Math.round(Math.max(0, values.rain) * 1000) / 1000,
      precipitation_interval_stddev_mm: null,
      precipitation_accumulated_mm: null,
      temperature_850hpa: { mean_c: Math.round(values.temperature850 * 100) / 100, stddev_c: null },
      wind_850hpa: { mean_kmh: Math.round(Math.max(0, values.wind850) * 100) / 100, stddev_kmh: null },
      mslp: { mean_hpa: Math.round(values.pressure * 10) / 10, stddev_hpa: null },
      precipitation_interval_hours: steps[i] - previousHour,
    });
    previousHour = steps[i];
  }
  if (forecasts.length < 8) throw new Error("MeteoPT ECMWF usable forecast is too short: " + forecasts.length);
  const daily = {};
  for (const item of forecasts) {
    const date = item.valid_time_istanbul.slice(0, 10);
    daily[date] ||= { t: [], p: [], w: [], w850: [] };
    daily[date].t.push(item.temperature_2m_c);
    daily[date].p.push(item.precipitation_interval_mm);
    daily[date].w.push(item.wind_speed_10m_kmh);
    daily[date].w850.push(item.wind_850hpa.mean_kmh);
  }
  const dailySummary = Object.entries(daily).map(([date, d]) => ({
    date_istanbul: date,
    temperature_min_c: Math.round(Math.min(...d.t) * 10) / 10,
    temperature_max_c: Math.round(Math.max(...d.t) * 10) / 10,
    precipitation_total_mm: Math.round(d.p.reduce((a, b) => a + b, 0) * 10) / 10,
    wind_speed_max_10m_kmh: Math.round(Math.max(...d.w) * 10) / 10,
    wind_speed_max_850hpa_kmh: Math.round(Math.max(...d.w850) * 10) / 10,
  }));
  const timeline = forecasts.map(item => ({
    forecast_hour: item.forecast_hour,
    valid_time_utc: item.valid_time_utc,
    valid_time_istanbul: item.valid_time_istanbul,
    temperature_2m_c: item.temperature_2m_c,
    temperature_850hpa_c: item.temperature_850hpa.mean_c,
    wind_speed_10m_kmh: item.wind_speed_10m_kmh,
    wind_direction_10m_deg: item.wind_direction_10m_deg,
    wind_speed_850hpa_kmh: item.wind_850hpa.mean_kmh,
    precipitation_6h_mm: item.precipitation_interval_mm,
    precipitation_interval_hours: item.precipitation_interval_hours,
  }));
  const first = forecasts[0];
  return {
    schema: ECMWF_SCHEMA,
    status: "ready",
    forecast_source: "meteopt",
    model: "ECMWF via MeteoPT",
    product: "MeteoPT ECMWF 3-hour point",
    surface_forecast_source: "MeteoPT ECMWF point",
    ensemble_forecast_source: "MeteoPT ECMWF point",
    surface_ensemble_spread_available: false,
    resolution: "MeteoPT nokta",
    forecast_horizon_hours: forecasts[forecasts.length - 1].forecast_hour,
    run_id_utc: runDt.toISOString().replace(".000Z", "+00:00"),
    updated_at_utc: new Date().toISOString(),
    forecast_valid_until_utc: forecasts[forecasts.length - 1].valid_time_utc,
    location: { name: raw?.geodata?.place || "İstanbul", latitude: ECMWF_LOCATION.latitude, longitude: ECMWF_LOCATION.longitude, nearest_grid_latitude: ECMWF_LOCATION.latitude, nearest_grid_longitude: ECMWF_LOCATION.longitude },
    units: { temperature_850hpa: "°C", wind_850hpa: "km/sa", mslp: "hPa", spread: "MeteoPT noktasında ensemble sapması yok" },
    attribution: "ECMWF nokta serisi MeteoPT üzerinden alınır.",
    license: "MeteoPT",
    license_url: "https://www.meteopt.com/modelos/ecmwf",
    source_url: ECMWF_SOURCE_URL,
    notes: ["Sıcaklık, rüzgâr, yağış, 850 hPa ve basınç aynı MeteoPT ECMWF noktasından gelir.", "Seri 3 saatte bir. Ensemble sapması ve bölgesel basınç merkezi bu kaynakta yok."],
    forecasts,
    daily_summary: dailySummary,
    forecast_6_hourly: timeline,
    current_conditions: {
      temperature_2m_c: first.temperature_2m_c,
      wind_speed_10m_kmh: first.wind_speed_10m_kmh,
      precipitation_mm: first.precipitation_interval_mm,
      mean_sea_level_pressure_hpa: first.mslp.mean_hpa,
    },
    regional_pressure_analysis: {
      valid_time_utc: first.valid_time_utc,
      diameter_km: null,
      findings: ["İstanbul deniz seviyesi basıncı " + first.mslp.mean_hpa.toFixed(1) + " hPa. MeteoPT ECMWF noktası; bölgesel basınç merkezi bu kaynakta yok."],
    },
  };
}

async function collectEcmwf(env) {
  const runDt = ecmwfRunCandidate();
  const runId = runDt.toISOString().replace(".000Z", "+00:00");
  const current = await env.GFS_DB.prepare("SELECT run_id_utc, payload_json FROM ecmwf_current WHERE key = 'latest'").first();
  if (current && current.run_id_utc === runId) {
    return { updated: false, run_id_utc: runId, source: "meteopt" };
  }
  const payload = await fetchEcmwfDocument(runDt);
  await env.GFS_DB.prepare(
    "INSERT INTO ecmwf_runs (run_id_utc, payload_json, published_at_utc, stored_at_utc) VALUES (?, ?, ?, ?) ON CONFLICT(run_id_utc) DO UPDATE SET payload_json=excluded.payload_json, published_at_utc=excluded.published_at_utc, stored_at_utc=excluded.stored_at_utc"
  ).bind(runId, JSON.stringify(payload), runId, new Date().toISOString()).run();
  await env.GFS_DB.prepare(
    "INSERT INTO ecmwf_current (key, run_id_utc, payload_json, updated_at_utc) VALUES ('latest', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET run_id_utc=excluded.run_id_utc, payload_json=excluded.payload_json, updated_at_utc=excluded.updated_at_utc"
  ).bind(runId, JSON.stringify(payload), new Date().toISOString()).run();
  if (env.ECMWF_ARCHIVE) {
    await env.ECMWF_ARCHIVE.put("data/ecmwf/latest.json", JSON.stringify(payload));
    await env.ECMWF_ARCHIVE.put("data/ecmwf/" + runId.replaceAll(":", "").replaceAll("+", "") + ".json", JSON.stringify(payload));
  }
  return { updated: true, run_id_utc: runId, source: "meteopt", forecast_horizon_hours: payload.forecast_horizon_hours };
}

async function collectData(env) {
  const started = new Date();
  let ecmwf = null;
  try { ecmwf = await collectEcmwf(env); } catch (error) { ecmwf = { updated: false, error: String(error?.message || error), source: "meteopt" }; console.error(JSON.stringify({ event: "ecmwf_collect_error", ...ecmwf })); }
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
      const sameRunNeedsTableFields = currentF72?.run_id_utc === payload.run_id_utc &&
        (currentF72.payload?.forecast_6_hourly || []).some(point =>
          Number(point.forecast_hour) > 0 &&
          Number(point.forecast_hour) <= 72 &&
          Number(point.forecast_hour) % 3 === 0 &&
          (point.humidity_2m_percent === null || point.humidity_2m_percent === undefined ||
           point.snowln === null || point.snowln === undefined)
        );
      if (!currentF72 ||
          Date.parse(payload.run_id_utc) > Date.parse(currentF72.run_id_utc) ||
          sameRunNeedsTableFields) {
        const f72Points = payload.forecast_6_hourly.filter(point => point.forecast_hour > 0 && point.forecast_hour <= 72);
        const f72 = {
          ...payload,
          milestone: "F72",
          f72: { ...payload.f72, available: true, forecast_hour: 72 },
          forecast_horizon_hours: Math.min(72, payload.forecast_horizon_hours),
          forecast_6_hourly: f72Points,
          forecast_valid_until_utc: f72Points[f72Points.length - 1]?.valid_time_utc || payload.forecast_valid_until_utc,
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

  // Keep the public latest feed alive from the newest successfully normalized
  // MeteoPT cycle, even before F180 is reached. F180 is required for archiving
  // and report generation, but it must not be allowed to blank the homepage
  // during the hours when only F72/F153/etc. is available.
  const newestNormalized = normalized
    .map(entry => entry.result.payload)
    .sort((a, b) => Date.parse(b.run_id_utc) - Date.parse(a.run_id_utc))[0] || null;
  if (newestNormalized) {
    const current = await getCurrent(env, "latest");
    if (!current || Date.parse(newestNormalized.run_id_utc) >= Date.parse(current.run_id_utc)) {
      await writeCurrent(env, "latest", newestNormalized);
    }
  }

  await env.GFS_DB.prepare(
    "DELETE FROM gfs_runs WHERE run_id_utc < ?"
  ).bind(new Date(started.getTime() - RETENTION_DAYS * 86400000).toISOString()).run();

  await env.GFS_DB.prepare(
    "DELETE FROM gfs_report_dispatch_queue WHERE status IN ('dispatched', 'completed') AND dispatched_at_utc < ?"
  ).bind(new Date(started.getTime() - 30 * 86400000).toISOString()).run();
  await env.GFS_DB.prepare(
    "DELETE FROM gfs_report_publications WHERE run_id_utc < ? AND status = 'sent'"
  ).bind(new Date(started.getTime() - 90 * 86400000).toISOString()).run();

  const reportDispatch = await processQueuedReports(env);
  const telegramDelivery = await deliverPendingTelegram(env);
  const runs = await listRuns(env, 4);
  const latest = runs[0] || null;
  const result = {
    ok: Boolean(latest),
    run_id_utc: latest?.run_id_utc || null,
    fetched_cycles: candidates.length,
    archived_runs_changed: archived,
    archived_runs: runs.length,
    report_dispatch: reportDispatch,
    telegram_delivery: telegramDelivery,
    f72_updated: f72Updated,
    f180_ready: normalized.some(item => item.result.hasF180),
    ecmwf,
    warnings,
    checked_at_utc: started.toISOString(),
  };
  console.log(JSON.stringify({ event: "istanbul_gfs_collect", ...result }));
  return result;
}

async function collect(env, trigger = "unknown") {
  const startedAt = new Date().toISOString();
  await env.GFS_DB.prepare(
    "INSERT INTO gfs_worker_heartbeat (singleton, last_started_at_utc, updated_at_utc) VALUES (1, ?, ?) " +
    "ON CONFLICT(singleton) DO UPDATE SET last_started_at_utc=excluded.last_started_at_utc, updated_at_utc=excluded.updated_at_utc"
  ).bind(startedAt, startedAt).run();
  try {
    const result = await collectData(env);
    const successAt = new Date().toISOString();
    await env.GFS_DB.prepare(
      "UPDATE gfs_worker_heartbeat SET last_success_at_utc=?, last_error_at_utc=NULL, last_error=NULL, " +
      "last_run_id_utc=?, last_trigger=?, updated_at_utc=? WHERE singleton=1"
    ).bind(successAt, result.run_id_utc || null, trigger, successAt).run();
    return result;
  } catch (error) {
    const failedAt = new Date().toISOString();
    const message = String(error?.message || error).slice(0, 500);
    await env.GFS_DB.prepare(
      "UPDATE gfs_worker_heartbeat SET last_error_at_utc=?, last_error=?, last_trigger=?, updated_at_utc=? WHERE singleton=1"
    ).bind(failedAt, message, trigger, failedAt).run();
    throw error;
  }
}
async function latestPayload(env, bootstrap = true) {
  let current = await getCurrent(env, "latest");
  // The homepage is a live data consumer. If the autonomous 10-minute Cron
  // has fallen behind, refresh on read instead of serving an hours-old model
  // run. This is intentionally Cloudflare-native and does not depend on GitHub.
  const staleAfterMs = 20 * 60 * 1000;
  const currentAgeMs = current?.updated_at_utc
    ? Date.now() - Date.parse(current.updated_at_utc)
    : Number.POSITIVE_INFINITY;
  if (bootstrap && (!current || !Number.isFinite(currentAgeMs) || currentAgeMs > staleAfterMs)) {
    try {
      await collect(env, "live-read-refresh");
      current = await getCurrent(env, "latest");
    } catch (error) {
      // Keep a known-good current payload available if the upstream source is
      // temporarily unavailable during a page request.
      if (!current) throw error;
      console.error(JSON.stringify({
        event: "istanbul_live_read_refresh_error",
        message: String(error?.message || error),
      }));
    }
  }
  if (!current) return null;
  const runs = await listRuns(env, 4);
  return {
    ...current.payload,
    comparison_runs: runs,
  };
}

async function latestF72Payload(env, bootstrap = true) {
  // F72 is a presentation milestone, not a separate source of truth.
  // Never block the public F72 endpoint on a full MeteoPT collection when a
  // known-good F72 or canonical latest payload is already available. A full
  // collection can take longer than the gateway health-check timeout.
  let current = await getCurrent(env, "f72");

  // Prefer the canonical latest payload immediately when the dedicated F72
  // row is absent. It is already produced by the same collector and can be
  // reduced to the first 72 hours without another upstream request.
  if (!current) {
    const latest = await getCurrent(env, "latest");
    if (latest?.payload) {
      const sourcePoints = Array.isArray(latest.payload.forecast_6_hourly)
        ? latest.payload.forecast_6_hourly
        : [];
      const points = sourcePoints.filter(point => {
        const hour = Number(point?.forecast_hour);
        return Number.isFinite(hour) && hour > 0 && hour <= 72 && hour % 3 === 0;
      });
      if (points.length >= 24) {
        current = {
          run_id_utc: latest.run_id_utc,
          updated_at_utc: latest.updated_at_utc,
          payload: {
            ...latest.payload,
            milestone: "F72-fallback",
            f72: { ...(latest.payload.f72 || {}), available: true, forecast_hour: 72, source: "MeteoPT" },
            forecast_horizon_hours: 72,
            forecast_6_hourly: points,
            forecast_valid_until_utc: points[points.length - 1]?.valid_time_utc || latest.payload.forecast_valid_until_utc,
          },
        };
      }
    }
  }

  // Only attempt an upstream refresh when no usable cached payload exists.
  // This preserves a fast, deterministic public response during a temporary
  // MeteoPT slowdown or when the worker is under load.
  if (!current && bootstrap) {
    try {
      await collect(env, "live-f72-read-refresh");
      current = await getCurrent(env, "f72");
    } catch (error) {
      console.error(JSON.stringify({
        event: "istanbul_live_f72_refresh_error",
        message: String(error?.message || error),
      }));
    }
  }

  // If the refresh created an F72 row, use it. If it did not, retry the
  // canonical latest fallback once so a successful collection can still
  // satisfy the public F72 contract.
  if (!current) {
    const latest = await getCurrent(env, "latest");
    if (latest?.payload) {
      const sourcePoints = Array.isArray(latest.payload.forecast_6_hourly)
        ? latest.payload.forecast_6_hourly
        : [];
      const points = sourcePoints.filter(point => {
        const hour = Number(point?.forecast_hour);
        return Number.isFinite(hour) && hour > 0 && hour <= 72 && hour % 3 === 0;
      });
      if (points.length >= 24) {
        current = {
          run_id_utc: latest.run_id_utc,
          updated_at_utc: latest.updated_at_utc,
          payload: {
            ...latest.payload,
            milestone: "F72-fallback",
            f72: { ...(latest.payload.f72 || {}), available: true, forecast_hour: 72, source: "MeteoPT" },
            forecast_horizon_hours: 72,
            forecast_6_hourly: points,
            forecast_valid_until_utc: points[points.length - 1]?.valid_time_utc || latest.payload.forecast_valid_until_utc,
          },
        };
      }
    }
  }

  // F72 is a presentation milestone, not a separate source of truth. If the
  // dedicated F72 D1 row is temporarily absent, fall back to the canonical
  // latest GFS payload and expose only its first 72 forecast hours.
  if (!current) {
    const latest = await getCurrent(env, "latest");
    if (latest?.payload) {
      const sourcePoints = Array.isArray(latest.payload.forecast_6_hourly)
        ? latest.payload.forecast_6_hourly
        : [];
      const points = sourcePoints.filter(point => {
        const hour = Number(point?.forecast_hour);
        return Number.isFinite(hour) && hour > 0 && hour <= 72 && hour % 3 === 0;
      });
      if (points.length >= 24) {
        current = {
          run_id_utc: latest.run_id_utc,
          updated_at_utc: latest.updated_at_utc,
          payload: {
            ...latest.payload,
            milestone: "F72-fallback",
            f72: { ...(latest.payload.f72 || {}), available: true, forecast_hour: 72, source: "MeteoPT" },
            forecast_horizon_hours: 72,
            forecast_6_hourly: points,
            forecast_valid_until_utc: points[points.length - 1]?.valid_time_utc || latest.payload.forecast_valid_until_utc,
          },
        };
      }
    }
  }

  if (!current) return null;
  const runs = await listRuns(env, 4);
  return {
    ...current.payload,
    comparison_runs: runs,
    f72_updated_at_utc: current.updated_at_utc,
  };
}

async function getPublicationAsset(env, key) {
  const row = await env.GFS_DB.prepare(
    "SELECT asset_key, run_id_utc, content_type, encoding, body, updated_at_utc " +
    "FROM gfs_publication_assets WHERE asset_key = ?"
  ).bind(key).first();
  return row || null;
}

async function putPublicationAsset(env, asset) {
  const now = new Date().toISOString();
  await env.GFS_DB.prepare(
    "INSERT INTO gfs_publication_assets " +
    "(asset_key, run_id_utc, content_type, encoding, body, updated_at_utc) " +
    "VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(asset_key) DO UPDATE SET " +
    "run_id_utc=excluded.run_id_utc, content_type=excluded.content_type, " +
    "encoding=excluded.encoding, body=excluded.body, updated_at_utc=excluded.updated_at_utc"
  ).bind(
    asset.key,
    asset.run_id_utc || null,
    asset.content_type || "application/octet-stream",
    asset.encoding || "utf8",
    asset.body,
    now
  ).run();
}

function decodePublicationAsset(row) {
  let body = row.encoding === "base64"
    ? new TextDecoder().decode(Uint8Array.from(atob(row.body), character => character.charCodeAt(0)))
    : row.body;

  // Live D1 can contain an older SVG generated before the dark report palette.
  // Sanitize only white SVG shape fills at the publication boundary so stale
  // assets cannot reintroduce the two white report boxes.
  if (/\.svg$/i.test(row.asset_key)) {
    body = body
      .replace(/(<(?:rect|path|polygon)\\b[^>]*?)\\sfill=(["'])#(?:fff|ffffff)\\2/gi, "$1 fill=$2#153448$2")
      .replace(/(<(?:rect|path|polygon)\\b[^>]*?style=(["'])[^"']*?)fill\\s*:\\s*#(?:fff|ffffff)/gi, "$1fill: #153448");
  }

  const bytes = new TextEncoder().encode(body);
  const headers = new Headers({
    "Content-Type": row.content_type || "application/octet-stream",
    "Cache-Control": (row.asset_key === "latest.json" || row.asset_key.endsWith("/latest.json") || /\\.(svg|png)$/i.test(row.asset_key))
      ? "no-store, max-age=0, must-revalidate"
      : "public, max-age=3600, s-maxage=86400",
    "Access-Control-Allow-Origin": "*",
    "X-GFS-Publication-Source": "D1"
  });
  if (row.updated_at_utc) headers.set("Last-Modified", row.updated_at_utc);
  return new Response(bytes, { status: 200, headers });
}

async function handlePublicationUpload(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const token = request.headers.get("Authorization") || "";
  if (!env.GFS_DISPATCH_TOKEN || token !== "Bearer " + env.GFS_DISPATCH_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const key = String(payload?.key || "").replace(/^\/+/, "");
  const body = typeof payload?.body === "string" ? payload.body : null;
  const encoding = payload?.encoding === "base64" ? "base64" : "utf8";
  const contentType = String(payload?.content_type || "application/octet-stream");
  const runId = payload?.run_id_utc ? String(payload.run_id_utc) : null;
  if (!key || !body) return json({ ok: false, error: "key and body are required" }, 400);
  if (key.includes("..") || key.startsWith("/")) return json({ ok: false, error: "Invalid asset key" }, 400);
  if (!/^(notifications\/|data\/)[A-Za-z0-9._/-]+$/.test(key)) {
    return json({ ok: false, error: "Unsupported publication asset path" }, 400);
  }
  if (body.length > 1900000) return json({ ok: false, error: "Publication asset exceeds D1 row safety limit" }, 413);

  try {
    await putPublicationAsset(env, { key, body, encoding, content_type: contentType, run_id_utc: runId });
    return json({ ok: true, key, encoding, bytes: body.length });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error) }, 500);
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") return json({ ok: true });

  // The authenticated publisher is the only write route; keep it ahead of the GET-only API guard.
  if (path === "/gfs/publication-upload") {
    return handlePublicationUpload(request, env);
  }
  if (path === "/internal/regenerate-latest-chart") {
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    const token = request.headers.get("Authorization") || "";
    if (!env.GFS_DISPATCH_TOKEN || token !== "Bearer " + env.GFS_DISPATCH_TOKEN) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    try {
      const archive = await env.GFS_DB.prepare(
        "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
      ).all();
      const runs = (archive.results || []).map(row => JSON.parse(row.payload_json))
        .sort((a, b) => Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc));
      if (!runs.length) return json({ ok: false, error: "No archived GFS runs" }, 404);

      const chart = buildIstanbulInteractiveSvg(runs);
      await putPublicationAsset(env, {
        key: chart.key,
        run_id_utc: chart.run_id_utc,
        content_type: "image/svg+xml; charset=utf-8",
        encoding: "utf8",
        body: chart.body,
      });
      return json({
        ok: true,
        run_id_utc: chart.run_id_utc,
        key: chart.key,
        cycles: runs.length,
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }
  if (path === "/internal/reconcile") {
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    const token = request.headers.get("Authorization") || "";
    if (!env.GFS_DISPATCH_TOKEN || token !== "Bearer " + env.GFS_DISPATCH_TOKEN) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    try {
      const result = await collect(env, "authenticated-internal-reconcile");
      return json({ ok: true, result });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }
  if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  if (path.startsWith("/gfs/publication-asset/")) {
    const key = decodeURIComponent(path.slice("/gfs/publication-asset/".length)).replace(/^\/+/, "");
    try {
      const row = await getPublicationAsset(env, key);
      if (!row) return json({ ok: false, error: "Publication asset not found" }, 404);
      return decodePublicationAsset(row);
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/gfs/notification-latest") {
    try {
      const rows = await env.GFS_DB.prepare(
        "SELECT run_id_utc, report_text, svg_asset_key, updated_at_utc " +
        "FROM gfs_report_publications ORDER BY run_id_utc DESC LIMIT 4"
      ).all();
      const publications = Array.isArray(rows?.results) ? rows.results : [];
      if (!publications.length) {
        return json({ ok: false, error: "Notification archive not published" }, 404);
      }
      const items = publications.map(row => ({
        id: row.run_id_utc,
        run_id_utc: row.run_id_utc,
        published_at_utc: row.updated_at_utc || row.run_id_utc,
        title: "İstanbul GFS · F180 tamamlandı",
        cycle_label: "MeteoPT GFS",
        report_text: row.report_text || "",
        images: row.svg_asset_key ? [{
          label: "GFS dört döngü · aynı geçerlilik saatleri (TSİ)",
          path: String(row.svg_asset_key)
            .replace(/^data\/notifications\//, "")
            .replace(/^notifications\//, "")
        }] : []
      }));
      return json({
        schema: "gfs-watch.notifications.v1",
        updated_at_utc: new Date().toISOString(),
        run_id_utc: items[0].run_id_utc,
        published_at_utc: items[0].published_at_utc,
        title: items[0].title,
        cycle_label: items[0].cycle_label,
        report_text: items[0].report_text,
        images: items[0].images,
        items
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/health") {
    try {
      const current = await getCurrent(env, "latest");
      const heartbeat = await env.GFS_DB.prepare("SELECT last_started_at_utc, last_success_at_utc, last_error_at_utc, last_error, last_run_id_utc, last_trigger FROM gfs_worker_heartbeat WHERE singleton = 1").first();
      const ecmwfCurrent = await env.GFS_DB.prepare("SELECT run_id_utc, updated_at_utc FROM ecmwf_current WHERE key = 'latest'").first();
      const count = await env.GFS_DB.prepare("SELECT COUNT(*) AS count FROM gfs_runs").first();
      const pendingDispatch = await env.GFS_DB.prepare(
        "SELECT COUNT(*) AS count FROM gfs_report_dispatch_queue WHERE status IN ('pending', 'processing')"
      ).first();
      const publicationStats = await env.GFS_DB.prepare(
        "SELECT " +
        "SUM(CASE WHEN status IN ('pending', 'partial', 'sending') AND attempts < 288 THEN 1 ELSE 0 END) AS pending, " +
        "SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent, " +
        "SUM(CASE WHEN attempts >= 12 AND status <> 'sent' THEN 1 ELSE 0 END) AS exhausted " +
        "FROM gfs_report_publications"
      ).first();
      const latestPublication = await env.GFS_DB.prepare(
        "SELECT run_id_utc, status, updated_at_utc, last_error " +
        "FROM gfs_report_publications ORDER BY run_id_utc DESC LIMIT 1"
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
        native_report_generation: true,
        telegram_configured: Boolean(env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT_ID),
        station_service_configured: Boolean(env.STATIONS?.fetch),
        photo_archive_configured: Boolean(env.ECMWF_ARCHIVE),
        telegram_photo_mode: "sendPhoto/png",
        internal_reconcile_configured: Boolean(env.GFS_DISPATCH_TOKEN),
        last_cron_started_at_utc: heartbeat?.last_started_at_utc || null,
        last_cron_success_at_utc: heartbeat?.last_success_at_utc || null,
        last_cron_error_at_utc: heartbeat?.last_error_at_utc || null,
        last_cron_error: heartbeat?.last_error || null,
        last_cron_run_id_utc: heartbeat?.last_run_id_utc || null,
        last_cron_trigger: heartbeat?.last_trigger || null,
        pending_report_dispatches: Number(pendingDispatch?.count || 0),
        pending_report_publications: Number(publicationStats?.pending || 0),
        sent_report_publications: Number(publicationStats?.sent || 0),
        exhausted_report_publications: Number(publicationStats?.exhausted || 0),
        latest_report_publication: latestPublication || null,
        publication_assets: Number((await env.GFS_DB.prepare("SELECT COUNT(*) AS count FROM gfs_publication_assets").first())?.count || 0),
        location: LOCATION,
        ecmwf_source: ECMWF_SOURCE_URL,
        ecmwf_latest_run_id_utc: ecmwfCurrent?.run_id_utc || null,
        ecmwf_latest_updated_at_utc: ecmwfCurrent?.updated_at_utc || null,
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/ecmwf/latest" || path === "/api/ecmwf/latest") {
    try {
      let row = await env.GFS_DB.prepare("SELECT payload_json FROM ecmwf_current WHERE key = 'latest'").first();
      if (!row) {
        await collectEcmwf(env);
        row = await env.GFS_DB.prepare("SELECT payload_json FROM ecmwf_current WHERE key = 'latest'").first();
      }
      if (!row) return json({ ok: false, error: "No MeteoPT ECMWF run is available yet" }, 503);
      return json(JSON.parse(row.payload_json));
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }
  if (path === "/ecmwf/comparison" || path === "/api/ecmwf/comparison") {
    try {
      const rows = await env.GFS_DB.prepare("SELECT payload_json FROM ecmwf_runs ORDER BY run_id_utc DESC LIMIT 4").all();
      return json({ schema: "gfs-watch.ecmwf.comparison.v1", source: ECMWF_SOURCE_URL, runs: (rows.results || []).map(row => JSON.parse(row.payload_json)) });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/gfs/f72" || path === "/api/f72") {
    try {
      const latest = await latestF72Payload(env);
      if (!latest) return json({ ok: false, error: "No F72-ready Istanbul GFS run is available yet" }, 503);
      return json(latest);
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
