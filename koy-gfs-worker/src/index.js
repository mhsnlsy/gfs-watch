import { METEOPT_GFS_API, METEOPT_GFS_WEB, METEOPT_SOURCE_POLICY, meteoptSourceMetadata } from "../../shared/meteopt-source.js";
import { buildPanelAxis, formatAxisTick, formatPeakValue, peakUnit, seriesCalloutPlacement } from "../../shared/gfs-chart-axis.js";

const API_BASE = METEOPT_GFS_API;
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
    const value = values?.[index];
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n) !== Infinity ? n : null;
  } catch (_) {
    return null;
  }
}

const SNOWLINE_KEYS = new Set([
  // MeteoPT GFS API names its SnowLn series "snlevel".
  "snlevel", "snowln", "snowline", "snow_line", "snowlevel", "snow_level",
  "snowlineheight", "snow_line_height", "snowlevelheight",
  "snow_level_height", "snowaltitude", "snow_altitude",
  "snowlinealtitude", "snow_line_altitude",
]);

function normalizedFieldName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function valuesFromField(field) {
  if (Array.isArray(field)) return field;
  if (!field || typeof field !== "object") return null;
  if (Array.isArray(field.values)) return field.values;
  if (Array.isArray(field.data)) return field.data;
  if (Array.isArray(field.forecast)) return field.forecast;
  if (Array.isArray(field.series)) return field.series;
  return null;
}

function findSnowlineSeries(document) {
  const queue = [{ value: document, path: "document" }];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    const value = current?.value;
    if (!value || typeof value !== "object" || Array.isArray(value) || visited.has(value)) continue;
    visited.add(value);

    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizedFieldName(key);
      const isSnowlineKey = SNOWLINE_KEYS.has(normalized) ||
        (normalized.includes("snow") && /(line|ln|level|altitude)/.test(normalized));
      if (isSnowlineKey) {
        const values = valuesFromField(child);
        if (values) {
          const hasNumericValue = values.some(item =>
            item !== null && item !== undefined && item !== "" && Number.isFinite(Number(item))
          );
          if (hasNumericValue) return { key: current.path + "." + key, values };
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === "object" && !Array.isArray(child)) {
        queue.push({ value: child, path: current.path + "." + key });
      }
    }
  }

  return { key: null, values: [] };
}

function mergeForecastPoints(previousPoints, incomingPoints) {
  const merged = new Map();
  for (const point of Array.isArray(previousPoints) ? previousPoints : []) {
    const hour = Number(point?.forecast_hour);
    if (Number.isFinite(hour)) merged.set(hour, { ...point });
  }
  for (const point of Array.isArray(incomingPoints) ? incomingPoints : []) {
    const hour = Number(point?.forecast_hour);
    if (!Number.isFinite(hour)) continue;
    const previous = merged.get(hour) || {};
    const next = { ...previous };
    for (const [key, value] of Object.entries(point || {})) {
      if (value !== null && value !== undefined) next[key] = value;
      else if (!(key in next)) next[key] = value;
    }
    merged.set(hour, next);
  }
  return [...merged.values()].sort((a, b) => Number(a.forecast_hour) - Number(b.forecast_hour));
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
  const series = name => valuesFromField(data?.[name]) || [];
  // MeteoPT may expose the snow-line series with a display label or nested
  // field name. Resolve it from the original response instead of guessing.
  const snowlineSeries = findSnowlineSeries(candidate.document);

  const points = [];
  for (let i = 0; i < steps.length; i += 1) {
    const lead = steps[i];
    if (lead <= 0) continue;
    const valid = new Date(cycle.getTime() + lead * 3600000);
    points.push({
      forecast_hour: lead,
      valid_time_utc: valid.toISOString(),
      temperature_2m_c: asNumber(series("tmp2m"), i),
      humidity_2m_percent: asNumber(series("rh2m"), i),
      temperature_850hpa_c: asNumber(series("tmp850mb"), i),
      wind_speed_10m_kmh: asNumber(series("wind10m"), i),
      wind_direction_10m_deg: asNumber(
        (series("wind10mdir").length ? series("wind10mdir") : series("winddir10m")), i
      ),
      wind_speed_850hpa_kmh: asNumber(series("wind850"), i),
      wind_direction_850hpa_deg: asNumber(
        (series("wind850mdir").length ? series("wind850mdir") :
         series("wind850dir").length ? series("wind850dir") :
         series("winddir850")), i
      ),
      precipitation_6h_mm: asNumber(series("apcp"), i),
      // MeteoPT "SnowLn" is the model snow-line altitude in metres.
      snowln: asNumber(snowlineSeries.values, i),
    });
  }

  const base = {
    location: LOCATION,
    source: "MeteoPT GFS",
    source_policy: METEOPT_SOURCE_POLICY,
    sources: meteoptSourceMetadata({
      gfs_source_url: `${METEOPT_GFS_WEB}?lat=${LOCATION.latitude}&lon=${LOCATION.longitude}`,
      gfs_data_endpoint: candidate.url,
    }),
    source_url: `${METEOPT_GFS_WEB}?lat=${LOCATION.latitude}&lon=${LOCATION.longitude}`,
    run_id_utc: cycle.toISOString(),
    published_at_utc: new Date(now).toISOString(),
    forecast_source: "meteopt",
    meteopt_snowln_source_field: snowlineSeries.key,
    wind_direction_enrichment_checked: true,
    wind_direction_numeric_points: points.filter(point =>
      Number.isFinite(Number(point.wind_direction_10m_deg))
    ).length,
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
    "SELECT payload_json FROM gfs_runs WHERE run_id_utc = ?"
  ).bind(full.run_id_utc).first();

  let payload = full;
  if (existing?.payload_json) {
    const previous = JSON.parse(existing.payload_json);
    payload = {
      ...previous,
      ...full,
      forecast_6_hourly: mergeForecastPoints(
        previous.forecast_6_hourly,
        full.forecast_6_hourly
      ),
    };
    const comparable = value => {
      const copy = { ...value };
      delete copy.published_at_utc;
      return JSON.stringify(copy);
    };
    if (comparable(previous) === comparable(payload)) return false;
  }

  const storedAt = new Date().toISOString();
  await env.GFS_DB.prepare(
    "INSERT INTO gfs_runs (run_id_utc, payload_json, published_at_utc, stored_at_utc) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(run_id_utc) DO UPDATE SET payload_json=excluded.payload_json, " +
    "published_at_utc=excluded.published_at_utc, stored_at_utc=excluded.stored_at_utc"
  ).bind(
    full.run_id_utc,
    JSON.stringify(payload),
    payload.published_at_utc,
    storedAt,
  ).run();

  return true;
}

