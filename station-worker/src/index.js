import {
  ENKA_CAMERA_URL,
  observationFromCameraReading,
  recognizeCameraOverlay,
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
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
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
  const url = "https://w.enka.com/weather/currentvalues.html?_station_poll=" + Date.now();
  const response = await fetchWithTimeout(url, {
    headers: { "Accept": "text/html,application/xhtml+xml", "Referer": "https://w.enka.com/weather/" }
  }, 18000);
  const html = await response.text();
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
}
async function fetchEnkaCamera() {
  const response = await fetchWithTimeout(ENKA_CAMERA_URL + "?_station_poll=" + Date.now(), {
    headers: { "Accept": "image/jpeg", "User-Agent": "gfs-watch-stations/1.0" }
  }, 18000);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const reading = recognizeCameraOverlay(bytes);
  if (!reading) throw new Error("ENKA kamera yazısı okunamadı");
  return observationFromCameraReading(reading, MAX_SOURCE_AGE_MINUTES);
}
async function fetchEnka() {
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
    const camera = await fetchEnkaCamera();
    if (camera && camera.is_stale !== true) {
      console.log("[ENKA] WeatherLink unavailable/stale -> camera OCR fallback active");
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
    const row = rows.find(item => Number(item.istNo) === Number(stationId));
    if (!row) throw new Error("MGM " + stationId + " kaydı bu uç noktada bulunamadı");
    return { row, url };
  }));
  // Preserve the preferred-source order, but do not let a slow/broken
  // endpoint delay all fallback sources one after another.
  for (const attempt of attempts) {
    if (attempt.status === "fulfilled") return attempt.value;
  }
  const messages = attempts.map(item => item.status === "rejected" ? String(item.reason && item.reason.message || item.reason) : "").filter(Boolean);
  throw new Error(messages.join(" | ") || ("MGM " + stationId + " kaynağı yanıt vermedi"));
}
async function fetchMgm(stationKey) {
  const result = await fetchMgmStation(stationKey);
  const row = result.row;
  const observed = parseDate(row.veriZamani);
  if (!observed) throw new Error("MGM " + STATION_DEFS[stationKey].station_id + " ölçüm zamanı yok/geçersiz");
  const age = ageMinutes(observed.toISOString());
  const temperature = asNumber(row.sicaklik);
  if (temperature === null || temperature < -50 || temperature > 60) {
    throw new Error("MGM " + STATION_DEFS[stationKey].station_id + " sıcaklık ölçümü yok/geçersiz");
  }
  const humidity = asNumber(row.nem);
  const windSpeed = asNumber(row.ruzgarHiz);
  const windDegrees = asNumber(row.ruzgarYon);
  let pressure = asNumber(row.aktuelBasinc);
  let pressureSourceUrl = result.url;
  // Şişli's temperature endpoint can omit current station pressure while
  // the dedicated MGM API still returns aktuelBasinc. Try it independently
  // without replacing station pressure with sea-level pressure.
  if (stationKey === "sisli" && pressure === null) {
    const pressureUrls = [
      "https://servis.mgm.gov.tr/web/sondurumlar?istno=18401",
      "https://servis.mgm.gov.tr/api/sondurumlar?istno=18401",
      "https://servis.mgm.gov.tr/web/sondurumlar?merkezid=18401",
      "https://servis.mgm.gov.tr/api/sondurumlar?merkezid=18401",
      "https://servis.mgm.gov.tr/web/sondurumlar/ilTumSondurum?ilPlaka=34",
      "https://servis.mgm.gov.tr/api/sondurumlar/ilTumSondurum?ilPlaka=34"
    ];
    const pressureAttempts = await Promise.allSettled(pressureUrls.map(async url => {
      const rows = await fetchMgmArray(url);
      const pressureRow = rows.find(item => Number(item.istNo) === Number(STATION_DEFS.sisli.station_id));
      const candidate = pressureRow ? asNumber(pressureRow.aktuelBasinc) : null;
      if (candidate === null || candidate < 800 || candidate > 1100) {
        throw new Error("Şişli basınç değeri yok/geçersiz");
      }
      return { candidate, url };
    }));
    const pressureSuccess = pressureAttempts.find(item => item.status === "fulfilled");
    if (pressureSuccess) {
      pressure = pressureSuccess.value.candidate;
      pressureSourceUrl = pressureSuccess.value.url;
    } else {
      const pressureErrors = pressureAttempts
        .filter(item => item.status === "rejected")
        .map(item => String(item.reason && item.reason.message || item.reason))
        .filter(Boolean);
      console.warn("[MGM PRESSURE FALLBACK]", stationKey, "all sources failed", pressureErrors.join(" | "));
    }
  }
  const dailyRain = asNumber(row.yagis00Now);
  return {
    station_id: stationKey === "eyupsultan" ? "18101" : stationKey === "sisli" ? "18401" : String(result.row.istNo || result.center?.sondurumIstNo || result.center?.merkezId || "CANAKCI"),
    station_name: STATION_DEFS[stationKey].station_name,
    source: STATION_DEFS[stationKey].source,
    source_url: STATION_DEFS[stationKey].source_url,
    measurement_source_url: result.url,
    pressure_source_url: pressureSourceUrl,
    observed_at_utc: observed.toISOString(),
    fetched_at_utc: new Date().toISOString(),
    age_minutes: round(age, 1),
    status: age > MAX_SOURCE_AGE_MINUTES ? "stale" : "live",
    is_stale: age > MAX_SOURCE_AGE_MINUTES,
    temperature_2m_c: round(temperature, 1),
    humidity_percent: humidity === null ? null : round(humidity, 1),
    station_pressure_hpa: pressure === null ? null : round(pressure, 1),
    actual_station_pressure_hpa: pressure === null ? null : round(pressure, 1),
    wind_speed_10m_kmh: windSpeed === null ? null : round(windSpeed, 1),
    wind_direction_degrees: windDegrees,
    wind_direction_cardinal: windCardinal(windDegrees),
    wind_direction_tr: windCardinal(windDegrees),
    dew_point_c: dewPoint(temperature, humidity),
    feels_like_c: feelsLike(temperature, humidity, windSpeed),
    precipitation_1h_mm: asNumber(row.yagis1Saat),
    precipitation_10m_mm: asNumber(row.yagis10Dk),
    precipitation_6h_mm: asNumber(row.yagis6Saat),
    precipitation_12h_mm: asNumber(row.yagis12Saat),
    precipitation_24h_mm: asNumber(row.yagis24Saat),
    precipitation_daily_mm: dailyRain,
    precipitation_source: "MGM " + STATION_DEFS[stationKey].station_id,
    pressure_type: "station",
    pressure_observed_at_utc: observed.toISOString(),
    pressure_source: "MGM actual station pressure",
    observation_method: "mgm-sondurum"
  };
}
function apiStation(key, payload, status, lastError, lastSuccess, lastAttempt) {
  return {
    station_key: key,
    station_id: payload.station_id,
    station_name: payload.station_name,
    source: payload.source,
    source_url: payload.source_url,
    observation_method: payload.observation_method || null,
    observation_method: payload.observation_method || null,
    observed_at_utc: payload.observed_at_utc,
    fetched_at_utc: payload.fetched_at_utc,
    // Canonical panel fields.
    temperature_c: payload.temperature_2m_c,
    humidity_percent: payload.humidity_percent,
    pressure_hpa: payload.station_pressure_hpa,
    actual_station_pressure_hpa: payload.actual_station_pressure_hpa,
    wind_speed_kmh: payload.wind_speed_10m_kmh,
    wind_direction: payload.wind_direction_degrees,
    wind_direction_cardinal: payload.wind_direction_cardinal,
    rain_1h_mm: payload.precipitation_1h_mm,
    rain_10m_mm: payload.precipitation_10m_mm,
    rain_6h_mm: payload.precipitation_6h_mm,
    rain_12h_mm: payload.precipitation_12h_mm,
    rain_24h_mm: payload.precipitation_24h_mm,
    rain_00_now_mm: payload.precipitation_daily_mm,
    // Report/API compatibility aliases: the GFS report consumes the same
    // active station panel payload without maintaining a second station model.
    temperature_2m_c: payload.temperature_2m_c,
    station_pressure_hpa: payload.station_pressure_hpa,
    wind_speed_10m_kmh: payload.wind_speed_10m_kmh,
    wind_direction_degrees: payload.wind_direction_degrees,
    precipitation_1h_mm: payload.precipitation_1h_mm,
    precipitation_10m_mm: payload.precipitation_10m_mm,
    precipitation_6h_mm: payload.precipitation_6h_mm,
    precipitation_12h_mm: payload.precipitation_12h_mm,
    precipitation_24h_mm: payload.precipitation_24h_mm,
    precipitation_daily_mm: payload.precipitation_daily_mm,
    feels_like_c: payload.feels_like_c,
    dew_point_c: payload.dew_point_c,
    feels_like_c: payload.feels_like_c,
    status: status || payload.status || "unknown",
    is_stale: (status || payload.status) !== "live",
    age_minutes: payload.age_minutes,
    last_success_utc: lastSuccess || null,
    last_attempt_utc: lastAttempt || payload.fetched_at_utc || null,
    last_error: lastError || null
  };
}
async function readCurrent(env, key) {
  const row = await env.STATIONS_DB.prepare(
    "SELECT payload_json, status, last_error, last_success_utc, last_attempt_utc FROM station_current WHERE station_key = ?"
  ).bind(key).first();
  if (!row) return null;
  try {
    return { payload: JSON.parse(row.payload_json), status: row.status, last_error: row.last_error, last_success_utc: row.last_success_utc, last_attempt_utc: row.last_attempt_utc };
  } catch (_) {
    return null;
  }
}
async function persistSuccess(env, key, observation, rainSource) {
  const fetchedAt = new Date().toISOString();
  observation.fetched_at_utc = fetchedAt;
  if (key === "enka" && rainSource) {
    observation.precipitation_1h_mm = rainSource.precipitation_1h_mm;
    observation.precipitation_10m_mm = rainSource.precipitation_10m_mm;
    observation.precipitation_6h_mm = rainSource.precipitation_6h_mm;
    observation.precipitation_12h_mm = rainSource.precipitation_12h_mm;
    observation.precipitation_24h_mm = rainSource.precipitation_24h_mm;
    observation.precipitation_daily_mm = rainSource.precipitation_daily_mm;
  }
  const status = observation.status || "live";
  const payloadJson = JSON.stringify(observation);
  const history = env.STATIONS_DB.prepare(
    "INSERT OR REPLACE INTO station_history (station_key, station_id, observed_at_utc, fetched_at_utc, temperature_c, humidity_percent, pressure_hpa, wind_speed_kmh, wind_direction, rain_1h_mm, rain_10m_mm, rain_6h_mm, rain_12h_mm, rain_24h_mm, rain_00_now_mm, feels_like_c, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    key, observation.station_id, observation.observed_at_utc, fetchedAt,
    observation.temperature_2m_c, observation.humidity_percent,
    observation.station_pressure_hpa, observation.wind_speed_10m_kmh,
    observation.wind_direction_degrees, observation.precipitation_1h_mm,
    observation.precipitation_10m_mm, observation.precipitation_6h_mm,
    observation.precipitation_12h_mm, observation.precipitation_24h_mm,
    observation.precipitation_daily_mm, observation.feels_like_c, payloadJson
  );
  const current = env.STATIONS_DB.prepare(
    "INSERT INTO station_current (station_key, station_id, station_name, observed_at_utc, fetched_at_utc, status, payload_json, last_error, last_success_utc, last_attempt_utc) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(station_key) DO UPDATE SET station_id=excluded.station_id, station_name=excluded.station_name, observed_at_utc=excluded.observed_at_utc, fetched_at_utc=excluded.fetched_at_utc, status=excluded.status, payload_json=excluded.payload_json, last_error=NULL, last_success_utc=excluded.last_success_utc, last_attempt_utc=excluded.last_attempt_utc"
  ).bind(
    key, observation.station_id, observation.station_name, observation.observed_at_utc,
    fetchedAt, status, payloadJson, fetchedAt, fetchedAt
  );
  await env.STATIONS_DB.batch([current, history]);
}
async function persistFailure(env, key, error) {
  const message = String(error && error.message ? error.message : error).slice(0, 500);
  const attemptedAt = new Date().toISOString();
  const def = STATION_DEFS[key];
  const emptyPayload = {
    station_id: def.station_id,
    station_name: def.station_name,
    source: def.source,
    source_url: def.source_url,
    observed_at_utc: null,
    fetched_at_utc: attemptedAt,
    age_minutes: null,
    status: "stale",
    is_stale: true,
    temperature_2m_c: null,
    feels_like_c: null,
    humidity_percent: null,
    station_pressure_hpa: null,
    actual_station_pressure_hpa: null,
    wind_speed_10m_kmh: null,
    wind_direction_degrees: null,
    wind_direction_cardinal: null,
    precipitation_1h_mm: null,
    precipitation_10m_mm: null,
    precipitation_6h_mm: null,
    precipitation_12h_mm: null,
    precipitation_24h_mm: null,
    precipitation_daily_mm: null
  };
  await env.STATIONS_DB.prepare(
    "INSERT INTO station_current (station_key, station_id, station_name, observed_at_utc, fetched_at_utc, status, payload_json, last_error, last_success_utc, last_attempt_utc) VALUES (?, ?, ?, NULL, ?, 'stale', ?, ?, NULL, ?) ON CONFLICT(station_key) DO UPDATE SET status='stale', last_error=excluded.last_error, last_attempt_utc=excluded.last_attempt_utc"
  ).bind(key, def.station_id, def.station_name, attemptedAt, JSON.stringify(emptyPayload), message, attemptedAt).run();
  console.error("[STATION ERROR]", key, message);
}
async function collectAll(env) {
  const tasks = await Promise.allSettled([
    fetchEnka().then(value => ({ key: "enka", value })),
    fetchMgm("eyupsultan").then(value => ({ key: "eyupsultan", value })),
    fetchMgm("sisli").then(value => ({ key: "sisli", value })),
    fetchMgm("canakci").then(value => ({ key: "canakci", value }))
  ]);
  const result = {};
  for (const task of tasks) {
    if (task.status === "fulfilled") result[task.value.key] = task.value.value;
    else console.error("[COLLECT FETCH ERROR]", task.reason && task.reason.message ? task.reason.message : task.reason);
  }
  let sisliRain = result.sisli || null;
  if (!sisliRain) {
    const stored = await readCurrent(env, "sisli");
    sisliRain = stored ? stored.payload : null;
  }
  const keys = ["enka", "eyupsultan", "sisli", "canakci"];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (result[key]) {
      try {
        await persistSuccess(env, key, result[key], key === "enka" ? sisliRain : null);
        console.log("[COLLECT OK]", key, result[key].temperature_2m_c, "°C", "age", result[key].age_minutes, "min");
      } catch (error) {
        await persistFailure(env, key, error);
      }
    } else {
      const task = tasks[i];
      const error = task && task.status === "rejected" ? task.reason : new Error("Unknown collection failure");
      await persistFailure(env, key, error);
    }
  }
  // Station history is intentionally retained indefinitely. The API still limits\n  // the requested window/response size, but the underlying D1 archive is not pruned.\n  if (RETENTION_HOURS !== null) {\n    await env.STATIONS_DB.prepare(\n      "DELETE FROM station_history WHERE fetched_at_utc < ?"\n    ).bind(new Date(Date.now() - RETENTION_HOURS * 3600000).toISOString()).run();\n  }
  return {
    fetched_at_utc: new Date().toISOString(),
    succeeded: Object.keys(result),
    failed: ["enka","eyupsultan","sisli","canakci"].filter(key => !result[key] || result[key].status !== "live")
  };
}
async function getFeelsLike24h(env, key) {
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  const result = await env.STATIONS_DB.prepare(
    "SELECT temperature_c, humidity_percent, wind_speed_kmh, feels_like_c FROM station_history WHERE station_key = ? AND observed_at_utc >= ? ORDER BY observed_at_utc ASC LIMIT 5000"
  ).bind(key, since).all();
  const values = (result.results || []).map(row => {
    const stored = asNumber(row.feels_like_c);
    if (stored !== null) return stored;
    return feelsLike(asNumber(row.temperature_c), asNumber(row.humidity_percent), asNumber(row.wind_speed_kmh));
  }).filter(value => value !== null);
  return {
    min_c: values.length ? round(Math.min(...values), 1) : null,
    max_c: values.length ? round(Math.max(...values), 1) : null
  };
}

