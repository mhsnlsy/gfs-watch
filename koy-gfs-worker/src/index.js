import { METEOPT_GFS_API, METEOPT_GFS_WEB, METEOPT_SOURCE_POLICY, meteoptSourceMetadata } from "../../shared/meteopt-source.js";
import { buildPanelAxis, formatAxisTick, formatPeakValue, peakUnit, seriesCalloutPlacement } from "../../shared/gfs-chart-axis.js";
import { NIGHTLY_CRON, climateTick, refreshClimateAll } from "./climate-nightly.js";

const API_BASE = METEOPT_GFS_API;
const LOCATION = {
  name: "Giresun / Çanakçı",
  latitude: 40.9557,
  longitude: 39.0065,
};
const CYCLES = [18, 12, 6, 0];

const CLIMATE_MODELS = {
  cerra: {
    label: "CERRA",
    resolution: "5.5 KM",
    startYear: 1985,
    // Historical baseline only needs temperature and precipitation.
    // Wind is calculated from the current-month Forecast API below.
    daily: [
      "temperature_2m_max","temperature_2m_min","temperature_2m_mean",
      "precipitation_sum"
    ],
    supportsPrecip: true,
    supportsWind: true,
  },
  era5: {
    label: "ERA5",
    resolution: "~31 KM",
    startYear: 1940,
    // Historical baseline only needs temperature and precipitation.
    daily: [
      "temperature_2m_max","temperature_2m_min","temperature_2m_mean",
      "precipitation_sum"
    ],
    supportsPrecip: true,
    supportsWind: true,
  },
  era5_land: {
    label: "ERA5-LAND",
    resolution: "~9 KM",
    startYear: 1950,
    // ERA5-Land Historical Weather API does not expose precipitation or
    // 10 m wind in this endpoint. Keep the request model-valid.
    daily: [
      "temperature_2m_max","temperature_2m_min","temperature_2m_mean"
    ],
    supportsPrecip: false,
    supportsWind: false,
  },
};

function istanbulDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const out = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = Number(part.value);
  return out;
}

function climateDateKey(parts) {
  return String(parts.year) + "-" + String(parts.month).padStart(2, "0") + "-" + String(parts.day).padStart(2, "0");
}

function climateArchiveUrl(model, start, end) {
  const daily = CLIMATE_MODELS[model].daily.join(",");
  // Open-Meteo Historical Weather API uses the unified /v1/archive
  // endpoint. Pin the selected reanalysis with models= so the historical
  // series never silently switches to another model.
  if (!CLIMATE_MODELS[model]) throw new Error("Unsupported climate model: " + model);

  return "https://archive-api.open-meteo.com/v1/archive"
    + "?latitude=" + LOCATION.latitude
    + "&longitude=" + LOCATION.longitude
    + "&start_date=" + start
    + "&end_date=" + end
    + "&daily=" + daily
    + "&models=" + encodeURIComponent(model)
    + "&timezone=Europe/Istanbul";
}