async function persistF72(env, f72) {
  const stored = await currentRun(env, "f72");
  const sameRun = stored?.run_id_utc === f72.run_id_utc;
  let payload = f72;

  if (sameRun) {
    const previousPoints = Array.isArray(stored.payload?.forecast_6_hourly)
      ? stored.payload.forecast_6_hourly
      : [];
    const incomingPoints = Array.isArray(f72.forecast_6_hourly)
      ? f72.forecast_6_hourly
      : [];

    // Merge every same-run refresh, preserving the F180 horizon and filling
    // newly available MeteoPT fields such as snowln even when the point count matches.
    payload = {
      ...stored.payload,
      ...f72,
      schema: stored.payload.schema || f72.schema,
      forecast_6_hourly: mergeForecastPoints(previousPoints, incomingPoints),
    };

    const comparable = document => {
      const copy = { ...document };
      delete copy.published_at_utc;
      return JSON.stringify(copy);
    };
    if (comparable(stored.payload) === comparable(payload)) return false;
  }

  await env.GFS_DB.prepare(
    "INSERT INTO gfs_current (key, run_id_utc, payload_json, updated_at_utc) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET run_id_utc=excluded.run_id_utc, payload_json=excluded.payload_json, updated_at_utc=excluded.updated_at_utc"
  ).bind(
    "f72",
    payload.run_id_utc,
    JSON.stringify(payload),
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
  const statement = env.GFS_DB.prepare(
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
  );

  // D1 is single-threaded per database. A Cron collection and a page/API
  // request can legitimately collide on this publication write. Retry only
  // the idempotent upsert with short backoff so a transient D1 overload does
  // not turn the public SVG endpoint into HTTP 503.
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await statement.run();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }
  throw lastError;
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

const KOY_SVG_RENDERER_VERSION = "cloudflare-js-v9-homepage-identical";
const FONT = "system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
const KOY_SVG_ASSET_NAME = /^koy-gfs-\d{8}T\d{2}Z-comparison\.svg$/;

export function koySvgKeyMatches(expectedKey, builtKey) {
  if (!expectedKey) return true;
  const expectedName = String(expectedKey).split("/").pop();
  const builtName = String(builtKey || "").split("/").pop();
  return expectedName === builtName && KOY_SVG_ASSET_NAME.test(builtName);
}

function koyAssetLookupKeys(key) {
  const normalized = String(key || "").replace(/^\/+/, "");
  const name = normalized.split("/").pop();
  if (!KOY_SVG_ASSET_NAME.test(name)) return [normalized];
  return [...new Set([normalized, "media/" + name, "notifications/" + name])];
}
const KOY_SVG_COLORS = ["#8ABCE8", "#7DD3D7", "#F1C98B", "#B38BE8"];
const KOY_SVG_PANELS = [
  { id: "temperature", field: "temperature_2m_c", title: "Sıcaklık", unit: "°C" },
  { id: "temperature_850", field: "temperature_850hpa_c", title: "850 hPa sıcaklık", unit: "°C" },
  { id: "precipitation", field: "precipitation_6h_mm", title: "Yağış", unit: "mm / 3 saat" },
  { id: "wind_10m", field: "wind_speed_10m_kmh", title: "10 m rüzgâr hızı", unit: "km/sa" },
];

function svgEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[char]);
}

function svgNumber(value) {
  const number = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(number)
    ? null
    : number;
}

function svgValidKey(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return null;
  return new Date(Math.floor(timestamp / 60000) * 60000).toISOString();
}

function svgRunStamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.getUTCFullYear().toString() +
    String(date.getUTCMonth() + 1).padStart(2, "0") +
    String(date.getUTCDate()).padStart(2, "0") +
    "T" + String(date.getUTCHours()).padStart(2, "0") + "Z";
}

function svgRunLabel(value, latest) {
  const date = new Date(value);
  const label = String(date.getUTCHours()).padStart(2, "0") + "Z | " +
    String(date.getUTCDate()).padStart(2, "0") + "." +
    String(date.getUTCMonth() + 1).padStart(2, "0") + " " +
    String(date.getUTCHours()).padStart(2, "0") + ":00";
  return latest ? "YENİ · " + label : label;
}

