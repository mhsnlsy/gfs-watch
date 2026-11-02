import fs from "node:fs";
import path from "node:path";

const MGM_OBSERVATIONS_URL = "https://servis.mgm.gov.tr/web/sondurumlar/ilTumSondurum?ilPlaka=34";
const STATION_ID = "18101";
const STALE_AFTER_MINUTES = 120;
const HISTORY_SCHEMA = "gfs-watch.station-temperature-history.v1";

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

async function fetchFromMgm() {
  const response = await fetch(MGM_OBSERVATIONS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
      "Accept": "application/json",
      "Origin": "https://istanbul.mgm.gov.tr",
      "Referer": "https://istanbul.mgm.gov.tr/"
    }
  });
  if (!response.ok) throw new Error("MGM HTTP " + response.status);
  const observations = await response.json();
  const row = Array.isArray(observations) ? observations.find(item => Number(item.istNo) === Number(STATION_ID)) : null;
  if (!row || !row.veriZamani) throw new Error("MGM satırı yok");
  if (!Object.prototype.hasOwnProperty.call(row, "yagis1Saat")) {
    throw new Error("MGM yagis1Saat alanı yok");
  }

  const observedAt = new Date(row.veriZamani);
  const ageMinutes = Math.max(0, (Date.now() - observedAt.getTime()) / 60000);
  const temp = mgmNumber(row.sicaklik);
  if (temp == null) throw new Error("MGM sıcaklığı yok");
  const humidity = mgmNumber(row.nem);
  const windSpeed = mgmNumber(row.ruzgarHiz);
  const windDir = mgmNumber(row.ruzgarYon);
  const wind = windFromDegrees(windDir);
  const seaLevel = mgmNumber(row.denizeIndirgenmisBasinc);
  const stationP = mgmNumber(row.aktuelBasinc);
  return {
    station_name: "Eyüpsultan",
    station_id: STATION_ID,
    source: "MGM 18101",
    source_url: "https://servis.mgm.gov.tr/",
    latitude: 41.102778,
    longitude: 28.924167,
    elevation_m: 54,
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
    precipitation_daily_mm: mgmNumber(row.yagis00Now) ?? 0,
    precipitation_source: "MGM 18101",
    humidity_percent: humidity,
    dew_point_c: dewPoint(temp, humidity),
    station_pressure_hpa: seaLevel != null && seaLevel > 850 ? seaLevel : stationP,
    actual_station_pressure_hpa: stationP,
    pressure_type: seaLevel != null ? "mean_sea_level" : "station",
    pressure_source: "MGM 18101",
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
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

async function main() {
  const now = new Date();
  const observation = await fetchFromMgm();
  console.log("[MGM]", observation.temperature_2m_c + "°C", "1sa", observation.precipitation_1h_mm, "mm", "bugün", observation.precipitation_daily_mm, "mm", "age", observation.age_minutes, "dk");
  if (observation.precipitation_1h_mm == null) throw new Error("MGM saatlik yağış yok");

  const outDir = "public";
  fs.mkdirSync(outDir, { recursive: true });
  writeJsonAtomic(path.join(outDir, "eyupsultan-station-observation.json"), {
    schema: "gfs-watch.station-observation.v1",
    station_observation: observation,
    updated_at_utc: now.toISOString()
  });

  const historyPath = process.env.EYUPSULTAN_TEMPERATURE_HISTORY_PATH || path.join(outDir, "eyupsultan-station-temperature-history.json");
  const historyDocument = readJsonIfExists(historyPath) || { schema: HISTORY_SCHEMA, samples: [] };
  const samples = Array.isArray(historyDocument.samples) ? historyDocument.samples : [];
  const last = samples[samples.length - 1];
  const lastTime = last ? Date.parse(last.observed_at_utc) : 0;
  const curTime = Date.parse(observation.observed_at_utc);
  const sample = {
    logged_at_utc: now.toISOString(),
    observed_at_utc: observation.observed_at_utc,
    temperature_2m_c: observation.temperature_2m_c,
    precipitation_daily_mm: observation.precipitation_daily_mm,
    precipitation_1h_mm: observation.precipitation_1h_mm,
    station_pressure_hpa: observation.station_pressure_hpa
  };
  if (last && lastTime === curTime) {
    last.temperature_2m_c = sample.temperature_2m_c;
    last.precipitation_daily_mm = sample.precipitation_daily_mm;
    last.precipitation_1h_mm = sample.precipitation_1h_mm;
    last.station_pressure_hpa = sample.station_pressure_hpa;
    last.logged_at_utc = sample.logged_at_utc;
  } else if (!last || Math.abs(curTime - lastTime) > 60000) {
    samples.push(sample);
  }
  const cutoff = now.getTime() - 14 * 24 * 60 * 60 * 1000;
  const retained = samples.filter(item => Date.parse(item.logged_at_utc || item.observed_at_utc) >= cutoff).slice(-4500);
  writeJsonAtomic(historyPath, {
    schema: HISTORY_SCHEMA,
    station_id: STATION_ID,
    station_name: "Eyüpsultan",
    updated_at_utc: now.toISOString(),
    samples: retained
  });
  console.log("[DONE]", observation.temperature_2m_c + "°C", "age", observation.age_minutes, "min", observation.source);
}

main().catch(err => {
  console.error("[ERROR]", err?.stack || err);
  process.exitCode = 1;
});