async function fetchClimateArchive(model, start, end) {
  // Open-Meteo occasionally returns 503 for long ERA5/ERA5-Land archive
  // windows. The climate panel only needs one calendar month per year, so
  // request compact 5-year chunks instead of multi-decade ranges.
  const startYear = Number(start.slice(0, 4));
  const endYear = Number(end.slice(0, 4));
  const ranges = [];
  for (let year = startYear; year <= endYear; year += 5) {
    const chunkEndYear = Math.min(year + 4, endYear);
    const rangeStart = String(year) + "-" + start.slice(5);
    const rangeEnd = String(chunkEndYear) + "-" + end.slice(5);
    ranges.push([rangeStart, rangeEnd]);
  }

  async function fetchChunk(rangeStart, rangeEnd) {
    let lastStatus = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const response = await fetch(climateArchiveUrl(model, rangeStart, rangeEnd), {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; IstanbulHavasi/1.0; +https://istanbulunhavasi.com/)",
            "Accept": "application/json",
            "Cache-Control": "no-cache",
          },
          signal: AbortSignal.timeout(45000),
        });
        lastStatus = response.status;
        if (response.ok) return await response.json();
        if (response.status !== 429 && response.status < 500) {
          throw new Error("Open-Meteo climate HTTP " + response.status);
        }
      } catch (error) {
        if (attempt === 5) throw error;
        lastStatus = error?.status ?? lastStatus;
      }
      // 503/429 responses are transient upstream pressure signals. Back off
      // before the next request instead of opening several archive requests
      // concurrently from the same Worker invocation.
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
    throw new Error("Open-Meteo climate HTTP " + lastStatus + " after retries");
  }

  // Do NOT request multiple ERA5/ERA5-Land archive ranges concurrently.
  // The previous 4-way fan-out caused the live Worker to receive 503s from
  // Open-Meteo even though an individual archive request is valid. Keep one
  // upstream archive request in flight at a time and retry transient 5xx/429s.
  const documents = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    documents.push(await fetchChunk(rangeStart, rangeEnd));
  }

  const merged = { ...documents[0], daily: { ...documents[0].daily } };
  for (const document of documents.slice(1)) {
    for (const [key, values] of Object.entries(document.daily || {})) {
      if (key === "time") {
        merged.daily.time = [...(merged.daily.time || []), ...(values || [])];
      } else {
        merged.daily[key] = [...(merged.daily[key] || []), ...(values || [])];
      }
    }
  }
  return merged;
}
function climateRows(document) {
  const d = document?.daily;
  if (!d || !Array.isArray(d.time)) return [];
  return d.time.map((time, i) => ({
    time,
    year: Number(time.slice(0, 4)),
    month: Number(time.slice(5, 7)),
    day: Number(time.slice(8, 10)),
    mean: Number.isFinite(Number(d.temperature_2m_mean?.[i])) ? Number(d.temperature_2m_mean[i]) : null,
    max: Number.isFinite(Number(d.temperature_2m_max?.[i])) ? Number(d.temperature_2m_max[i]) : null,
    min: Number.isFinite(Number(d.temperature_2m_min?.[i])) ? Number(d.temperature_2m_min[i]) : null,
    precip: Number.isFinite(Number(d.precipitation_sum?.[i])) ? Number(d.precipitation_sum[i]) : 0,
    windMean: Number.isFinite(Number(d.wind_speed_10m_mean?.[i])) ? Number(d.wind_speed_10m_mean[i]) : null,
    windMax: Number.isFinite(Number(d.wind_gusts_10m_max?.[i])) ? Number(d.wind_gusts_10m_max[i]) : null,
  }));
}