function koyIsoMinute(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16) : null;
}
function koyLocalDate(value) {
  return new Date(new Date(value).getTime() + 3 * 60 * 60 * 1000);
}
function koyPad2(value) {
  return String(value).padStart(2, "0");
}
function koyFormatTrDate(date, includeTime = true) {
  const base = koyPad2(date.getUTCDate()) + "." + koyPad2(date.getUTCMonth() + 1) + "." + date.getUTCFullYear();
  return includeTime ? base + " " + koyPad2(date.getUTCHours()) + ":" + koyPad2(date.getUTCMinutes()) : base;
}
function koyFormatUtcDate(date) {
  return koyPad2(date.getUTCDate()) + "." + koyPad2(date.getUTCMonth() + 1) + "." + date.getUTCFullYear() +
    " " + koyPad2(date.getUTCHours()) + ":" + koyPad2(date.getUTCMinutes());
}

function buildKoySeries(runs) {
  const docs = (Array.isArray(runs) ? runs : [])
    .filter(run => run && run.run_id_utc && Array.isArray(run.forecast_6_hourly))
    .slice()
    .sort((a, b) => Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc))
    .slice(-4);
  if (docs.length !== 4) return null;

  const series = docs.map((document, index) => {
    const points = new Map();
    for (const point of document.forecast_6_hourly) {
      const key = koyIsoMinute(point?.valid_time_utc);
      if (key) points.set(key, point);
    }
    if (!points.size) throw new Error("No valid forecast points for " + document.run_id_utc);
    return {
      document,
      points,
      label: svgRunLabel(document.run_id_utc, index === docs.length - 1),
      color: KOY_SVG_COLORS.slice(-docs.length)[index],
    };
  });

  let common = [...series[series.length - 1].points.keys()];
  for (const item of series.slice(0, -1)) common = common.filter(key => item.points.has(key));
  common.sort();
  if (common.length < 2) throw new Error("The available GFS cycles have fewer than two common valid times");

  const firstMs = Date.parse(common[0] + ":00Z");
  const validKeys = common.filter(key => {
    const timestamp = Date.parse(key + ":00Z");
    return timestamp >= firstMs && timestamp <= firstMs + 180 * 3600000;
  });
  if (validKeys.length < 2) throw new Error("The common valid-time window is too short");

  const pointsBySeries = series.map(item => validKeys.map(key => item.points.get(key)));
  const localLabels = validKeys.map(key => {
    const utc = new Date(key + ":00Z");
    const local = koyLocalDate(utc);
    return {
      localKey: local.getUTCFullYear() + "-" + koyPad2(local.getUTCMonth() + 1) + "-" +
        koyPad2(local.getUTCDate()) + "T" + koyPad2(local.getUTCHours()) + ":" + koyPad2(local.getUTCMinutes()),
      label: koyFormatTrDate(local) + " TSİ",
      utcLabel: koyFormatUtcDate(utc) + " UTC",
    };
  });
  const dates = validKeys.map(key => new Date(key + ":00Z"));
  const offsets = dates.map(date => (date.getTime() - firstMs) / 3600000);
  return { series, validKeys, pointsBySeries, localLabels, dates, offsets };
}

