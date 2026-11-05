import fs from "node:fs";
import path from "node:path";

const MGM_PAGE_URL = "https://www.mgm.gov.tr/tahmin/il-ve-ilceler.aspx?il=%C4%B0stanbul&ilce=%C5%9Ei%C5%9Fli";
const MGM_STATION_URL = "https://servis.mgm.gov.tr/web/sondurumlar?merkezid=18401";
const MGM_CITY_URL = "https://servis.mgm.gov.tr/web/sondurumlar/ilTumSondurum?ilPlaka=34";
const MGM_STATION_API_URL = "https://servis.mgm.gov.tr/api/sondurumlar?merkezid=18401";
const MGM_CITY_API_URL = "https://servis.mgm.gov.tr/api/sondurumlar/ilTumSondurum?ilPlaka=34";
const STATION_ID = "18401";
const STALE_AFTER_MINUTES = 20;
const HISTORY_SCHEMA = "gfs-watch.station-temperature-history.v1";
const RAIN_HISTORY_SCHEMA = "gfs-watch.station-rain-history.v1";

const directions = [
  ["Kuzey", "N"], ["Kuzey-kuzeydoğu", "NNE"], ["Kuzeydoğu", "NE"],
  ["Doğu-kuzeydoğu", "ENE"], ["Doğu", "E"], ["Doğu-güneydoğu", "ESE"],
  ["Güneydoğu", "SE"], ["Güney-güneydoğu", "SSE"], ["Güney", "S"],
  ["Güney-güneybatı", "SSW"], ["Güneybatı", "SW"], ["Batı-güneybatı", "WSW"],
  ["Batı", "W"], ["Batı-kuzeybatı", "WNW"], ["Kuzeybatı", "NW"],
  ["Kuzey-kuzeybatı", "NNW"]
];

function windFromDegrees(deg) {
  if (deg == null || !Number.isFinite(deg)) return { tr: null, cardinal: null };
  const idx = Math.floor(((deg % 360) + 11.25) / 22.5) % 16;
  return { tr: directions[idx][0], cardinal: directions[idx][1] };
}

function mgmNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > -900 ? number : null;
}

function dewPoint(temp, humidity) {
  if (temp == null || humidity == null || humidity <= 0 || humidity > 100) return null;
  const a = 17.27;
  const b = 237.7;
  const gamma = Math.log(humidity / 100) + (a * temp) / (b + temp);
  const point = (b * gamma) / (a - gamma);
  return Number.isFinite(point) ? Math.round(point * 10) / 10 : null;
}