function climateAverage(values) {
  const valid = values.filter(value => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function climateRound(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

async function buildClimatePayload(model, parts, archive, recent) {
  const rows = climateRows(archive);
  // The archive is intentionally used only for the historical baseline.
  // Current-month readings come from the continuously updated Forecast API,
  // because CERRA ends in June 2021 and ERA5/ERA5-Land have publication lag.
  const recentRows = climateRows(recent);
  const monthRows = recentRows.filter(row =>
    row.year === parts.year && row.month === parts.month && row.day <= parts.day
  );
  const dayRows = rows.filter(row => row.month === parts.month && row.day === parts.day && row.mean !== null);
  const historical = dayRows.filter(row => row.year < parts.year);

  const monthlyHistory = new Map();
  for (const row of rows.filter(row => row.month === parts.month && row.year < parts.year)) {
    if (!monthlyHistory.has(row.year)) monthlyHistory.set(row.year, 0);
    monthlyHistory.set(row.year, monthlyHistory.get(row.year) + (row.precip || 0));
  }

  const monthlyNormals = [...monthlyHistory.values()];
  const supportsPrecip = CLIMATE_MODELS[model].supportsPrecip;
  const supportsWind = CLIMATE_MODELS[model].supportsWind;
  const monthPrecip = supportsPrecip
    ? monthRows.reduce((sum, row) => sum + (row.precip || 0), 0)
    : null;
  const monthNormal = supportsPrecip ? climateAverage(monthlyNormals) : null;
  const anomaly = supportsPrecip && monthNormal != null && monthNormal !== 0
    ? ((monthPrecip - monthNormal) / monthNormal) * 100
    : null;

  const historicalMeans = historical.map(row => row.mean).filter(v => v !== null);
  const historicalMin = historicalMeans.length ? Math.min(...historicalMeans) : null;
  const historicalMax = historicalMeans.length ? Math.max(...historicalMeans) : null;
  const historicalAvg = climateAverage(historicalMeans);
  const minRow = historical.find(row => row.mean === historicalMin);
  const maxRow = historical.find(row => row.mean === historicalMax);
  const today = monthRows.find(row => row.year === parts.year && row.day === parts.day) || null;
  const record = historical.reduce((best, row) => {
    if (!best || row.precip > best.precip) return row;
    return best;
  }, null);

  return {
    schema: "koy-climate.v1",
    location: LOCATION,
    model,
    model_label: CLIMATE_MODELS[model].label,
    resolution: CLIMATE_MODELS[model].resolution,
    period_date: climateDateKey(parts),
    month_name: new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(Date.UTC(parts.year, parts.month - 1, 1))).toUpperCase(),
    month_readings_through_day: parts.day,
    historical_start_year: rows.length ? Math.min(...rows.map(row => row.year)) : null,
    historical_end_year: rows.length ? Math.max(...rows.map(row => row.year)) : null,
    month: {
      avg_temp_c: climateRound(climateAverage(monthRows.map(row => row.mean).filter(v => v !== null))),
      high_c: climateRound(Math.max(...monthRows.map(row => row.max).filter(v => v !== null))),
      low_c: climateRound(Math.min(...monthRows.map(row => row.min).filter(v => v !== null))),
      precipitation_mm: supportsPrecip ? climateRound(monthPrecip) : null,
      avg_wind_kmh: supportsWind ? climateRound(climateAverage(monthRows.map(row => row.windMean).filter(v => v !== null))) : null,
      max_wind_kmh: supportsWind ? climateRound(monthRows.reduce((max, row) => row.windMax != null ? Math.max(max, row.windMax) : max, -Infinity)) : null,
    },
    long_term: {
      min_c: climateRound(historicalMin),
      min_year: minRow?.year ?? null,
      avg_c: climateRound(historicalAvg),
      max_c: climateRound(historicalMax),
      max_year: maxRow?.year ?? null,
      current_temperature_c: null,
      today_mean_c: climateRound(today?.mean),
      today_precipitation_mm: climateRound(today?.precip || 0),
      record_daily_precipitation_mm: climateRound(record?.precip),
      record_daily_precipitation_year: record?.year ?? null,
    },
    precipitation_anomaly: {
      current_mm: climateRound(monthPrecip),
      normal_mm: climateRound(monthNormal),
      percent: climateRound(anomaly),
    },
    updated_at_utc: new Date().toISOString(),
  };
}

async function refreshClimateCache(env, forceDate = null) {
  const parts = forceDate && !forceDate.models ? forceDate : istanbulDateParts();
  const periodDate = climateDateKey(parts);

  // Historical reanalysis is used only for the long-term baseline.
  // Current-month readings are fetched from the continuously updated
  // Forecast API because CERRA ends in June 2021 and ERA5/ERA5-Land
  // are published with a delay.
  // The panel only needs the selected calendar month for the historical
  // distribution and precipitation normal. Requesting every day from 1940
  // onward made ERA5/ERA5-Land archive responses unnecessarily large and
  // caused Cloudflare/Open-Meteo 503s.
  const monthStart = String(parts.month).padStart(2, "0") + "-01";
  const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  const historicalStartByModel = model =>
    String(CLIMATE_MODELS[model].startYear) + "-" + monthStart;
  const historicalEnd = String(parts.year - 1) + "-" +
    String(parts.month).padStart(2, "0") + "-" +
    String(daysInMonth).padStart(2, "0");
  const recentUrl = "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + LOCATION.latitude
    + "&longitude=" + LOCATION.longitude
    + "&past_days=31&forecast_days=1"
    + "&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,wind_speed_10m_mean,wind_gusts_10m_max"
    + "&timezone=Europe/Istanbul";

  const recentResponse = await fetch(recentUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; IstanbulHavasi/1.0; +https://istanbulunhavasi.com/)",
      "Accept": "application/json",
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(60000),
  });
  if (!recentResponse.ok) {
    throw new Error("Open-Meteo recent climate HTTP " + recentResponse.status);
  }
  const recent = await recentResponse.json();

  const results = [];
  const errors = [];

  // Refresh one model at a time, but allow the HTTP request to target a
  // specific model so a missing/failed model cannot surface stale data from
  // another model.
  const modelsToRefresh = Array.isArray(forceDate?.models)
    ? forceDate.models
    : Object.keys(CLIMATE_MODELS);

  for (const model of modelsToRefresh) {
    try {
      const archive = await fetchClimateArchive(model, historicalStartByModel(model), historicalEnd);
      const payload = await buildClimatePayload(model, parts, archive, recent);

      await env.GFS_DB.prepare(
        "INSERT INTO climate_cache (cache_key, model, period_date, payload_json, updated_at_utc) " +
        "VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(cache_key) DO UPDATE SET model=excluded.model, period_date=excluded.period_date, " +
        "payload_json=excluded.payload_json, updated_at_utc=excluded.updated_at_utc"
      ).bind(
        model + ":" + periodDate,
        model,
        periodDate,
        JSON.stringify(payload),
        payload.updated_at_utc
      ).run();

      results.push({
        model,
        period_date: periodDate,
        updated_at_utc: payload.updated_at_utc
      });
    } catch (error) {
      errors.push({
        model,
        error: String(error?.message || error),
      });
      console.error(JSON.stringify({
        event: "koy_climate_model_error",
        model,
        message: String(error?.message || error),
        period_date: periodDate,
      }));
    }
  }

  if (!results.length) {
    throw new Error("No climate models could be refreshed: " + JSON.stringify(errors));
  }

  return { ok: true, period_date: periodDate, models: results, errors };
}

async function getClimateCache(env, model = null) {
  if (model) {
    const row = await env.GFS_DB.prepare(
      "SELECT payload_json, updated_at_utc FROM climate_cache WHERE model = ? ORDER BY period_date DESC LIMIT 1"
    ).bind(model).first();
    return row?.payload_json ? JSON.parse(row.payload_json) : null;
  }

  const rows = await env.GFS_DB.prepare(
    "SELECT model, payload_json FROM climate_cache ORDER BY model, period_date DESC"
  ).all();
  const out = {};
  for (const row of rows.results || []) {
    if (!out[row.model] && row.payload_json) out[row.model] = JSON.parse(row.payload_json);
  }
  return out;
}


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

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; IstanbulHavasi/1.0; +https://istanbulunhavasi.com/)",
          "Accept": "application/json,text/plain,*/*",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
        },
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error("MeteoPT HTTP " + response.status + (body ? " · " + body.slice(0, 180) : ""));
      }

      const document = await response.json();
      const apiRun = String(document?.run || "").trim();
      if (!apiRun) throw new Error("MeteoPT returned no run id");

      return { apiRun, document, url: url.toString() };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error("MeteoPT request failed");
}