export function buildKoyInteractiveSvg(comparison) {
  const candidateRuns = Array.isArray(comparison?.runs) ? comparison.runs : [];
  if (candidateRuns.length < 4) return null;
  const chart = buildKoySeries(candidateRuns);
  if (!chart) return null;
  const { series, validKeys, pointsBySeries, localLabels, dates, offsets } = chart;
  const W = 1152;
  const H = 838;
  const panelWidth = 505;
  const panelHeight = 250;
  const panelLeft = [55, 592];
  const panelTop = [214, 493];
  const firstOffset = offsets[0];
  const spanHours = offsets[offsets.length - 1] - firstOffset;
  const xMin = -1;
  const xMax = spanHours + Math.max(1, spanHours * 0.015);
  const xRatio = value => (value - xMin) / (xMax - xMin);

  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="koy-gfs-svg-title koy-gfs-svg-desc">',
    '<title id="koy-gfs-svg-title">Köy GFS · dört döngü valid-time karşılaştırması</title>',
    '<desc id="koy-gfs-svg-desc">Dört Köy GFS tahmin döngüsü aynı geçerlilik saatlerinde hizalanmıştır. Sıcaklık, 850 hPa sıcaklığı, yağış ve 10 metre rüzgârı karşılaştırılır.</desc>',
    '<g id="patch_1"><rect x="0" y="0" width="1152" height="838" style="fill: #0a1b29"/></g>',
    '<text x="63" y="34" fill="#7DD3D7" font-size="12" font-weight="700" letter-spacing="1.5" font-family="' + FONT + '">GFS · GİRESUN ÇANAKÇI</text>',
    '<text x="1090" y="34" text-anchor="end" fill="#8EAEB7" font-size="8" font-weight="500" font-family="' + FONT + '">Köy Havası v1.5.0</text>',
    '<text x="63" y="76" fill="#FFFFFF" font-size="27" font-weight="750" font-family="' + FONT + '">Son GFS raporu · ' + series.length + ' döngü karşılaştırması</text>',
    '<text x="63" y="108" fill="#E7F2F6" font-size="14" font-family="' + FONT + '">Mevcut GFS çıktıları aynı geçerlilik saatlerinde (TSİ) üst üste karşılaştırılır.</text>',
    '<rect x="850" y="20" width="245" height="36" rx="11" fill="#0A1B29" stroke="#416174" stroke-width="1"/>',
    '<text x="972.5" y="43" text-anchor="middle" fill="#B8D7DF" font-size="12" font-family="' + FONT + '">' + series.length + ' GFS döngüsü karşılaştırılıyor</text>',
  ];

  series.slice().reverse().forEach((item, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 335 + column * 290;
    const y = 148 + row * 26;
    const latest = item === series[series.length - 1];
    parts.push(
      '<line x1="' + x + '" y1="' + y + '" x2="' + (x + 38) + '" y2="' + y + '" stroke="' + item.color +
      '" stroke-width="' + (latest ? 3.2 : 1.8) + '"' + (latest ? "" : ' stroke-dasharray="4 3"') + ' stroke-linecap="round"/>',
      '<text x="' + (x + 49) + '" y="' + (y + 4) + '" fill="#FFFFFF" font-size="12" font-weight="' +
      (latest ? "700" : "500") + '" font-family="' + FONT + '">' + svgEscape(item.label) + '</text>'
    );
  });
  const metadata = [];
  KOY_SVG_PANELS.forEach((spec, panelIndex) => {
    const column = panelIndex % 2;
    const row = Math.floor(panelIndex / 2);
    const px = panelLeft[column];
    const py = panelTop[row];
    const plotX = px + 50;
    const plotY = py + 57;
    const plotWidth = panelWidth - 73;
    const plotHeight = 146;
    const valuesBySeries = pointsBySeries.map(points => points.map(point => svgNumber(point?.[spec.field])));
    const allValues = valuesBySeries.flat().filter(value => value !== null);
    const axis = buildPanelAxis(spec.field, valuesBySeries, {
      includeOlderSeriesForScale: false,
    });
    const { low, high, ticks, latestPeak, latestTrough } = axis;

    const xPositions = offsets.map(offset => plotX + xRatio(offset) * plotWidth);
    const yFor = value => plotY + (high - value) * plotHeight / (high - low);
    const patchId = ["patch_6", "patch_11", "patch_16", "patch_21"][panelIndex];
    parts.push(
      '<g id="' + patchId + '"><rect x="' + px + '" y="' + py + '" width="' + panelWidth + '" height="' +
      panelHeight + '" rx="13" style="fill: #102a3a" stroke="#416174" stroke-width="1"/></g>',
      '<g id="koy-panel-' + spec.id + '">',
      '<text x="' + (px + 18) + '" y="' + (py + 31) + '" fill="#FFFFFF" font-size="18" font-weight="700" font-family="' +
      FONT + '">' + svgEscape(spec.title) + '</text>',
      '<text x="' + (px + panelWidth - 17) + '" y="' + (py + 30) + '" text-anchor="end" fill="#E7F2F6" font-size="12" font-weight="650" font-family="' +
      FONT + '">' + svgEscape(spec.unit) + '</text>'
    );

    ticks.slice().reverse().forEach(value => {
      const y = yFor(value);
      parts.push(
        '<line x1="' + plotX + '" y1="' + y + '" x2="' + (plotX + plotWidth) + '" y2="' + y +
        '" stroke="#456579" stroke-width="1" stroke-dasharray="2 4" opacity=".65"/>',
        '<text x="' + (plotX - 10) + '" y="' + (y + 4) + '" text-anchor="end" fill="#E7F2F6" font-size="11" font-weight="600" font-family="' +
        FONT + '" data-axis-tick="true">' + formatAxisTick(value) + '</text>'
      );
    });

    const tickIndexes = [];
    offsets.forEach((offset, index) => {
      if (index === 0 || Math.abs(offset % 12) < 0.01) tickIndexes.push(index);
    });
    if (tickIndexes[tickIndexes.length - 1] !== offsets.length - 1) tickIndexes.push(offsets.length - 1);
    tickIndexes.forEach(index => {
      const d = koyLocalDate(dates[index]);
      const day = koyPad2(d.getUTCDate());
      const weekday = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"][d.getUTCDay()];
      const anchor = index === 0 ? "start" : index === offsets.length - 1 ? "end" : "middle";
      parts.push(
        '<text x="' + xPositions[index] + '" y="' + (plotY + plotHeight + 19) + '" text-anchor="' + anchor +
        '" fill="#E7F2F6" font-size="10" font-weight="650" font-family="' + FONT + '"><tspan x="' +
        xPositions[index] + '">' + day + '</tspan><tspan x="' + xPositions[index] + '" dy="13">' + weekday + '</tspan></text>'
      );
    });

    const panelSeries = [];
    series.forEach((item, seriesIndex) => {
      const values = valuesBySeries[seriesIndex];
      // Older cycles may contain peaks outside the current/latest axis.
      // Do not connect those out-of-range points back into the plot: a huge
      // obsolete spike can otherwise create a diagonal/vertical line through
      // the current chart. Raw values remain in metadata for tooltips.
      const plotValues = values.map(value =>
        value === null || value < low || value > high ? null : value
      );
      const yPositions = plotValues.map(value => value === null ? null : Number(yFor(value).toFixed(3)));
      const leadHours = pointsBySeries[seriesIndex].map(point => {
        const n = Number(point?.forecast_hour);
        return Number.isFinite(n) ? Math.round(n) : null;
      });
      const directions = pointsBySeries[seriesIndex].map(point =>
        spec.field === "wind_speed_10m_kmh" ? svgNumber(point?.wind_direction_10m_deg) : null
      );
      let pathData = "";
      let open = false;
      plotValues.forEach((value, index) => {
        if (value === null) { open = false; return; }
        pathData += (open ? " L " : " M ") + xPositions[index].toFixed(3) + " " + yPositions[index];
        open = true;
      });
      const latest = seriesIndex === series.length - 1;
      parts.push(
        '<path id="gfs-series-' + spec.id + '-' + seriesIndex + '" data-gfs-series-run-id="' +
        svgEscape(item.document.run_id_utc) + '" d="' + pathData + '" fill="none" stroke="' + item.color + '" stroke-width="' +
        (latest ? 3.2 : 1.8) + '"' + (latest ? "" : ' stroke-dasharray="4 3"') +
        ' stroke-linecap="round" stroke-linejoin="round" opacity="' + (latest ? "1" : ".94") + '"/>'
      );
      if (latest) values.forEach((value, index) => {
        if (value !== null) parts.push('<circle cx="' + xPositions[index].toFixed(3) + '" cy="' +
          yPositions[index] + '" r="2.8" fill="' + item.color + '"/>');
      });
      const pushExtremeMarker = (kind, extreme, avoidBoxes) => {
        if (extreme === null) return null;
        let extremeIndex = -1;
        values.forEach((value, index) => {
          if (value !== null && Math.abs(value - extreme) < 1e-9 && extremeIndex < 0) extremeIndex = index;
        });
        if (extremeIndex < 0) return null;
        const pointX = xPositions[extremeIndex];
        const pointY = yPositions[extremeIndex];
        const label = formatPeakValue(extreme) + " " + peakUnit(spec.field);
        const timeLabel = localLabels[extremeIndex]?.label || "";
        const place = seriesCalloutPlacement({
          x: pointX, y: pointY, plotX, plotY, plotWidth, plotHeight, label, avoidBoxes
        });
        const valueAttr = kind === "trough" ? "data-latest-trough-value" : "data-latest-peak-value";
        const timeAttr = kind === "trough" ? "data-latest-trough-time" : "data-latest-peak-time";
        const className = kind === "trough" ? "gfs-latest-trough-marker" : "gfs-latest-peak-marker";
        parts.push(
          '<g class="' + className + '" ' + valueAttr + '="' + svgEscape(label) +
          '" ' + timeAttr + '="' + svgEscape(timeLabel) + '">',
          '<circle cx="' + Number(pointX).toFixed(3) + '" cy="' + pointY +
          '" r="5.2" fill="' + item.color + '" stroke="#F7FDFF" stroke-width="1.4"/>',
          '<rect x="' + Number(place.boxX).toFixed(3) + '" y="' + Number(place.boxY).toFixed(3) +
          '" width="' + place.labelWidth.toFixed(1) + '" height="16" rx="3" fill="#0A1B29" fill-opacity=".88"/>',
          '<text x="' + Number(place.labelX).toFixed(3) + '" y="' + Number(place.labelY).toFixed(3) +
          '" text-anchor="' + (place.nearRight ? "end" : "start") +
          '" fill="#F7FDFF" font-size="11" font-weight="800" font-family="' + FONT + '">' +
          svgEscape(label) + '</text>',
          '</g>'
        );
        return { box: place.box, x: pointX, y: pointY };
      };
      if (latest) {
        const peak = pushExtremeMarker("peak", latestPeak, []);
        const avoid = [];
        if (peak) {
          avoid.push(peak.box);
          avoid.push({ x: peak.x - 8, y: peak.y - 8, width: 16, height: 16 });
        }
        pushExtremeMarker("trough", latestTrough, avoid);
      }

      panelSeries.push({
        label: item.label,
        run_id_utc: item.document.run_id_utc,
        color: item.color,
        lead_hours: leadHours,
        values,
        y_positions: yPositions,
        directions_deg: directions,
      });
    });

    metadata.push({
      id: spec.id,
      title: spec.title,
      unit: spec.unit,
      plot: { x: plotX, y: plotY, width: plotWidth, height: plotHeight },
      x_positions: xPositions.map(value => Number(value.toFixed(3))),
      valid_times: localLabels.map(item => ({
        local_key: item.localKey,
        label: item.label,
        utc_label: item.utcLabel,
      })),
      series: panelSeries,
    });

    if (!allValues.length) {
      parts.push('<text x="' + (plotX + plotWidth / 2) + '" y="' + (plotY + plotHeight / 2) +
        '" text-anchor="middle" fill="#E7F2F6" font-size="13" font-family="' + FONT + '">Bu değişken için veri yok</text>');
    }
    parts.push("</g>");
  });

  const metadataText = JSON.stringify({ version: 1, renderer: KOY_SVG_RENDERER_VERSION, panels: metadata })
    .replace(/\]\]>/g, "]]\\u003e");
  parts.push(
    '<text x="63" y="810" fill="#E7F2F6" font-size="11" font-family="' + FONT + '">Aynı geçerlilik saatleri (TSİ) · ' +
    validKeys.length + ' ortak nokta · ' + series.length + ' döngü</text>',
    '<text x="1090" y="810" text-anchor="end" fill="#E7F2F6" font-size="10" font-family="' + FONT +
    '">Kaynak: MeteoPT GFS · Giresun / Çanakçı nokta tahmini</text>',
    '<metadata id="gfs-renderer-version">cloudflare-js-v9-homepage-identical</metadata>',
    '<metadata id="gfs-interactive-data"><![CDATA[' + metadataText + ']]></metadata>',
    '<g id="gfs-interaction-layer">'
  );
  metadata.forEach(panel => {
    const plot = panel.plot;
    const xStart = panel.x_positions[0];
    parts.push(
      '<g class="gfs-panel-interaction" data-panel-id="' + panel.id + '">',
      '<rect class="gfs-hit-area" data-panel-id="' + panel.id + '" x="' + plot.x + '" y="' + plot.y +
      '" width="' + plot.width + '" height="' + plot.height + '" fill="transparent" pointer-events="all" tabindex="0" role="group" aria-label="' +
      svgEscape(panel.title) + ' grafiği; ok tuşlarıyla geçerlilik saatleri arasında gezinin"/>',
      '<line class="gfs-tooltip-crosshair" x1="' + xStart + '" x2="' + xStart + '" y1="' + plot.y +
      '" y2="' + (plot.y + plot.height) + '" stroke="#EAF5F8" stroke-width="1.1" stroke-dasharray="4 4" opacity=".78" visibility="hidden" pointer-events="none"/>',
      '<g class="gfs-tooltip-markers" pointer-events="none"></g>',
      "</g>"
    );
  });
  parts.push("</g></svg>");
  const body = parts.join("");
  if (body.length > 1800000) throw new Error("Generated Köy SVG exceeds the D1 publication row safety limit");
  const latest = series[series.length - 1].document;
  return {
    key: "media/koy-gfs-" + svgRunStamp(latest.run_id_utc) + "-comparison.svg",
    run_id_utc: latest.run_id_utc,
    body,
    common_valid_time_count: validKeys.length,
  };
}