async function requestMgm(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
        "Accept": "application/json",
        "Cache-Control": "no-cache, no-store, max-age=0",
        "Pragma": "no-cache",
        "Origin": "https://www.mgm.gov.tr",
        "Referer": "https://www.mgm.gov.tr/"
      }
    });
    if (!response.ok) throw new Error("MGM HTTP " + response.status);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("MGM JSON listesi bekleniyordu");
    const row = payload.find(item => Number(item.istNo) === Number(STATION_ID));
    if (!row) throw new Error("MGM 18401 kaydı bu uç noktada bulunamadı");
    return row;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyMgmPage() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const url = MGM_PAGE_URL + (MGM_PAGE_URL.includes("?") ? "&" : "?") + "_gfs_watch=" + Date.now();
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
        "Accept": "text/html,application/xhtml+xml",
        "Cache-Control": "no-cache, no-store, max-age=0",
        "Pragma": "no-cache"
      }
    });
    if (!response.ok) throw new Error("MGM Şişli sayfası HTTP " + response.status);
    const html = await response.text();
    if (!/Şişli|Sisli/i.test(html)) throw new Error("MGM sayfası içeriğinde Şişli doğrulanamadı");
    return { status: response.status, checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFromMgm() {
  let pageCheck = null;
  try {
    pageCheck = await verifyMgmPage();
    console.log("[MGM PAGE] İstanbul-Şişli sayfası doğrulandı:", pageCheck.status);
  } catch (error) {
    // The live observation endpoint remains usable if the presentation page is unavailable.
    console.warn("[MGM PAGE] Şişli sayfası doğrulanamadı; son-durum servisi yine deneniyor:", error.message);
  }

  let row, firstError, measurementSourceUrl;
  try {
    row = await requestMgm(MGM_STATION_API_URL);
    measurementSourceUrl = MGM_STATION_API_URL;
  } catch (error) {
    firstError = error;
    console.warn("[MGM] Şişli API başarısız; web istasyon uç noktası deneniyor:", error.message);
    try {
      row = await requestMgm(MGM_STATION_URL);
      measurementSourceUrl = MGM_STATION_URL;
    } catch (webError) {
      firstError = webError;
      console.warn("[MGM] Şişli web istasyon uç noktası başarısız; İstanbul listesi deneniyor:", webError.message);
      row = await requestMgm(MGM_CITY_URL);
      measurementSourceUrl = MGM_CITY_URL;
    }
  }
  if (!row.veriZamani) throw new Error("MGM 18401 ölçüm zamanı yok");
  const observedAt = new Date(row.veriZamani);
  if (!Number.isFinite(observedAt.getTime())) throw new Error("MGM ölçüm zamanı geçersiz");
  const rawAgeMinutes = (Date.now() - observedAt.getTime()) / 60000;
  if (rawAgeMinutes < -5) throw new Error("MGM ölçüm zamanı gelecekte görünüyor");
  const ageMinutes = Math.max(0, rawAgeMinutes);
  const temp = mgmNumber(row.sicaklik);
  if (temp == null) throw new Error("MGM 18401 sıcaklık ölçümü yok/geçersiz");
  const humidity = mgmNumber(row.nem);
  const windSpeed = mgmNumber(row.ruzgarHiz);
  const windDir = mgmNumber(row.ruzgarYon);
  const wind = windFromDegrees(windDir);
  let seaLevel = mgmNumber(row.denizeIndirgenmisBasinc);
  let stationP = mgmNumber(row.aktuelBasinc);

  // MGM sometimes serves the Şişli observation with pressure fields missing
  // on the /web endpoint while the legacy /api endpoint still has aktuelBasinc.
  // Pressure is fetched independently so a missing pressure field cannot block
  // the rest of the Şişli observation.
  if (stationP == null) {
    const pressureEndpoints = [MGM_STATION_API_URL, MGM_CITY_API_URL];
    for (const pressureUrl of pressureEndpoints) {
      try {
        const pressurePayload = await requestMgm(pressureUrl);
        const apiStationP = mgmNumber(pressurePayload.aktuelBasinc);
        const apiSeaLevel = mgmNumber(pressurePayload.denizeIndirgenmisBasinc);
        if (apiStationP != null) stationP = apiStationP;
        if (seaLevel == null && apiSeaLevel != null) seaLevel = apiSeaLevel;
        if (stationP != null || seaLevel != null) {
          console.log("[MGM] Şişli basınç /api kaynağından alındı:", stationP, "hPa");
          break;
        }
      } catch (error) {
        console.warn("[MGM] Şişli basınç alternatif uç noktası başarısız:", pressureUrl, error.message);
      }
    }
  }
  return {
    station_name: "Şişli",
    station_id: STATION_ID,
    source: "MGM İstanbul-Şişli · anlık son-durum ölçümü",
    source_url: MGM_PAGE_URL,
    measurement_source_url: measurementSourceUrl,
    source_page_checked_at_utc: pageCheck?.checkedAt || null,
    source_page_http_status: pageCheck?.status || null,
    source_fallback_used: Boolean(firstError),
    observed_at_utc: observedAt.toISOString(),
    fetched_at_utc: new Date().toISOString(),
    age_minutes: Math.round(ageMinutes),
    stale_after_minutes: STALE_AFTER_MINUTES,
    is_stale: ageMinutes > STALE_AFTER_MINUTES,
    temperature_2m_c: temp,
    wind_speed_10m_kmh: windSpeed == null ? null : Math.round(windSpeed * 10) / 10,
    wind_direction_degrees: windDir,
    wind_direction_cardinal: wind.cardinal,
    wind_direction_tr: wind.tr,
    precipitation_1h_mm: mgmNumber(row.yagis1Saat),
    precipitation_10m_mm: mgmNumber(row.yagis10Dk),
    precipitation_6h_mm: mgmNumber(row.yagis6Saat),
    precipitation_12h_mm: mgmNumber(row.yagis12Saat),
    precipitation_24h_mm: mgmNumber(row.yagis24Saat),
    precipitation_daily_mm: mgmNumber(row.yagis00Now),
    precipitation_source: "MGM 18401",
    humidity_percent: humidity,
    dew_point_c: dewPoint(temp, humidity),
    station_pressure_hpa: stationP,
    actual_station_pressure_hpa: stationP,
    pressure_type: "station",
    pressure_source: "MGM 18401",
    pressure_observed_at_utc: observedAt.toISOString(),
    pressure_age_minutes: Math.round(ageMinutes * 10) / 10
  };
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let document;
  try {
    document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Stored station history is unreadable; refusing to reset it: ${error.message}`);
  }
  if (!document || document.schema !== HISTORY_SCHEMA || !Array.isArray(document.samples)) {
    throw new Error("Stored station history has an invalid schema or samples list; refusing to reset it.");
  }
  return document;
}

async function main() {
  const now = new Date();
  const observation = await fetchFromMgm();
  console.log("[MGM]", observation.temperature_2m_c + "°C", "1sa", observation.precipitation_1h_mm, "mm", "bugün", observation.precipitation_daily_mm, "mm", "age", observation.age_minutes, "dk");

  const outDir = "public";
  fs.mkdirSync(outDir, { recursive: true });
  writeJsonAtomic(path.join(outDir, "sisli-station-observation.json"), {
    schema: "gfs-watch.station-observation.v1",
    station_observation: observation,
    updated_at_utc: now.toISOString()
  });

  const historyPath = process.env.SISLI_TEMPERATURE_HISTORY_PATH || path.join(outDir, "sisli-station-temperature-history.json");
  const historyDocument = readJsonIfExists(historyPath) || { schema: HISTORY_SCHEMA, samples: [] };
  const samples = Array.isArray(historyDocument.samples) ? historyDocument.samples : [];
  const last = samples[samples.length - 1];
  const lastTime = last ? Date.parse(last.observed_at_utc) : 0;
  const curTime = Date.parse(observation.observed_at_utc);
  const sample = {
    logged_at_utc: now.toISOString(),
    observed_at_utc: observation.observed_at_utc,
    temperature_2m_c: observation.temperature_2m_c,
    precipitation_1h_mm: observation.precipitation_1h_mm,
    precipitation_10m_mm: observation.precipitation_10m_mm,
    precipitation_6h_mm: observation.precipitation_6h_mm,
    precipitation_12h_mm: observation.precipitation_12h_mm,
    precipitation_24h_mm: observation.precipitation_24h_mm,
    precipitation_daily_mm: observation.precipitation_daily_mm,
    station_pressure_hpa: observation.station_pressure_hpa
  };
  if (last && lastTime === curTime) {
    last.temperature_2m_c = sample.temperature_2m_c;
    last.precipitation_1h_mm = sample.precipitation_1h_mm;
    last.precipitation_10m_mm = sample.precipitation_10m_mm;
    last.precipitation_6h_mm = sample.precipitation_6h_mm;
    last.precipitation_12h_mm = sample.precipitation_12h_mm;
    last.precipitation_24h_mm = sample.precipitation_24h_mm;
    last.precipitation_daily_mm = sample.precipitation_daily_mm;
    last.station_pressure_hpa = sample.station_pressure_hpa;
    last.logged_at_utc = sample.logged_at_utc;
  } else if (!last || Math.abs(curTime - lastTime) > 60000) {
    samples.push(sample);
  }
  // Persistent 72-hour station time-series archive for retrospective chart work.
  // Keep the observed timestamp as the archive clock; logged_at is only fetch metadata.
  const retentionHours = 72;
  const cutoff = now.getTime() - retentionHours * 60 * 60 * 1000;
  const retained = samples
    .filter(item => {
      const observed = Date.parse(item.observed_at_utc || item.logged_at_utc || "");
      return Number.isFinite(observed) && observed >= cutoff && observed <= now.getTime() + 5 * 60 * 1000;
    })
    .sort((a, b) => Date.parse(a.observed_at_utc || a.logged_at_utc) - Date.parse(b.observed_at_utc || b.logged_at_utc))
    .slice(-900);
  writeJsonAtomic(historyPath, {
    schema: HISTORY_SCHEMA,
    station_id: STATION_ID,
    station_name: "Şişli",
    retention_hours: retentionHours,
    sampling_interval_minutes: 5,
    rainfall_source_interval_minutes: 10,
    rainfall_chart_window_minutes: 60,
    rainfall_chart_step_minutes: 60,
    rolling_hour_precipitation_window_minutes: 60,
    updated_at_utc: now.toISOString(),
    samples: retained
  });
  // Keep a dedicated rainfall archive so the station rain chart reads only rainfall history.
  const rainHistoryPath = process.env.SISLI_RAIN_HISTORY_PATH || path.join(outDir, "sisli-station-rain-history.json");
  writeJsonAtomic(rainHistoryPath, {
    schema: RAIN_HISTORY_SCHEMA,
    station_id: STATION_ID,
    station_name: "Şişli",
    retention_hours: retentionHours,
    source_interval_minutes: 10,
    chart_window_minutes: 60,
    chart_step_minutes: 60,
    updated_at_utc: now.toISOString(),
    samples: retained.map(item => ({
      logged_at_utc: item.logged_at_utc,
      observed_at_utc: item.observed_at_utc,
      precipitation_1h_mm: item.precipitation_1h_mm,
      precipitation_10m_mm: item.precipitation_10m_mm,
      precipitation_6h_mm: item.precipitation_6h_mm,
      precipitation_12h_mm: item.precipitation_12h_mm,
      precipitation_24h_mm: item.precipitation_24h_mm,
      precipitation_daily_mm: item.precipitation_daily_mm
    }))
  });
  console.log("[DONE]", observation.temperature_2m_c + "°C", "age", observation.age_minutes, "min", observation.source);
}

main().catch(err => {
  console.error("[ERROR]", err?.stack || err);
  process.exitCode = 1;
});