function findMeteoptModelDocument(value) {
  if (!value || typeof value !== "object") return null;
  const queue = [value];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current?.steps?.values) && current.steps.values.length && current?.data && typeof current.data === "object") return current;
    for (const child of Object.values(current)) if (child && typeof child === "object") queue.push(child);
  }
  return null;
}

function extractJsonObjectsFromHtml(html) {
  const candidates = [];
  const push = value => {
    const text = String(value || "").trim();
    if (!text) return;
    try { candidates.push(JSON.parse(text)); return; } catch (_) {}
    const first = text.search(/[{[]/);
    if (first < 0) return;
    const open = text[first], close = open === "{" ? "}" : "]";
    let depth = 0, quote = false, escaped = false;
    for (let i = first; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quote = false;
        continue;
      }
      if (ch === '"') { quote = true; continue; }
      if (ch === open) depth += 1;
      else if (ch === close && --depth === 0) {
        try { candidates.push(JSON.parse(text.slice(first, i + 1))); } catch (_) {}
        break;
      }
    }
  };
  const scripts = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scripts.exec(html))) push(match[1]);
  return candidates;
}

async function fetchMeteoptWebDocument() {
  const url = new URL(METEOPT_GFS_WEB);
  url.searchParams.set("lat", String(LOCATION.latitude));
  url.searchParams.set("lon", String(LOCATION.longitude));
  url.searchParams.set("lang", "en");
  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; IstanbulHavasi/1.0; +https://istanbulunhavasi.com/)",
      "Accept": "text/html,application/xhtml+xml",
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("MeteoPT web HTTP " + response.status);
  const html = await response.text();
  for (const candidate of extractJsonObjectsFromHtml(html)) {
    const document = findMeteoptModelDocument(candidate);
    if (document) return { apiRun: String(document.run || document.run_id || "").trim(), document, url: url.toString() };
  }
  throw new Error("MeteoPT GFS page contained no embedded model dataset");
}