async function publishLatestKoySvg(env, expectedKey = null) {
  // The live table is sourced from gfs_current/f72. The published SVG must
  // use that exact payload as its newest cycle; gfs_runs is only the source
  // for the three older comparison cycles.
  const current = await currentRun(env, "f72");
  if (!current?.payload?.run_id_utc) return null;

  const latestKey = "media/koy-gfs-" + svgRunStamp(current.payload.run_id_utc) + "-comparison.svg";
  if (!koySvgKeyMatches(expectedKey, latestKey)) return null;

  const existingLatest = await getPublicationAsset(env, latestKey);
  const expectedRenderer = 'id="gfs-renderer-version">' + KOY_SVG_RENDERER_VERSION + '</metadata>';
  if (existingLatest &&
      existingLatest.run_id_utc === current.payload.run_id_utc &&
      existingLatest.content_type === "image/svg+xml; charset=utf-8" &&
      String(existingLatest.body || "").includes(expectedRenderer)) {
    return {
      key: latestKey,
      row: existingLatest,
      renderer: KOY_SVG_RENDERER_VERSION,
    };
  }

  const result = await env.GFS_DB.prepare(
    "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
  ).all();
  let runs = (result.results || []).map(row => JSON.parse(row.payload_json));

  // Replace any archived copy of the current run with the canonical live
  // payload. This is the critical table/chart synchronization rule.
  runs = runs.filter(run => run.run_id_utc !== current.payload.run_id_utc);
  runs = [...runs.slice(-3), current.payload]
    .sort((a, b) => Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc));

  if (runs.length < 4) return null;

  const comparison = {
    schema: "koy-gfs.comparison.v1",
    location: LOCATION,
    updated_at_utc: current.updated_at_utc || null,
    runs,
  };
  const built = buildKoyInteractiveSvg(comparison);
  if (!built || !koySvgKeyMatches(expectedKey, built.key)) return null;

  const existing = await getPublicationAsset(env, built.key);
  if (!existing || existing.body !== built.body ||
      existing.content_type !== "image/svg+xml; charset=utf-8" ||
      existing.run_id_utc !== built.run_id_utc) {
    await putPublicationAsset(env, {
      key: built.key,
      body: built.body,
      content_type: "image/svg+xml; charset=utf-8",
      run_id_utc: built.run_id_utc,
    });
  }
  const stored = await getPublicationAsset(env, built.key);
  return stored ? { key: built.key, row: stored, renderer: KOY_SVG_RENDERER_VERSION } : null;
}