async function getStationRows(env) {
  const result = await env.STATIONS_DB.prepare(
    "SELECT station_key, payload_json, status, last_error, last_success_utc, last_attempt_utc FROM station_current ORDER BY station_key"
  ).all();
  return (await Promise.all((result.results || []).map(async row => {
    let payload;
    try { payload = JSON.parse(row.payload_json); } catch (_) { return null; }
    const range = await getFeelsLike24h(env, row.station_key);
    const item = apiStation(row.station_key, payload, row.status, row.last_error, row.last_success_utc, row.last_attempt_utc);
    item.feels_like_24h_min_c = range.min_c;
    item.feels_like_24h_max_c = range.max_c;
    return item;
  }))).filter(Boolean);
}
async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (request.method === "OPTIONS") return json({ ok: true });
  if (path === "/api/admin/collect") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const expected = env.STATIONS_ADMIN_TOKEN;
    if (!expected || request.headers.get("Authorization") !== "Bearer " + expected) {
      return json({ error: "Unauthorized" }, 401);
    }
    try {
      const result = await collectAll(env);
      const ok = result.failed.length === 0;
      return json({ ok, ...result }, ok ? 200 : 502);
    } catch (error) {
      return json({ ok: false, error: String(error.message || error) }, 500);
    }
  }
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (path === "/api/health") {
    try {
      const rows = await getStationRows(env);
      const latest = rows.map(row => row.fetched_at_utc).filter(Boolean).sort().at(-1) || null;
      return json({
        ok: true,
        service: "gfs-watch-stations",
        storage: "D1",
        cron: "*/2 * * * *",
        station_count: rows.length,
        latest_fetch_at_utc: latest,
        stations: rows.map(row => ({ key: row.station_key, status: row.status, fetched_at_utc: row.fetched_at_utc, last_success_utc: row.last_success_utc, last_attempt_utc: row.last_attempt_utc, last_error: row.last_error }))
      });
    } catch (error) {
      return json({ ok: false, service: "gfs-watch-stations", error: String(error.message || error) }, 503);
    }
  }
  if (path === "/api/stations") {
    try {
      const stations = await getStationRows(env);
      return json({ ok: true, stations, updated_at_utc: new Date().toISOString() });
    } catch (error) {
      return json({ ok: false, error: String(error.message || error) }, 503);
    }
  }
  const currentMatch = path.match(/^\/api\/stations\/(enka|eyupsultan|sisli|canakci)$/);
  if (currentMatch) {
    try {
      const current = await readCurrent(env, currentMatch[1]);
      if (!current) return json({ ok: false, error: "Station has not collected a successful observation yet", station_key: currentMatch[1] }, 404);
      const range = await getFeelsLike24h(env, currentMatch[1]);
      const station = apiStation(currentMatch[1], current.payload, current.status, current.last_error, current.last_success_utc, current.last_attempt_utc);
      station.feels_like_24h_min_c = range.min_c;
      station.feels_like_24h_max_c = range.max_c;
      return json({ ok: true, station });
    } catch (error) {
      return json({ ok: false, error: String(error.message || error) }, 503);
    }
  }
  const historyMatch = path.match(/^\/api\/history\/(enka|eyupsultan|sisli|canakci)$/);
  if (historyMatch) {
    try {
      const requested = Number(url.searchParams.get("hours") || 72);
      const hours = Math.max(1, Math.min(72, Number.isFinite(requested) ? requested : 72));
      const since = new Date(Date.now() - hours * 3600000).toISOString();
      const result = await env.STATIONS_DB.prepare(
        "SELECT station_id, observed_at_utc AS source_observed_at_utc, fetched_at_utc, temperature_c, humidity_percent, pressure_hpa, wind_speed_kmh, wind_direction, rain_1h_mm, rain_10m_mm, rain_6h_mm, rain_12h_mm, rain_24h_mm, rain_00_now_mm, feels_like_c FROM station_history WHERE station_key = ? AND fetched_at_utc >= ? ORDER BY fetched_at_utc ASC LIMIT 5000"
      ).bind(historyMatch[1], since).all();
      const samples = (result.results || []).map(row => ({
        ...row,
        observed_at_utc: row.source_observed_at_utc || row.fetched_at_utc,
        station_key: historyMatch[1]
      }));
      const feelsValues = samples
        .map(sample => {
          const stored = asNumber(sample.feels_like_c);
          if (stored !== null) return stored;
          return feelsLike(asNumber(sample.temperature_c), asNumber(sample.humidity_percent), asNumber(sample.wind_speed_kmh));
        })
        .filter(value => value !== null);
      return json({
        ok: true,
        station_key: historyMatch[1],
        hours,
        count: samples.length,
        feels_like_24h_min_c: hours === 24 && feelsValues.length ? round(Math.min(...feelsValues), 1) : null,
        feels_like_24h_max_c: hours === 24 && feelsValues.length ? round(Math.max(...feelsValues), 1) : null,
        samples,
        updated_at_utc: new Date().toISOString()
      });
    } catch (error) {
      return json({ ok: false, error: String(error.message || error) }, 503);
    }
  }
  return json({ error: "Not found" }, 404);
}
export default {
  async fetch(request, env) {
    return handleApi(request, env);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(collectAll(env).catch(error => console.error("[CRON FATAL]", error)));
  }
};
