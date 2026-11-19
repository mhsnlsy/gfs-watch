import fs from "node:fs";
import path from "node:path";

const LOCATION = {
  latitude: 40.9557,
  longitude: 39.0065,
  name: "Giresun / Çanakçı",
};
const MODELS = {
  cerra: {
    label: "CERRA",
    resolution: "5 km",
    startYear: 1985,
    supportsPrecip: true,
    supportsWind: true,
    daily: [
      "temperature_2m_mean",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "wind_speed_10m_mean",
      "wind_speed_10m_max",
    ],
  },
  era5: {
    label: "ERA5",
    resolution: "~25 km",
    startYear: 1940,
    supportsPrecip: true,
    supportsWind: true,
    daily: [
      "temperature_2m_mean",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "wind_speed_10m_mean",
      "wind_speed_10m_max",
    ],
  },
  era5_land: {
    label: "ERA5-Land",
    resolution: "~11 km",
    startYear: 1950,
    supportsPrecip: false,
    supportsWind: false,
    daily: [
      "temperature_2m_mean",
      "temperature_2m_max",
      "temperature_2m_min",
    ],
  },
};

function istanbulParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const result = {};
  for (const part of parts) {
    if (part.type !== "literal") result[part.type] = Number(part.value);
  }
  return result;
}

function dateKey(parts) {
  return [
    parts.year,
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

let lastArchiveRequestAt = 0;
const ARCHIVE_MIN_INTERVAL_MS = 4500;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForArchiveSlot() {
  const waitMs = Math.max(0, lastArchiveRequestAt + ARCHIVE_MIN_INTERVAL_MS - Date.now());
  if (waitMs > 0) await delay(waitMs);
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function historicalEndYear(model, month, currentYear) {
  const configured = MODELS[model];
  // Open-Meteo documents CERRA through June 2021. For July–December,
  // the final complete calendar month available is in 2020.
  const modelLastYear = model === "cerra" ? (month <= 6 ? 2021 : 2020) : currentYear - 1;
  return Math.min(currentYear - 1, modelLastYear);
}

function archiveUrl(model, startDate, endDate) {
  const config = MODELS[model];
  const params = new URLSearchParams({
    latitude: String(LOCATION.latitude),
    longitude: String(LOCATION.longitude),
    start_date: startDate,
    end_date: endDate,
    daily: config.daily.join(","),
    models: model,
    timezone: "Europe/Istanbul",
  });
  return "https://archive-api.open-meteo.com/v1/archive?" + params.toString();
}

async function fetchJson(url, label, attempts = 5) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await waitForArchiveSlot();
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; IstanbulHavasi-KoyClimate/2.0; +https://istanbulunhavasi.com/)",
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(90000),
      });
      lastArchiveRequestAt = Date.now();
      if (response.ok) return await response.json();

      const detail = await response.text().catch(() => "");
      lastError = new Error(
        label + ": HTTP " + response.status + (detail ? " · " + detail.slice(0, 240) : "")
      );
      if (response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get("Retry-After"));
        const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? (retryAfterSeconds + 5) * 1000
          : 65000;
        console.warn("[" + label + "] rate limited; retrying after " + Math.round(waitMs / 1000) + " s");
        if (attempt < attempts) await delay(waitMs);
        continue;
      }
      if (response.status < 500) throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      // 429 is handled above with the server-provided/minute-long delay.
      if (String(error?.message || error).includes("HTTP 429")) continue;
    }

    if (attempt < attempts) {
      const waitMs = Math.min(30000, 5000 * (2 ** (attempt - 1)));
      console.warn("[" + label + "] retry " + (attempt + 1) + "/" + attempts + " after " + waitMs + " ms");
      await delay(waitMs);
    }
  }
  throw lastError || new Error(label + ": request failed");
}