async function fetchAvailableCycles() {
  const candidates = [];
  // Fetch all four available MeteoPT cycle selectors on every Cloudflare poll.
  // This deliberately keeps the previous three cycles available for the four-run
  // comparison instead of only persisting the newest cycle.
  const preferred = [6, ...CYCLES.filter(h => h !== 6)];
  const results = await Promise.allSettled(
    preferred.map(requestedHour => fetchCycle(requestedHour))
  );
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const requestedHour = preferred[i];
    if (result.status === "fulfilled") {
      candidates.push(result.value);
    } else {
      console.log(JSON.stringify({
        event: "meteopt_cycle_unavailable",
        requested_hour: requestedHour,
        message: String(result.reason?.message || result.reason),
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
    // MeteoPT's JSON backend can temporarily return HTTP 400/5xx while the
    // public GFS model page remains available. Do not let that outage stop
    // the ten-minute collector from updating D1. The public model page is
    // already the canonical source fallback used by the visitor endpoints.
    try {
      const webCandidate = await fetchMeteoptWebDocument();
      if (webCandidate?.document) {
        candidates.push(webCandidate);
      }
    } catch (webError) {
      console.warn(JSON.stringify({
        event: "meteopt_all_cycles_unavailable",
        message: String(webError?.message || webError),
      }));
    }
  }

  const finalUnique = new Map();
  for (const candidate of candidates) {
    const key = runKey(candidate.apiRun);
    if (key) finalUnique.set(key, candidate);
  }

  const finalSorted = [...finalUnique.values()].sort((a, b) =>
    runKey(b.apiRun).localeCompare(runKey(a.apiRun))
  );

  if (!finalSorted.length) {
    throw new Error("MeteoPT returned no usable GFS cycle and web fallback contained no model dataset");
  }

  return finalSorted;
}

async function fetchNewestCycle() {
  return (await fetchAvailableCycles())[0];
}

async function fetchNewestCycleWithWebFallback() {
  try {
    return await fetchNewestCycle();
  } catch (apiError) {
    console.warn(JSON.stringify({
      event: "koy_meteopt_api_unavailable",
      message: String(apiError?.message || apiError),
    }));
    return await fetchMeteoptWebDocument();
  }
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

const KOY_SVG_RENDERER_VERSION = "cloudflare-js-v10-f180-180h";
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

  // The newest cycle is the canonical forecast horizon. Do not intersect
  // the timeline with older cycles: an older archived cycle may legitimately
  // contain only F72 while the newest completed cycle contains F180. An
  // intersection would silently truncate the entire comparison chart to 72h.
  // Older cycles are still plotted wherever they have matching valid times;
  // beyond their stored horizon their series simply becomes null.
  const latestKeys = [...series[series.length - 1].points.keys()].sort();
  if (latestKeys.length < 2) throw new Error("The newest GFS cycle has fewer than two valid times");

  const firstMs = Date.parse(latestKeys[0] + ":00Z");
  const validKeys = latestKeys.filter(key => {
    const timestamp = Date.parse(key + ":00Z");
    return timestamp >= firstMs && timestamp <= firstMs + 180 * 3600000;
  });
  if (validKeys.length < 2) throw new Error("The newest GFS valid-time window is too short");

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
    '<metadata id="gfs-renderer-version">' + KOY_SVG_RENDERER_VERSION + '</metadata>',
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
  // The chart must use an F180-complete newest cycle. The f72 current record
  // is retained for backward compatibility, but during the short collection
  // window it can temporarily contain only the first 72 hours. In that case
  // use the newest F180-complete archived payload instead of publishing a
  // permanently truncated 72-hour comparison.
  let current = await currentRun(env, "f72");
  const currentMaxHour = Math.max(
    0,
    ...(Array.isArray(current?.payload?.forecast_6_hourly)
      ? current.payload.forecast_6_hourly.map(point => Number(point?.forecast_hour)).filter(Number.isFinite)
      : [])
  );

  if (!current?.payload?.run_id_utc || currentMaxHour < 180) {
    const latestFull = await env.GFS_DB.prepare(
      "SELECT run_id_utc, payload_json, published_at_utc FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 12"
    ).all();
    const fullRow = (latestFull.results || []).find(row => {
      try {
        const payload = JSON.parse(row.payload_json || "{}");
        const maxHour = Math.max(
          0,
          ...(Array.isArray(payload.forecast_6_hourly)
            ? payload.forecast_6_hourly.map(point => Number(point?.forecast_hour)).filter(Number.isFinite)
            : [])
        );
        return maxHour >= 180;
      } catch (_) {
        return false;
      }
    });
    if (fullRow?.payload_json) {
      current = {
        run_id_utc: fullRow.run_id_utc,
        payload: JSON.parse(fullRow.payload_json),
        updated_at_utc: fullRow.published_at_utc || null,
      };
    }
  }

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

  // Once an F180 payload exists, make it the canonical current payload BEFORE
  // rendering the comparison SVG. Previously the SVG was published while
  // gfs_current still contained the temporary F72 payload, which truncated
  // the newest chart series to 72 hours and left that stale SVG published.
  if (normalized.full) {
    f72Changed = await persistF72(env, normalized.full) || f72Changed;
  }

  // Render the four-cycle interactive SVG in this Worker and keep the canonical copy in D1.
  // A rendering problem must not interrupt the successful GFS data collection.
  if (archivedRunsChanged > 0 || f72Changed || f180Changed) {
    try {
      comparisonSvgPublished = Boolean(await publishLatestKoySvg(env));
    } catch (error) {
      console.error(JSON.stringify({
        event: "koy_gfs_svg_publish_error",
        message: String(error?.message || error),
      }));
    }
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

  if (path === "/api/climate") {
    try {
      const model = new URL(request.url).searchParams.get("model") || null;
      if (model && !CLIMATE_MODELS[model]) {
        return json({ ok: false, error: "Unknown climate model" }, 400);
      }

      // Climate data is populated exclusively by the isolated
      // GitHub Actions workflow. The public Worker never calls the
      // multi-decade Open-Meteo archive API on a visitor request.
      const data = await getClimateCache(env, model);

      if (!data) {
        return json({
          ok: false,
          error: "Climate cache unavailable for model " + (model || "all"),
        }, 503);
      }

      return json({
        ok: true,
        schema: "koy-climate.v1",
        location: LOCATION,
        data,
        source: "Open-Meteo historical baseline + current-month observations · cached in Cloudflare D1",
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
        cron: ["*/10 * * * *", "30 1 * * *"],
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
      const sourceUrl = METEOPT_GFS_WEB + "?lat=" + LOCATION.latitude + "&lon=" + LOCATION.longitude;
      const isCompletedF180 = payload => {
        const points = Array.isArray(payload?.forecast_6_hourly) ? payload.forecast_6_hourly : [];
        return payload?.forecast_source === "meteopt" &&
          points.some(point => Number(point?.forecast_hour) >= 180);
      };

      // The ten-minute Cron is the collector. Visitor requests read its latest
      // completed MeteoPT run from D1 first, so a temporary upstream outage or
      // a slow model page cannot blank the public Köy table.
      const current = await currentRun(env, "f72");
      if (isCompletedF180(current?.payload)) {
        return json({
          ...current.payload,
          source_url: sourceUrl,
          source_page: sourceUrl,
          source_backend: API_BASE,
          source_mode: "meteopt-cached",
          source_cached_at_utc: current.updated_at_utc || current.payload.published_at_utc || null,
        });
      }

      // Older completed cycles remain available in the archive if the current
      // record has not reached F180 yet. Search forecast hours, not a fixed
      // array index: MeteoPT may use different forecast-step intervals.
      const archiveResult = await env.GFS_DB.prepare(
        "SELECT run_id_utc, payload_json, published_at_utc FROM gfs_runs " +
        "ORDER BY run_id_utc DESC LIMIT 30"
      ).all();
      const cachedRow = (archiveResult.results || []).find(row => {
        try {
          return isCompletedF180(JSON.parse(row.payload_json || "{}"));
        } catch (_) {
          return false;
        }
      }) || null;
      if (cachedRow?.payload_json) {
        return json({
          ...JSON.parse(cachedRow.payload_json),
          source_url: sourceUrl,
          source_page: sourceUrl,
          source_backend: API_BASE,
          source_mode: "meteopt-cached",
          source_cached_at_utc: cachedRow.published_at_utc || null,
        });
      }

      // Cold-start only: fetch the exact MeteoPT location through its data
      // backend, with the exact public model page retained as source metadata.
      const candidate = await fetchNewestCycleWithWebFallback();
      const normalized = normalizeDocument(candidate, new Date());
      if (!isCompletedF180(normalized.full)) {
        throw new Error("MeteoPT current run is not F180-ready and no completed archive exists");
      }
      return json({
        ...normalized.full,
        source_url: sourceUrl,
        source_page: sourceUrl,
        source_backend: candidate.url,
        source_mode: "live-meteopt",
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "koy_f180_endpoint_error",
        message: String(error?.message || error),
      }));
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/f72") {
    let current = null;
    try {
      current = await currentRun(env, "f72");
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
        try {
          await collect(env);
          current = await currentRun(env, "f72");
        } catch (collectError) {
          // A live MeteoPT/D1 refresh failure must not turn an already valid
          // canonical F72 payload into an HTTP 503. The live F180 table has
          // its own endpoint; this legacy F72 gateway is allowed to serve the
          // last complete canonical MeteoPT snapshot during a transient outage.
          if (current?.payload) {
            console.warn(JSON.stringify({
              event: "koy_f72_refresh_fallback",
              message: String(collectError?.message || collectError),
              run_id_utc: current.run_id_utc || null,
            }));
          } else {
            throw collectError;
          }
        }
      }

      if (!current) {
        // Cold-start fallback: first try the canonical completed archive, then
        // serve a freshly normalized MeteoPT cycle directly. The public F72
        // endpoint must not depend on a successful D1 write to expose MeteoPT.
        const archived = await env.GFS_DB.prepare(
          "SELECT run_id_utc, payload_json, published_at_utc FROM gfs_runs " +
          "ORDER BY run_id_utc DESC LIMIT 1"
        ).first();
        if (archived?.payload_json) {
          const payload = JSON.parse(archived.payload_json);
          return json({
            ...payload,
            source_mode: "meteopt-archived",
            source_cached_at_utc: archived.published_at_utc || null,
          });
        }

        // At 17:55 UTC the 12Z cycle is the expected completed/current cycle.
        // Keep this direct path independent of the collector's D1 publication.
        for (const cycle of [12, 6, 18, 0]) {
          try {
            const candidate = await fetchCycle(cycle);
            const normalized = normalizeDocument(candidate, new Date());
            if (normalized.f72) {
              return json({
                ...normalized.f72,
                source_mode: "live-meteopt",
                source_url: METEOPT_GFS_WEB + "?lat=" + LOCATION.latitude + "&lon=" + LOCATION.longitude,
                source_page: METEOPT_GFS_WEB + "?lat=" + LOCATION.latitude + "&lon=" + LOCATION.longitude,
                source_backend: candidate.url,
              });
            }
          } catch (directError) {
            console.warn(JSON.stringify({
              event: "koy_f72_direct_meteopt_fallback_failed",
              requested_cycle: cycle,
              message: String(directError?.message || directError),
            }));
          }
        }

        // The exact MeteoPT GFS model page is the canonical source. If its
        // JSON backend is unreachable from the Worker, use the page itself
        // rather than returning a false "no data" response.
        try {
          const webCandidate = await fetchMeteoptWebDocument();
          const normalized = normalizeDocument(webCandidate, new Date());
          if (normalized.f72) {
            return json({
              ...normalized.f72,
              source_mode: "live-meteopt-web",
              source_url: webCandidate.url,
              source_page: webCandidate.url,
              source_backend: webCandidate.url,
            });
          }
        } catch (webError) {
          console.warn(JSON.stringify({
            event: "koy_f72_web_meteopt_fallback_failed",
            message: String(webError?.message || webError),
          }));
        }

        return json({ ok: false, error: "MeteoPT F72 data is not available yet" }, 404);
      }
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

      // If the comparison archive is incomplete, fetch all currently available
      // MeteoPT cycles before replying.
      let current = await currentRun(env, "f72");
      if (runs.length < 4 || !current) {
        try {
          await collect(env);
          result = await env.GFS_DB.prepare(
            "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
          ).all();
          runs = (result.results || []).map(row => JSON.parse(row.payload_json));
          current = await currentRun(env, "f72");
        } catch (collectError) {
          // Do not turn an existing canonical archive into a 503 when MeteoPT
          // is temporarily unavailable. The archive is still MeteoPT-derived.
          console.warn(JSON.stringify({
            event: "koy_comparison_collect_fallback",
            message: String(collectError?.message || collectError),
            archived_runs: runs.length,
          }));
        }
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
        ok: true,
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
    const cron = controller.cron || "";
    const scheduledTime = new Date(controller.scheduledTime);
    const logError = (event, error) => console.error(JSON.stringify({
      event,
      message: String(error?.message || error),
      scheduled_time: scheduledTime.toISOString(),
    }));

    if (cron === NIGHTLY_CRON) {
      // 04:30 Europe/Istanbul: refresh CERRA, ERA5 and ERA5-Land inside Cloudflare.
      ctx.waitUntil(
        refreshClimateAll(env, scheduledTime)
          .then(result => console.log(JSON.stringify({ event: "koy_climate_nightly", ...result })))
          .catch(error => logError("koy_climate_nightly_error", error))
      );
      return;
    }

    ctx.waitUntil(collect(env).catch(error => logError("koy_gfs_cron_error", error)));
    // Self-healing: finish any model whose nightly refresh failed or was rate limited.
    ctx.waitUntil(
      climateTick(env, scheduledTime)
        .then(result => {
          if (!result.idle) console.log(JSON.stringify({ event: "koy_climate_tick", ...result }));
        })
        .catch(error => logError("koy_climate_tick_error", error))
    );
  },
};
