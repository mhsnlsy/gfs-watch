import fs from "node:fs";
import path from "node:path";

const LOCATION = { latitude: 40.9557, longitude: 39.0065, name: "Giresun / Çanakçı" };
const MODELS = {
  cerra: {
    label: "CERRA",
    resolution: "5.5 KM",
    startYear: 1985,
    endYear: 2020,
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "temperature_2m_mean",
      "precipitation_sum",
      "wind_speed_10m_mean",
      "wind_gusts_10m_max",
    ],
    supportsPrecip: true,
    supportsWind: true,
  },
  era5: {
    label: "ERA5",
    resolution: "~31 KM",
    startYear: 1940,
    endYear: null,
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "temperature_2m_mean",
      "precipitation_sum",
      "wind_speed_10m_mean",
      "wind_gusts_10m_max",
    ],
    supportsPrecip: true,
    supportsWind: true,
  },
  era5_land: {
    label: "ERA5-LAND",
    resolution: "~9 KM",
    startYear: 1950,
    endYear: null,
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "temperature_2m_mean",
    ],
    supportsPrecip: false,
    supportsWind: false,
  },
};

function istanbulParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const out = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

function dateKey(p) {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function archiveUrl(model, start, end) {
  const cfg = MODELS[model];
  return "https://archive-api.open-meteo.com/v1/archive"
    + "?latitude=" + LOCATION.latitude
    + "&longitude=" + LOCATION.longitude
    + "&start_date=" + start
    + "&end_date=" + end
    + "&daily=" + encodeURIComponent(cfg.daily.join(","))
    + "&models=" + encodeURIComponent(model)
    + "&timezone=Europe/Istanbul";
}

async function fetchJson(url, label, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; IstanbulHavasi-KoyClimate/1.0; +https://istanbulunhavasi.com/)",
          "Accept": "application/json",
          "Cache-Control": "no-cache",
        },
        signal: AbortSignal.timeout(120000),
      });
      if (response.ok) return await response.json();
      const body = await response.text().catch(() => "");
      lastError = new Error(`${label}: HTTP ${response.status}${body ? " · " + body.slice(0, 180) : ""}`);
      if (response.status < 500 && response.status !== 429) throw lastError;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      const delay = Math.min(30000, 2000 * attempt * attempt);
      console.log(`[${label}] retry ${attempt + 1}/${attempts} after ${delay} ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError || new Error(`${label}: request failed`);
}

function rows(document) {
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

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function sql(value) {
  return "'" + String(value ?? "").replaceAll("'", "''") + "'";
}

async function main() {
  const parts = istanbulParts();
  const periodDate = dateKey(parts);
  const month = parts.month;
  const currentYear = parts.year;

  console.log(`Köy climate refresh: ${periodDate}`);

  const recentUrl = "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + LOCATION.latitude
    + "&longitude=" + LOCATION.longitude
    + "&past_days=31&forecast_days=1"
    + "&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,wind_speed_10m_mean,wind_gusts_10m_max"
    + "&timezone=Europe/Istanbul";

  const recent = await fetchJson(recentUrl, "Forecast API");
  const recentRows = rows(recent);
  const monthRows = recentRows.filter(r =>
    r.year === currentYear && r.month === month && r.day <= parts.day
  );

  const statements = [
    "CREATE TABLE IF NOT EXISTS climate_cache (cache_key TEXT PRIMARY KEY, model TEXT NOT NULL, period_date TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at_utc TEXT NOT NULL);",
  ];

  for (const [model, cfg] of Object.entries(MODELS)) {
    const historicalEndYear = cfg.endYear ?? (currentYear - 1);
    const start = `${cfg.startYear}-01-01`;
    const end = `${historicalEndYear}-12-31`;

    console.log(`[${model}] downloading ${start} -> ${end}`);
    const archive = await fetchJson(archiveUrl(model, start, end), `${model} archive`, 6);
    const allRows = rows(archive);
    const historical = allRows.filter(r =>
      r.month === month && r.year < currentYear && r.mean !== null
    );

    if (!historical.length) throw new Error(`${model}: no historical ${month} data returned`);

    const monthlyHistory = new Map();
    for (const r of allRows.filter(r => r.month === month && r.year < currentYear)) {
      monthlyHistory.set(r.year, (monthlyHistory.get(r.year) || 0) + (r.precip || 0));
    }

    const monthPrecip = cfg.supportsPrecip
      ? monthRows.reduce((sum, r) => sum + (r.precip || 0), 0)
      : null;
    const normalPrecip = cfg.supportsPrecip ? average([...monthlyHistory.values()]) : null;
    const anomaly = cfg.supportsPrecip && normalPrecip
      ? ((monthPrecip - normalPrecip) / normalPrecip) * 100
      : null;

    const means = historical.map(r => r.mean).filter(Number.isFinite);
    const min = Math.min(...means);
    const max = Math.max(...means);
    const avg = average(means);
    const minRow = historical.find(r => r.mean === min);
    const maxRow = historical.find(r => r.mean === max);
    const today = monthRows.find(r => r.year === currentYear && r.day === parts.day) || null;
    const record = historical.reduce((best, r) => !best || r.precip > best.precip ? r : best, null);

    const payload = {
      schema: "koy-climate.v1",
      location: LOCATION,
      model,
      model_label: cfg.label,
      resolution: cfg.resolution,
      period_date: periodDate,
      month_name: new Intl.DateTimeFormat("en-US", {
        month: "long",
        timeZone: "Europe/Istanbul",
      }).format(new Date(Date.UTC(currentYear, month - 1, 1))).toUpperCase(),
      month_readings_through_day: parts.day,
      historical_start_year: Math.min(...historical.map(r => r.year)),
      historical_end_year: Math.max(...historical.map(r => r.year)),
      month: {
        avg_temp_c: round(average(monthRows.map(r => r.mean).filter(Number.isFinite))),
        high_c: monthRows.some(r => Number.isFinite(r.max)) ? round(Math.max(...monthRows.map(r => r.max).filter(Number.isFinite))) : null,
        low_c: monthRows.some(r => Number.isFinite(r.min)) ? round(Math.min(...monthRows.map(r => r.min).filter(Number.isFinite))) : null,
        precipitation_mm: cfg.supportsPrecip ? round(monthPrecip) : null,
        avg_wind_kmh: cfg.supportsWind ? round(average(monthRows.map(r => r.windMean).filter(Number.isFinite))) : null,
        max_wind_kmh: cfg.supportsWind ? round(monthRows.reduce((m, r) => r.windMax == null ? m : Math.max(m, r.windMax), -Infinity)) : null,
      },
      long_term: {
        min_c: round(min),
        min_year: minRow?.year ?? null,
        avg_c: round(avg),
        max_c: round(max),
        max_year: maxRow?.year ?? null,
        current_temperature_c: null,
        today_mean_c: round(today?.mean),
        today_precipitation_mm: round(today?.precip || 0),
        record_daily_precipitation_mm: round(record?.precip),
        record_daily_precipitation_year: record?.year ?? null,
      },
      precipitation_anomaly: {
        current_mm: round(monthPrecip),
        normal_mm: round(normalPrecip),
        percent: round(anomaly),
      },
      updated_at_utc: new Date().toISOString(),
    };

    const cacheKey = `${model}:${periodDate}`;
    statements.push(
      "INSERT INTO climate_cache (cache_key, model, period_date, payload_json, updated_at_utc) VALUES (" +
      [cacheKey, model, periodDate, JSON.stringify(payload), payload.updated_at_utc].map(sql).join(", ") +
      ") ON CONFLICT(cache_key) DO UPDATE SET model=excluded.model, period_date=excluded.period_date, payload_json=excluded.payload_json, updated_at_utc=excluded.updated_at_utc;"
    );

    console.log(JSON.stringify({
      model,
      historical_years: [payload.historical_start_year, payload.historical_end_year],
      historical_days: historical.length,
      period_date: periodDate,
    }));
  }

  const out = path.join(process.cwd(), "koy-climate-refresh.sql");
  fs.writeFileSync(out, "BEGIN;\n" + statements.join("\n") + "\nCOMMIT;\n");
  console.log(`Wrote ${out}`);
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