async function collect(env) {
  const now = new Date();
  const candidates = await fetchAvailableCycles();
  const normalizedRuns = candidates.map(candidate => normalizeDocument(candidate, now));
  const normalized = normalizedRuns[0];

  let f72Changed = false;
  let f180Changed = false;
  let archivedRunsChanged = 0;
  let comparisonSvgPublished = false;

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

  // Render the four-cycle interactive SVG in this Worker and keep the canonical copy in D1.
  // A rendering problem must not interrupt the successful GFS data collection.
  if (archivedRunsChanged > 0 || f72Changed) {
    try {
      comparisonSvgPublished = Boolean(await publishLatestKoySvg(env));
    } catch (error) {
      console.error(JSON.stringify({
        event: "koy_gfs_svg_publish_error",
        message: String(error?.message || error),
      }));
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
    comparison_svg_published: comparisonSvgPublished,
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
    comparison_svg_published: comparisonSvgPublished,
    max_forecast_hour: normalized.maxForecastHour,
    step_count: normalized.stepCount,
    checked_at_utc: now.toISOString(),
  };
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (request.method === "OPTIONS") return json({ ok: true });

  if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  if (path === "/api/comparison.svg") {
    try {
      // Publication persistence is an optimization; it must never be allowed
      // to turn the public comparison chart into HTTP 503 during a D1 write
      // collision. If the archive is incomplete, bootstrap collection first.
      try {
        const published = await publishLatestKoySvg(env);
        if (published?.row) return decodePublicationAsset(published.row);
      } catch (publicationError) {
        console.warn(JSON.stringify({
          event: "koy_svg_publication_direct_render_fallback",
          message: String(publicationError?.message || publicationError),
        }));
      }

      let result = await env.GFS_DB.prepare(
        "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
      ).all();
      let runs = (result.results || []).map(row => JSON.parse(row.payload_json));
      const current = await currentRun(env, "f72");
      if (runs.length < 4 || !current) {
        await collect(env);
        result = await env.GFS_DB.prepare(
          "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
        ).all();
        runs = (result.results || []).map(row => JSON.parse(row.payload_json));
      }

      // The live table uses gfs_current/f72. Use that exact canonical payload
      // as the newest chart cycle; only the previous three cycles come from
      // gfs_runs. This prevents a late MeteoPT correction from producing
      // different F42 values in the table and chart.
      const latestCurrent = await currentRun(env, "f72");
      if (latestCurrent?.payload?.run_id_utc) {
        runs = runs.filter(run => run.run_id_utc !== latestCurrent.payload.run_id_utc);
        runs = [...runs.slice(-3), latestCurrent.payload]
          .sort((a, b) => Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc));
      }

      // The chart itself must remain available even if the D1 publication write
      // is temporarily contended. Build directly from the same canonical GFS
      // payloads and return the SVG without requiring a publication write.
      if (runs.length < 4) {
        return json({ ok: false, error: "Four complete Köy GFS cycles are not available" }, 404);
      }
      const ordered = runs.slice().sort((a, b) =>
        Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc)
      );
      const built = buildKoyInteractiveSvg({
        schema: "koy-gfs.comparison.v1",
        location: LOCATION,
        updated_at_utc: ordered[ordered.length - 1]?.published_at_utc || null,
        runs: ordered,
      });
      if (!built) return json({ ok: false, error: "Köy GFS SVG could not be rendered" }, 503);
      return new Response(built.body, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=300, s-maxage=600",
          "Access-Control-Allow-Origin": "*",
          "X-GFS-Publication-Source": "D1",
          "X-GFS-SVG-Fallback": "direct-render",
        },
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path.startsWith("/api/publication-asset/")) {
    const key = decodeURIComponent(path.slice("/api/publication-asset/".length)).replace(/^\/+/, "");
    try {
      let row = null;
      for (const candidate of koyAssetLookupKeys(key)) {
        row = await getPublicationAsset(env, candidate);
        if (row) break;
      }
      const expectedRenderer = 'id="gfs-renderer-version">' + KOY_SVG_RENDERER_VERSION + '</metadata>';
      if (!row || !String(row.body || "").includes(expectedRenderer)) {
        try {
          const published = await publishLatestKoySvg(env, key);
          if (published?.row) row = published.row;
        } catch (publicationError) {
          console.warn(JSON.stringify({
            event: "koy_svg_publication_fallback",
            message: String(publicationError?.message || publicationError),
          }));
        }
      }
      if (row) return decodePublicationAsset(row);

      // D1 publication writes can be temporarily contended. The requested
      // chart remains renderable directly from the same four raw GFS payloads.
      const result = await env.GFS_DB.prepare(
        "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
      ).all();
      const runs = (result.results || []).map(row => JSON.parse(row.payload_json));
      const ordered = runs.slice().sort((a, b) =>
        Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc)
      );
      const built = buildKoyInteractiveSvg({
        schema: "koy-gfs.comparison.v1",
        location: LOCATION,
        updated_at_utc: ordered[ordered.length - 1]?.published_at_utc || null,
        runs: ordered,
      });
      if (!built || !koySvgKeyMatches(key, built.key)) {
        return json({ ok: false, error: "Publication asset not found" }, 404);
      }
      return new Response(built.body, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=300, s-maxage=600",
          "Access-Control-Allow-Origin": "*",
          "X-GFS-Publication-Source": "D1",
          "X-GFS-SVG-Fallback": "direct-render",
        },
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/source-audit") {
    try {
      const current = await currentRun(env, "f72");
      if (!current?.payload?.run_id_utc) {
        return json({ ok: false, error: "No canonical Köy GFS payload is stored yet" }, 404);
      }

      const requestedHour = new Date(current.run_id_utc).getUTCHours();
      const fresh = await fetchCycle(requestedHour);
      const normalized = normalizeDocument(fresh, new Date());
      const freshPayload = normalized.full || normalized.f72;
      const targetHour = Math.max(3, Number(new URL(request.url).searchParams.get("forecast_hour") || 42));
      const findPoint = document =>
        document?.forecast_6_hourly?.find(point => Number(point?.forecast_hour) === targetHour) || null;

      const fields = [
        "temperature_2m_c",
        "precipitation_6h_mm",
        "wind_speed_10m_kmh",
        "temperature_850hpa_c",
        "wind_speed_850hpa_kmh",
        "humidity_2m_percent",
        "snowln",
      ];
      const freshPoint = findPoint(freshPayload);
      const storedPoint = findPoint(current.payload);
      const comparison = Object.fromEntries(fields.map(field => [
        field,
        {
          fresh_api: freshPoint?.[field] ?? null,
          stored_current: storedPoint?.[field] ?? null,
          equal: Object.is(freshPoint?.[field] ?? null, storedPoint?.[field] ?? null),
        },
      ]));

      return json({
        ok: true,
        source: {
          provider: "MeteoPT",
          web_url: METEOPT_GFS_WEB + "?lat=" + LOCATION.latitude + "&lon=" + LOCATION.longitude,
          api_url: fresh.url,
          coordinate: LOCATION,
          requested_cycle_utc: requestedHour,
          fresh_api_run_id_utc: fresh.apiRun,
          stored_run_id_utc: current.run_id_utc,
        },
        forecast_hour: targetHour,
        comparison,
      });
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
        svg_renderer: KOY_SVG_RENDERER_VERSION,
      });
    } catch (error) {
      return json({ ok: false, service: "gfs-watch-koy-gfs", error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/meteopt-f180-live") {
    try {
      // The Köy 180-hour table is sourced from the exact MeteoPT location page.
      // Fetch the current MeteoPT GFS dataset live instead of serving a stale D1
      // archive snapshot. The API endpoint is MeteoPT's data backend for this
      // exact web-page coordinate.
      const url = new URL(API_BASE);
      url.searchParams.set("lat", String(LOCATION.latitude));
      url.searchParams.set("lon", String(LOCATION.longitude));
      url.searchParams.set("lang", "en");
      const response = await fetch(url.toString(), {
        headers: {
          "User-Agent": "GFS-Watch-Koy-MeteoPT-Table/1.0",
          "Cache-Control": "no-cache",
        },
      });
      if (!response.ok) throw new Error("MeteoPT HTTP " + response.status);
      const document = await response.json();
      const apiRun = String(document?.run || "").trim();
      if (!apiRun) throw new Error("MeteoPT returned no current run id");

      const normalized = normalizeDocument(
        { apiRun, document, url: url.toString() },
        new Date()
      );
      const payload = normalized.full;
      if (!payload) throw new Error("MeteoPT current run is not F180-ready");

      return json({
        ...payload,
        source_url: METEOPT_GFS_WEB + "?lat=" + LOCATION.latitude + "&lon=" + LOCATION.longitude,
        source_page: METEOPT_GFS_WEB + "?lat=" + LOCATION.latitude + "&lon=" + LOCATION.longitude,
        source_backend: url.toString(),
        source_mode: "live-meteopt",
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/f72") {
    try {
      let current = await currentRun(env, "f72");
      // Bootstrap missing data and enrich older D1 records after a schema expansion.
      // Only check the first 72 hours: a stored F180 payload keeps its longer horizon.
      const needsSnowlineEnrichment = Boolean(current &&
        Array.isArray(current.payload?.forecast_6_hourly) &&
        (current.payload.meteopt_snowln_source_field == null ||
          current.payload.forecast_6_hourly.some(point => {
            const hour = Number(point?.forecast_hour);
            return hour > 0 && hour <= 72 &&
              (point.snowln === null || point.snowln === undefined ||
               point.humidity_2m_percent === null || point.humidity_2m_percent === undefined);
          })));
      // One-time backfill for same-run D1 records created before 10 m wind direction
      // was included in the canonical Köy forecast payload.
      const needsWindDirectionEnrichment = Boolean(current &&
        current.payload?.wind_direction_enrichment_checked !== true);
      if (!current || needsSnowlineEnrichment || needsWindDirectionEnrichment) {
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
      let runs = (result.results || []).map(row => JSON.parse(row));

      // If the comparison archive is incomplete, fetch all currently available
      // MeteoPT cycles before replying.
      let current = await currentRun(env, "f72");
      if (runs.length < 4 || !current) {
        await collect(env);
        result = await env.GFS_DB.prepare(
          "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
        ).all();
        runs = (result.results || []).map(row => JSON.parse(row));
        current = await currentRun(env, "f72");
      }

      // Canonical source-of-truth rule:
      //   table      -> current f72/f180 payload
      //   chart      -> same current payload + previous 3 archived cycles
      //   briefing   -> same current payload
      // The latest comparison run must therefore never come from an older
      // gfs_runs snapshot when gfs_current has a corrected MeteoPT payload.
      if (current?.payload?.run_id_utc) {
        runs = runs.filter(run => run.run_id_utc !== current.payload.run_id_utc);
        runs = [...runs.slice(-3), current.payload]
          .sort((a, b) => Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc));
      }

      return json({
        schema: "koy-gfs.comparison.v1",
        location: LOCATION,
        updated_at_utc: current?.updated_at_utc || runs[runs.length - 1]?.published_at_utc || null,
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
      let runs = (comparison.results || []).map(row => JSON.parse(row.payload_json));
      if (current?.payload?.run_id_utc) {
        runs = runs.filter(run => run.run_id_utc !== current.payload.run_id_utc);
        runs = [...runs.slice(-3), current.payload]
          .sort((a, b) => Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc));
      }
      return json({
        ok: true,
        f72: current?.payload || null,
        comparison: {
          schema: "koy-gfs.comparison.v1",
          location: LOCATION,
          updated_at_utc: current?.updated_at_utc || null,
          runs,
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