function parseRows(document, model) {
  const daily = document?.daily;
  if (!daily || !Array.isArray(daily.time) || !daily.time.length) {
    throw new Error(model + ": archive response does not contain daily rows");
  }

  const config = MODELS[model];
  return daily.time.map((date, index) => ({
    date,
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
    mean: numberOrNull(daily.temperature_2m_mean?.[index]),
    max: numberOrNull(daily.temperature_2m_max?.[index]),
    min: numberOrNull(daily.temperature_2m_min?.[index]),
    precipitation: config.supportsPrecip
      ? numberOrNull(daily.precipitation_sum?.[index])
      : null,
    windMean: config.supportsWind
      ? numberOrNull(daily.wind_speed_10m_mean?.[index])
      : null,
    windMax: config.supportsWind
      ? numberOrNull(daily.wind_speed_10m_max?.[index])
      : null,
  }));
}

async function downloadHistoricalMonth(model, month, currentYear) {
  const config = MODELS[model];
  const endYear = historicalEndYear(model, month, currentYear);
  if (endYear < config.startYear) {
    throw new Error(model + ": no historical period is available for this month");
  }

  const monthText = String(month).padStart(2, "0");
  const lastDay = daysInMonth(currentYear, month);
  const documents = [];
  const chunkYears = 25;

  // Small, sequential calendar-month windows avoid large multi-decade
  // responses and reduce upstream 503/429 pressure.
  for (let year = config.startYear; year <= endYear; year += chunkYears) {
    const chunkEndYear = Math.min(year + chunkYears - 1, endYear);
    const start = String(year) + "-" + monthText + "-01";
    const end = String(chunkEndYear) + "-" + monthText + "-" + String(lastDay).padStart(2, "0");
    console.log("[" + model + "] downloading " + start + " -> " + end);
    const document = await fetchJson(
      archiveUrl(model, start, end),
      model + " " + start + "…" + end
    );
    documents.push(...parseRows(document, model));
  }

  const rows = documents
    .filter(row => row.month === month && row.year <= endYear)
    .sort((a, b) => a.date.localeCompare(b.date));

  const uniqueRows = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.date)) continue;
    seen.add(row.date);
    uniqueRows.push(row);
  }

  if (!uniqueRows.length) throw new Error(model + ": no daily values returned for month " + monthText);
  return { rows: uniqueRows, endYear };
}

function precipitationNormalToDate(rows, dayOfMonth) {
  const perYear = new Map();
  for (const row of rows) {
    if (row.day > dayOfMonth || row.precipitation === null) continue;
    if (!perYear.has(row.year)) perYear.set(row.year, { total: 0, days: 0 });
    const year = perYear.get(row.year);
    year.total += row.precipitation;
    year.days += 1;
  }

  const expectedDays = dayOfMonth;
  const eligible = [...perYear.values()]
    .filter(value => value.days >= Math.max(1, Math.ceil(expectedDays * 0.9)))
    .map(value => value.total);

  return {
    normal: average(eligible),
    years: eligible.length,
  };
}

