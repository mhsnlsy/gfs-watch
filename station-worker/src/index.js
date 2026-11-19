import {
  ENKA_CAMERA_URL,
  observationFromCameraReading,
  recognizeCameraOverlay,
  recognizeCameraOverlayWithAI,
  shouldUseCameraFallback
} from "./enka-camera.js";

const STATION_DEFS = {
  enka: {
    station_id: "ENKA-BALMUMCU-WEATHERLINK",
    station_name: "ENKA Balmumcu",
    source: "ENKA WeatherLink current values",
    source_url: "https://w.enka.com/weather/currentvalues.html"
  },
  eyupsultan: {
    station_id: "18101",
    station_name: "MGM Eyüpsultan",
    source: "MGM İstanbul-Eyüpsultan 18101",
    source_url: "https://www.mgm.gov.tr/tahmin/il-ve-ilceler.aspx?il=istanbul&ilce=eyupsultan"
  },
  sisli: {
    station_id: "18401",
    station_name: "MGM Şişli",
    source: "MGM İstanbul-Şişli 18401",
    source_url: "https://www.mgm.gov.tr/tahmin/il-ve-ilceler.aspx?il=istanbul&ilce=sisli"
  },
  canakci: {
    station_id: "CANAKCI-DYNAMIC",
    station_name: "MGM Çanakçı",
    source: "MGM Giresun-Çanakçı",
    source_url: "https://www.mgm.gov.tr/tahmin/il-ve-ilceler.aspx?il=Giresun&ilce=Çanakçı"
  }
};
const RETENTION_HOURS = null;
const MAX_SOURCE_AGE_MINUTES = 20;
const MAX_HISTORY_HOURS = 384; // 16 günlük GFS doğrulama penceresi

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) && n > -900 ? n : null;
}
function round(value, digits = 1) {
  if (value === null || !Number.isFinite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}
function parseDate(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}
function ageMinutes(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.max(0, (now - t) / 60000) : null;
}
function windCardinal(degrees) {
  if (degrees === null || !Number.isFinite(degrees)) return null;
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.floor((((degrees % 360) + 360) % 360 + 11.25) / 22.5) % 16];
}
function feelsLike(tempC, humidity, windKmh) {
  if (!Number.isFinite(tempC)) return null;
  const rh = Number.isFinite(humidity) ? Math.max(0, Math.min(100, humidity)) : 50;
  const windMs = Number.isFinite(windKmh) ? Math.max(0, windKmh / 3.6) : 0;
  // Australian Apparent Temperature (Steadman, shade, Q=0).
  const e = (rh / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
  const at = tempC + 0.348 * e - 0.7 * windMs - 4.25;
  return Number.isFinite(at) ? round(at, 1) : null;
}

function dewPoint(temp, humidity) {
  if (temp === null || humidity === null || humidity <= 0 || humidity > 100) return null;
  const a = 17.27, b = 237.7;
  const g = Math.log(humidity / 100) + (a * temp) / (b + temp);
  const dp = (b * g) / (a - g);
  return Number.isFinite(dp) ? round(dp, 1) : null;
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; IstanbulHavasiStations/1.0)",
        "Cache-Control": "no-cache, no-store, max-age=0",
        "Pragma": "no-cache",
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error("HTTP " + response.status + " · " + url);
    return response;
  } finally {
    clearTimeout(timer);
  }
}
function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&deg;|&#176;/gi, "°")
    .replace(/&/gi, "&")
    .replace(/"/gi, '"')
    .replace(/&#39;|'/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
function stripHtml(value) {
  return decodeHtml(String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}
function cellRows(html) {
  const rows = [];
  const tr = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = tr.exec(html))) {
    const cells = [];
    const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let cell;
    while ((cell = cellRe.exec(row[1]))) cells.push(stripHtml(cell[2]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}
function parseEnkaTimestamp(html) {
  const text = stripHtml(html);
  const match = text.match(/As\s+of\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*\(\s*UTC\s*([+-]\d{1,2}:\d{2})?\s*\)/i)
    || text.match(/As\s+of\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})/i);
  if (!match) throw new Error("ENKA ölçüm zaman damgası bulunamadı");
  const day = Number(match[1]), month = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  const hour = Number(match[4]), minute = Number(match[5]);
  let offsetMinutes = 180;
  if (match[6]) {
    const raw = match[6].trim();
    const sign = raw.startsWith("-") ? -1 : 1;
    const digits = raw.replace(/[+-]/, "").split(":");
    offsetMinutes = sign * (Number(digits[0]) * 60 + Number(digits[1]));
  }
  const stamp = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60000;
  const d = new Date(stamp);
  if (!Number.isFinite(d.getTime())) throw new Error("ENKA ölçüm zamanı geçersiz");
  return d.toISOString();
}
function enkaCurrentCell(rows, label) {
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let currentColumn = -1;
  for (const row of rows) {
    const ix = row.findIndex(cell => norm(cell) === "current value");
    if (ix >= 0) { currentColumn = ix; break; }
  }
  const wanted = norm(label);
  for (const row of rows) {
    const labelIndex = row.findIndex(cell => norm(cell).includes(wanted));
    if (labelIndex < 0) continue;
    if (currentColumn >= 0 && row[currentColumn] !== undefined && currentColumn !== labelIndex) {
      return row[currentColumn];
    }
    return row[row.length - 1];
  }
  return null;
}
function valueMatch(cell, regex, label, fallbackText) {
  const match = String(cell || "").match(regex) || String(fallbackText || "").match(regex);
  if (!match) throw new Error("ENKA " + label + " Current Value alanı okunamadı");
  return match;
}
async function fetchEnkaWeatherLink() {
  // ENKA WeatherLink is live again. Poll the current-values endpoint directly,
  // bypassing intermediate caches, and retry transient upstream failures.
  const baseUrl = "https://w.enka.com/weather/currentvalues.html";
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const url = baseUrl + "?_station_poll=" + Date.now() + "-" + attempt;
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache, no-store, max-age=0",
          "Pragma": "no-cache",
          "Referer": "https://w.enka.com/weather/",
          "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch-Stations/1.0)"
        }
      }, 18000);
      if (!response.ok) throw new Error("ENKA HTTP " + response.status);
      const html = await response.text();
      if (!html || html.length < 200) throw new Error("ENKA current-values boş/eksik yanıt döndürdü");
      const rows = cellRows(html);
      const plain = stripHtml(html);
      const observedAt = parseEnkaTimestamp(html);
  const tempCell = enkaCurrentCell(rows, "Day Temperature");
  const pressureCell = enkaCurrentCell(rows, "Barometer (hPa)");
  const humidityCell = enkaCurrentCell(rows, "Humidity");
  const windCell = enkaCurrentCell(rows, "Wind");
  const dailyRainCell = enkaCurrentCell(rows, "Daily Rain");
  const tempMatch = valueMatch(tempCell, /([-+]?\d+(?:[.,]\d+)?)\s*[\u00B0\uFFFD]?\s*C/i, "Day Temperature", plain);
  const pressureMatch = valueMatch(pressureCell, /(\d{3,4}(?:[.,]\d+)?)\s*(?:hPa)?/i, "Barometer", plain);
  const humidityMatch = valueMatch(humidityCell, /(\d{1,3}(?:[.,]\d+)?)\s*%/i, "Humidity", plain);
  const windMatch = valueMatch(windCell, /\b(NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW|N|NE|E|SE|S|SW|W|NW)\b\s*(\d+(?:[.,]\d+)?)\s*kt\b/i, "Wind", plain);
  const dailyRainMatch = String(dailyRainCell || plain).match(/(\d+(?:[.,]\d+)?)\s*mm/i);
  const temperature = Number(tempMatch[1].replace(",", "."));
  const pressure = Number(pressureMatch[1].replace(",", "."));
  const humidity = Number(humidityMatch[1].replace(",", "."));
  const knots = Number(windMatch[2].replace(",", "."));
  if (!Number.isFinite(temperature) || temperature < -50 || temperature > 60) throw new Error("ENKA sıcaklığı geçersiz");
  if (!Number.isFinite(pressure) || pressure < 800 || pressure > 1100) throw new Error("ENKA basıncı geçersiz");
  if (!Number.isFinite(humidity) || humidity < 0 || humidity > 100) throw new Error("ENKA nemi geçersiz");
  if (!Number.isFinite(knots) || knots < 0 || knots > 150) throw new Error("ENKA rüzgârı geçersiz");
  const age = ageMinutes(observedAt);
  if (age === null || age > 24 * 60 || age < -5) throw new Error("ENKA ölçüm zamanı doğrulanamadı veya 24 saatten eski");
  return {
    station_id: STATION_DEFS.enka.station_id,
    station_name: STATION_DEFS.enka.station_name,
    source: STATION_DEFS.enka.source,
    source_url: STATION_DEFS.enka.source_url,
    observed_at_utc: observedAt,
    fetched_at_utc: new Date().toISOString(),
    age_minutes: round(age, 1),
    status: age > MAX_SOURCE_AGE_MINUTES ? "stale" : "live",
    is_stale: age > MAX_SOURCE_AGE_MINUTES,
    temperature_2m_c: round(temperature, 1),
    humidity_percent: round(humidity, 1),
    station_pressure_hpa: round(pressure, 1),
    actual_station_pressure_hpa: round(pressure, 1),
    wind_speed_10m_kmh: round(knots * 1.852, 1),
    wind_speed_10m_knots: round(knots, 1),
    wind_direction_cardinal: windMatch[1].toUpperCase(),
    wind_direction_degrees: null,
    wind_direction_tr: null,
    dew_point_c: dewPoint(temperature, humidity),
    feels_like_c: feelsLike(temperature, humidity, round(knots * 1.852, 1)),
    precipitation_1h_mm: null,
    precipitation_10m_mm: null,
    precipitation_6h_mm: null,
    precipitation_12h_mm: null,
    precipitation_24h_mm: null,
    precipitation_daily_mm: dailyRainMatch ? round(Number(dailyRainMatch[1].replace(",", ".")), 1) : null,
    precipitation_source: "MGM 18401 · Şişli",
    observation_method: "weatherlink-current-values-current-value"
      };
    } catch (error) {
      lastError = error;
      console.warn("[ENKA WEATHERLINK RETRY] attempt " + attempt + "/3: " + (error?.message || error));
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  throw lastError || new Error("ENKA WeatherLink ölçümü alınamadı");
}
async function fetchEnkaCamera(env) {
  const response = await fetchWithTimeout(ENKA_CAMERA_URL + "?_station_poll=" + Date.now(), {
    headers: { "Accept": "image/jpeg", "User-Agent": "gfs-watch-stations/1.0" }
  }, 18000);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let reading = null;
  try { reading = recognizeCameraOverlay(bytes); }
  catch (error) { console.warn("[ENKA CAMERA OCR LOCAL] " + (error?.message || error) + " · trying AI OCR"); }
  if (!reading && env?.AI) reading = await recognizeCameraOverlayWithAI(bytes, env.AI);
  if (!reading) throw new Error("ENKA kamera OCR yazısı okunamadı");
  console.log("[ENKA CAMERA OCR SUCCESS] temp=" + reading.temperature_c + "°C humidity=" + reading.humidity_percent + "% pressure=" + reading.pressure_hpa + "hPa wind=" + reading.wind_knots + "kt " + (reading.wind_direction_cardinal || "?") + " observed=" + reading.observed_at_utc);
  return observationFromCameraReading(reading, MAX_SOURCE_AGE_MINUTES);
}
async function fetchEnka(env) {
  let weatherlink = null;
  let weatherlinkError = null;

  // WeatherLink is the primary source. Any fetch/parsing/validation failure,
  // or stale/incomplete data, immediately activates the camera OCR fallback.
  try {
    weatherlink = await fetchEnkaWeatherLink();
  } catch (error) {
    weatherlinkError = error;
    console.error("[ENKA WEATHERLINK]", error && error.message ? error.message : error);
  }

  if (!shouldUseCameraFallback(weatherlink, MAX_SOURCE_AGE_MINUTES)) {
    return weatherlink;
  }

  try {
    const camera = await fetchEnkaCamera(env);
    if (camera) {
      console.log(
        "[ENKA] WeatherLink unavailable/stale -> camera OCR fallback active · " +
        (camera.is_stale ? "OCR ölçümü de gecikmeli" : "OCR canlı")
      );
      return camera;
    }
  } catch (error) {
    console.error("[ENKA CAMERA OCR]", error && error.message ? error.message : error);
  }

  // Preserve the last WeatherLink observation only as a last-resort stale
  // record; never pretend it is live when the primary source failed.
  if (weatherlink) return weatherlink;
  throw weatherlinkError || new Error("ENKA ölçümü alınamadı");
}
async function fetchMgmArray(url) {
  const response = await fetchWithTimeout(url + (url.includes("?") ? "&" : "?") + "_station_poll=" + Date.now(), {
    headers: {
      "Accept": "application/json",
      "Origin": "https://www.mgm.gov.tr",
      "Referer": "https://www.mgm.gov.tr/"
    }
  }, 15000);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("MGM JSON dizisi bekleniyordu");
  return payload;
}
function normalizeMgmText(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function findMgmDistrictRow(rows, district) {
  const target = normalizeMgmText(district);
  const fields = ["ilce", "ilceAdi", "ilceAd", "merkezAdi", "merkezAd", "istasyonAdi", "istasyon", "aciklama", "yer"];
  return rows.find(item => fields.some(field => normalizeMgmText(item && item[field]).includes(target))) || null;
}
async function fetchMgmStation(stationKey) {
  if (stationKey === "canakci") {
    let centerError = null;
    try {
      const centers = await fetchMgmArray("https://servis.mgm.gov.tr/web/merkezler?il=Giresun&ilce=Canakci");
      if (!Array.isArray(centers) || !centers.length) throw new Error("MGM Çanakçı merkezi bulunamadı");
      const center = centers.find(item => normalizeMgmText(item && item.ilce) === "canakci") || centers[0];
      const centerId = center.merkezId;
      if (!centerId) throw new Error("MGM Çanakçı merkezId bulunamadı");
      const url = "https://servis.mgm.gov.tr/web/sondurumlar?merkezid=" + encodeURIComponent(centerId);
      const rows = await fetchMgmArray(url);
      if (!Array.isArray(rows) || !rows.length) throw new Error("MGM Çanakçı son durum verisi boş");
      const stationId = center.sondurumIstNo || center.gunlukTahminIstNo || rows[0].istNo || String(centerId);
      const row = rows.find(item => String(item.istNo || "") === String(stationId)) || rows[0];
      return { row, url, center };
    } catch (error) {
      centerError = error;
    }

    // Çanakçı'nın merkez-lookup endpoint'i zaman zaman 530 ile
    // Cloudflare Worker isteklerini reddediyor. Ana sistemi durdurmadan
    // Giresun'un toplu son-durum listesinden aynı ilçeyi bul.
    const fallbackUrls = [
      "https://servis.mgm.gov.tr/web/sondurumlar/ilTumSondurum?ilPlaka=28",
      "https://servis.mgm.gov.tr/api/sondurumlar/ilTumSondurum?ilPlaka=28"
    ];
    const fallbackAttempts = await Promise.allSettled(
      fallbackUrls.map(async url => {
        const rows = await fetchMgmArray(url);
        const row = findMgmDistrictRow(rows, "Çanakçı");
        if (!row) throw new Error("MGM Çanakçı kaydı bu uç noktada bulunamadı");
        return { row, url, center: null, fallback: true };
      })
    );
    for (const attempt of fallbackAttempts) {
      if (attempt.status === "fulfilled") {
        console.warn("[MGM FALLBACK] canakci " + attempt.value.url + " · primary lookup failed: " + String(centerError && centerError.message || centerError));
        return attempt.value;
      }
    }
    const fallbackErrors = fallbackAttempts
      .filter(item => item.status === "rejected")
      .map(item => String(item.reason && item.reason.message || item.reason))
      .filter(Boolean);
    throw new Error(
      "MGM Çanakçı primary lookup failed: " +
      String(centerError && centerError.message || centerError) +
      (fallbackErrors.length ? " | fallback: " + fallbackErrors.join(" | ") : "")
    );
  }
  const stationId = STATION_DEFS[stationKey].station_id;
  const urls = stationKey === "eyupsultan"
    ? [
        "https://servis.mgm.gov.tr/web/sondurumlar/ilTumSondurum?ilPlaka=34",
        "https://servis.mgm.gov.tr/api/sondurumlar/ilTumSondurum?ilPlaka=34",
        "https://servis.mgm.gov.tr/web/sondurumlar?istno=18101",
        "https://servis.mgm.gov.tr/api/sondurumlar?istno=18101"
      ]
    : [
        // Prefer the direct station-number endpoints. They avoid the
        // merkezid route that is currently returning 403 from MGM.
        "https://servis.mgm.gov.tr/web/sondurumlar?istno=18401",
        "https://servis.mgm.gov.tr/api/sondurumlar?istno=18401",
        "https://servis.mgm.gov.tr/web/sondurumlar?merkezid=18401",
        "https://servis.mgm.gov.tr/api/sondurumlar?merkezid=18401",
        "https://servis.mgm.gov.tr/web/sondurumlar/ilTumSondurum?ilPlaka=34",
        "https://servis.mgm.gov.tr/api/sondurumlar/ilTumSondurum?ilPlaka=34"
      ];
  const attempts = await Promise.allSettled(urls.map(async url => {
    const rows = await fetchMgmArray(url);
    const row = rows.find(item => String(item.istNo || "") === String(stationId));
    if (!row) throw new Error("MGM istasyon kaydı bulunamadı " + stationId);
    return { row, url };
  }));
  for (const attempt of attempts) {
    if (attempt.status === "fulfilled") return attempt.value;
  }
  const errors = attempts
    .filter(item => item.status === "rejected")
    .map(item => String(item.reason && item.reason.message || item.reason))
    .filter(Boolean);
  throw new Error("MGM " + stationId + " alınamadı: " + (errors[0] || "tüm uç noktalar başarısız"));
}
function observationFromMgm(stationKey, row, sourceUrl) {
  const def = STATION_DEFS[stationKey];
  const observedAt = parseDate(row.tarih || row.veriZamani || row.zaman) || new Date();
  const age = ageMinutes(observedAt.toISOString());
  const temp = asNumber(row.sicaklik);
  const humidity = asNumber(row.nem);
  const pressure = asNumber(row.denizeGoreBasinc || row.aktuelBasinc);
  const windKmh = asNumber(row.ruzgarHiz);
  const windDeg = asNumber(row.ruzgarYon);
  const rain1h = asNumber(row.yagis1Saat);
  const rain10m = asNumber(row.yagis10Dakika);
  const rain6h = asNumber(row.yagis6Saat);
  const rain12h = asNumber(row.yagis12Saat);
  const rain24h = asNumber(row.yagis24Saat);
  const rain00 = asNumber(row.yagis00Now);
  return {
    station_id: def.station_id,
    station_name: def.station_name,
    source: def.source,
    source_url: sourceUrl || def.source_url,
    observed_at_utc: observedAt.toISOString(),
    fetched_at_utc: new Date().toISOString(),
    age_minutes: age === null ? null : round(age, 1),
    status: age !== null && age > MAX_SOURCE_AGE_MINUTES ? "stale" : "live",
    is_stale: age !== null && age > MAX_SOURCE_AGE_MINUTES,
    temperature_2m_c: temp,
    humidity_percent: humidity,
    station_pressure_hpa: pressure,
    pressure_hpa: pressure,
    actual_station_pressure_hpa: pressure,
    wind_speed_10m_kmh: windKmh,
    wind_speed_10m_knots: windKmh === null ? null : round(windKmh / 1.852, 1),
    wind_direction_cardinal: windCardinal(windDeg),
    wind_direction_degrees: windDeg,
    wind_direction_tr: null,
    dew_point_c: dewPoint(temp, humidity),
    feels_like_c: feelsLike(temp, humidity, windKmh),
    precipitation_1h_mm: rain1h,
    precipitation_10m_mm: rain10m,
    precipitation_6h_mm: rain6h,
    precipitation_12h_mm: rain12h,
    precipitation_24h_mm: rain24h,
    precipitation_daily_mm: rain00,
    precipitation_source: def.source,
    observation_method: "mgm-sondurumlar"
  };
}
async function storeObservation(env, stationKey, observation, triggerSource, durationMs) {
  if (!env.STATIONS_DB) return;
  const payload = JSON.stringify(observation);
  const nowIso = new Date().toISOString();
  const current = env.STATIONS_DB.prepare(
    "INSERT OR REPLACE INTO station_current (station_key, station_id, station_name, observed_at_utc, fetched_at_utc, status, payload_json, last_error, last_success_utc, last_attempt_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    stationKey,
    observation.station_id || "",
    observation.station_name || stationKey,
    observation.observed_at_utc || null,
    observation.fetched_at_utc || nowIso,
    observation.status || "live",
    payload,
    null,
    nowIso,
    nowIso
  );
  const history = env.STATIONS_DB.prepare(
    "INSERT OR REPLACE INTO station_history (station_key, station_id, station_name, observed_at_utc, fetched_at_utc, temperature_c, humidity_percent, pressure_hpa, wind_speed_kmh, wind_direction, rain_1h_mm, rain_10m_mm, rain_6h_mm, rain_12h_mm, rain_24h_mm, rain_00_now_mm, feels_like_c, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    stationKey,
    observation.station_id || "",
    observation.station_name || stationKey,
    observation.observed_at_utc || null,
    observation.fetched_at_utc || nowIso,
    observation.temperature_2m_c,
    observation.humidity_percent,
    observation.station_pressure_hpa,
    observation.wind_speed_10m_kmh,
    observation.wind_direction_degrees,
    observation.precipitation_1h_mm,
    observation.precipitation_10m_mm,
    observation.precipitation_6h_mm,
    observation.precipitation_12h_mm,
    observation.precipitation_24h_mm,
    observation.precipitation_daily_mm,
    observation.feels_like_c,
    payload
  );
  const diagnostic = env.STATIONS_DB.prepare(
    "INSERT INTO station_collection_diagnostics (station_key, last_attempt_utc, last_success_utc, last_error, last_trigger_source, collection_duration_ms) VALUES (?, ?, ?, NULL, ?, ?) " +
    "ON CONFLICT(station_key) DO UPDATE SET last_attempt_utc=excluded.last_attempt_utc, last_success_utc=excluded.last_success_utc, last_error=NULL, last_trigger_source=excluded.last_trigger_source, collection_duration_ms=excluded.collection_duration_ms"
  ).bind(stationKey, nowIso, nowIso, triggerSource || "unknown", Math.max(0, Math.round(durationMs || 0)));
  await env.STATIONS_DB.batch([current, history, diagnostic]);
}
async function recordCollectionFailure(env, stationKey, error, triggerSource, durationMs) {
  if (!env.STATIONS_DB) return;
  const nowIso = new Date().toISOString();
  const message = String(error && error.message || error || "Unknown collection error").slice(0, 1200);
  const diagnostic = env.STATIONS_DB.prepare(
    "INSERT INTO station_collection_diagnostics (station_key, last_attempt_utc, last_success_utc, last_error, last_trigger_source, collection_duration_ms) VALUES (?, ?, NULL, ?, ?, ?) " +
    "ON CONFLICT(station_key) DO UPDATE SET last_attempt_utc=excluded.last_attempt_utc, last_error=excluded.last_error, last_trigger_source=excluded.last_trigger_source, collection_duration_ms=excluded.collection_duration_ms"
  ).bind(stationKey, nowIso, message, triggerSource || "unknown", Math.max(0, Math.round(durationMs || 0)));
  const current = env.STATIONS_DB.prepare(
    "UPDATE station_current SET last_error = ?, last_attempt_utc = ? WHERE station_key = ?"
  ).bind(message, nowIso, stationKey);
  await env.STATIONS_DB.batch([diagnostic, current]);
}

async function pruneHistory(env) {
  // Station history is intentionally retained indefinitely. The API still limits
  // the requested window/response size, but the underlying D1 archive is not pruned.
  if (RETENTION_HOURS !== null) {
    await env.STATIONS_DB.prepare(
      "DELETE FROM station_history WHERE fetched_at_utc < ?"
    ).bind(new Date(Date.now() - RETENTION_HOURS * 3600000).toISOString()).run();
  }
}
async function collectOne(env, stationKey, triggerSource) {
  const startedAt = Date.now();
  try {
    let observation;
    if (stationKey === "enka") {
      observation = await fetchEnka(env);
    } else {
      const { row, url } = await fetchMgmStation(stationKey);
      observation = observationFromMgm(stationKey, row, url);
    }
    const durationMs = Date.now() - startedAt;
    await storeObservation(env, stationKey, observation, triggerSource, durationMs);
    return {
      ok: true,
      status: observation.status || "live",
      observed_at_utc: observation.observed_at_utc || null,
      observation_method: observation.observation_method || null,
      duration_ms: durationMs
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = String(error && error.message || error);
    console.error("[COLLECT " + stationKey + "]", message);
    try {
      await recordCollectionFailure(env, stationKey, error, triggerSource, durationMs);
    } catch (diagnosticError) {
      console.error("[COLLECT DIAGNOSTIC " + stationKey + "]", diagnosticError && diagnosticError.message || diagnosticError);
    }
    return { ok: false, error: message, duration_ms: durationMs };
  }
}

async function collectAll(env, triggerSource = "unknown") {
  // These upstream stations are independent. A slow ENKA request must never
  // hold back the three MGM stations or make a two-minute collection overrun.
  const collected = await Promise.all(
    Object.keys(STATION_DEFS).map(async key => ({
      key,
      result: await collectOne(env, key, triggerSource)
    }))
  );
  const results = Object.fromEntries(collected.map(item => [item.key, item.result]));
  await pruneHistory(env);
  return results;
}
async function getCurrent(env, stationKey) {
  const row = await env.STATIONS_DB.prepare(
    "SELECT payload_json FROM station_current WHERE station_key = ?"
  ).bind(stationKey).first();
  return row ? JSON.parse(row.payload_json) : null;
}
async function getHistory(env, stationKey, hours) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const { results } = await env.STATIONS_DB.prepare(
    "SELECT station_id, observed_at_utc, observed_at_utc AS source_observed_at_utc, fetched_at_utc, temperature_c, humidity_percent, pressure_hpa, wind_speed_kmh, wind_direction, rain_1h_mm, rain_10m_mm, rain_6h_mm, rain_12h_mm, rain_24h_mm, rain_00_now_mm, feels_like_c FROM station_history WHERE station_key = ? AND fetched_at_utc >= ? ORDER BY fetched_at_utc ASC LIMIT 20000"
  ).bind(stationKey, since).all();
  return results || [];
}
function feelsRange(samples) {
  const values = samples.map(s => s.feels_like_c).filter(v => Number.isFinite(v));
  if (!values.length) return { min: null, max: null };
  return { min: round(Math.min(...values), 1), max: round(Math.max(...values), 1) };
}
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return json({ ok: true });
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/stations" || path === "/stations") {
      const stations = [];
      for (const key of Object.keys(STATION_DEFS)) {
        const s = await getCurrent(env, key);
        if (s) stations.push(s);
      }
      return json({ ok: true, stations, updated_at_utc: new Date().toISOString() });
    }

    const currentMatch = path.match(/^\/api\/stations\/(enka|eyupsultan|sisli|canakci)$/) || path.match(/^\/(enka|eyupsultan|sisli|canakci)$/);
    if (currentMatch) {
      const station = await getCurrent(env, currentMatch[1]);
      if (!station) return json({ ok: false, error: "İstasyon verisi yok" }, 404);
      return json({ ok: true, station });
    }

    const historyMatch = path.match(/^\/api\/history\/(enka|eyupsultan|sisli|canakci)$/);
    if (historyMatch) {
      const requested = Number(url.searchParams.get("hours") || 180);
      const hours = Math.max(1, Math.min(MAX_HISTORY_HOURS, Number.isFinite(requested) ? requested : 180));
      const samples = await getHistory(env, historyMatch[1], hours);
      const feels = hours === 24 ? feelsRange(samples) : { min: null, max: null };
      return json({
        ok: true,
        station_key: historyMatch[1],
        hours,
        count: samples.length,
        feels_like_24h_min_c: feels.min,
        feels_like_24h_max_c: feels.max,
        samples,
        updated_at_utc: new Date().toISOString()
      });
    }

    if (path === "/api/health" || path === "/health") {
      const rows = [];
      for (const key of Object.keys(STATION_DEFS)) {
        const [row, diagnostic] = await Promise.all([
          env.STATIONS_DB.prepare(
            "SELECT station_key, status, last_success_utc, last_attempt_utc, last_error, observed_at_utc FROM station_current WHERE station_key = ?"
          ).bind(key).first(),
          env.STATIONS_DB.prepare(
            "SELECT last_attempt_utc, last_success_utc, last_error, last_trigger_source, collection_duration_ms FROM station_collection_diagnostics WHERE station_key = ?"
          ).bind(key).first()
        ]);
        const lastError = diagnostic && diagnostic.last_error || row && row.last_error || null;
        rows.push({
          key,
          status: row && row.status || "unknown",
          collection_status: lastError ? "error" : diagnostic && diagnostic.last_success_utc ? "ok" : "unknown",
          last_success_utc: diagnostic && diagnostic.last_success_utc || row && row.last_success_utc || null,
          last_attempt_utc: diagnostic && diagnostic.last_attempt_utc || row && row.last_attempt_utc || null,
          last_error: lastError,
          last_trigger_source: diagnostic && diagnostic.last_trigger_source || null,
          collection_duration_ms: diagnostic && diagnostic.collection_duration_ms != null ? diagnostic.collection_duration_ms : null,
          observed_at_utc: row && row.observed_at_utc || null
        });
      }
      return json({ ok: true, storage: "D1", stations: rows, updated_at_utc: new Date().toISOString() });
    }

    if (path === "/collect" || path === "/api/collect") {
      const results = await collectAll(env, "manual");
      const failures = Object.entries(results).filter(([, result]) => !result.ok);
      return json({
        ok: failures.length === 0,
        results,
        failed_stations: failures.map(([key]) => key),
        collected_at_utc: new Date().toISOString()
      }, failures.length ? 502 : 200);
    }

    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      collectAll(env, "cron").catch(error => {
        console.error("[SCHEDULED COLLECTION]", error && error.message || error);
      })
    );
  }
};