function buildPayload(model, parts, downloaded) {
  const config = MODELS[model];
  const currentDate = dateKey(parts);
  const currentDayRows = downloaded.rows.filter(row =>
    row.month === parts.month && row.day === parts.day && row.mean !== null
  );

  if (!currentDayRows.length) {
    throw new Error(model + ": no historical data for calendar day " + currentDate.slice(5));
  }

  const dayMeans = currentDayRows.map(row => row.mean).filter(Number.isFinite);
  const min = Math.min(...dayMeans);
  const max = Math.max(...dayMeans);
  const minRow = currentDayRows.find(row => row.mean === min);
  const maxRow = currentDayRows.find(row => row.mean === max);
  const sameDayPrecip = config.supportsPrecip
    ? currentDayRows.filter(row => row.precipitation !== null)
    : [];
  const record = sameDayPrecip.reduce(
    (best, row) => !best || row.precipitation > best.precipitation ? row : best,
    null
  );
  const precipNormal = config.supportsPrecip
    ? precipitationNormalToDate(downloaded.rows, parts.day)
    : { normal: null, years: 0 };

  const historyYears = [...new Set(downloaded.rows.map(row => row.year))].sort((a, b) => a - b);
  const monthName = new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "Europe/Istanbul",
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, 1))).toUpperCase();

  const payload = {
    schema: "koy-climate.v2",
    location: LOCATION,
    model,
    model_label: config.label,
    resolution: config.resolution,
    source: "Open-Meteo Historical Weather API",
    period_date: currentDate,
    month_name: monthName,
    month_readings_through_day: parts.day,
    historical_start_year: historyYears[0],
    historical_end_year: historyYears[historyYears.length - 1],
    historical_year_count: historyYears.length,
    historical_day_sample_count: dayMeans.length,
    supported: {
      temperature: true,
      precipitation: config.supportsPrecip,
      wind: config.supportsWind,
    },
    long_term: {
      min_c: round(min),
      min_year: minRow?.year ?? null,
      avg_c: round(average(dayMeans)),
      max_c: round(max),
      max_year: maxRow?.year ?? null,
      current_temperature_c: null,
      today_mean_c: null,
      today_precipitation_mm: null,
      record_daily_precipitation_mm: record ? round(record.precipitation) : null,
      record_daily_precipitation_year: record?.year ?? null,
    },
    precipitation_normal_to_date: {
      normal_mm: round(precipNormal.normal),
      years: precipNormal.years,
      through_day: parts.day,
    },
    // Preserve the actual per-day, per-year archive slice in D1 so the
    // three datasets remain independently inspectable and reusable.
    daily_history: downloaded.rows.map(row => ({
      date: row.date,
      year: row.year,
      day: row.day,
      mean_c: round(row.mean),
      max_c: round(row.max),
      min_c: round(row.min),
      precipitation_mm: round(row.precipitation),
      average_wind_kmh: round(row.windMean),
      max_wind_kmh: round(row.windMax),
    })),
    updated_at_utc: new Date().toISOString(),
  };

  if (!Number.isFinite(payload.long_term.avg_c)) {
    throw new Error(model + ": calculated long-term daily mean is not numeric");
  }
  if (config.supportsPrecip && !Number.isFinite(payload.precipitation_normal_to_date.normal_mm)) {
    throw new Error(model + ": precipitation normal-to-date could not be calculated");
  }
  return payload;
}

function sqlLiteral(value) {
  return "'" + String(value ?? "").replaceAll("'", "''") + "'";
}

async function main() {
  const parts = istanbulParts();
  const periodDate = dateKey(parts);
  console.log("Köy climate refresh: " + periodDate);

  const payloads = [];
  for (const model of Object.keys(MODELS)) {
    const downloaded = await downloadHistoricalMonth(model, parts.month, parts.year);
    const payload = buildPayload(model, parts, downloaded);
    payloads.push(payload);
    console.log(JSON.stringify({
      model,
      period_date: payload.period_date,
      history_years: [payload.historical_start_year, payload.historical_end_year],
      historical_year_count: payload.historical_year_count,
      historical_same_day_samples: payload.historical_day_sample_count,
      daily_history_rows: payload.daily_history.length,
      precipitation_supported: payload.supported.precipitation,
      wind_supported: payload.supported.wind,
      precipitation_normal_to_date_mm: payload.precipitation_normal_to_date.normal_mm,
    }));
  }

  if (payloads.length !== 3 || new Set(payloads.map(item => item.model)).size !== 3) {
    throw new Error("Refusing to publish: all three independent model payloads are required");
  }

  // One multi-row INSERT is a single atomic D1 statement. D1 does not accept
  // manual BEGIN/COMMIT statements in an import file.
  const values = payloads.map(payload => "(" + [
    payload.model + ":" + periodDate,
    payload.model,
    periodDate,
    JSON.stringify(payload),
    payload.updated_at_utc,
  ].map(sqlLiteral).join(", ") + ")");

  const sql = [
    "INSERT INTO climate_cache (cache_key, model, period_date, payload_json, updated_at_utc)",
    "VALUES",
    values.join(",\n"),
    "ON CONFLICT(cache_key) DO UPDATE SET",
    "model=excluded.model,",
    "period_date=excluded.period_date,",
    "payload_json=excluded.payload_json,",
    "updated_at_utc=excluded.updated_at_utc;",
  ].join("\n");

  const output = path.join(process.cwd(), "koy-climate-refresh.sql");
  fs.writeFileSync(output, sql + "\n");
  console.log("Wrote one atomic D1 statement: " + output);
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
