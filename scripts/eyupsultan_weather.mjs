import { chromium, request } from "playwright";
import fs from "node:fs";
import path from "node:path";

const STATION_URL = "https://wstatmap.com/tr/stations/eyupsultan-18101";
const MGM_STATIONS_URL = "https://servis.mgm.gov.tr/web/istasyonlar/il?plaka=34";
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

async function fetchFromMgm() {
  const client = await request.newContext({
    extraHTTPHeaders: {
      "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
      "Accept": "application/json",
      "Origin": "https://istanbul.mgm.gov.tr",
      "Referer": "https://istanbul.mgm.gov.tr/"
    }
  });
  try {
    const [stationsRes, obsRes] = await Promise.all([
      client.get(MGM_STATIONS_URL, { timeout: 15000 }),
      client.get(MGM_OBSERVATIONS_URL, { timeout: 15000 })
    ]);
    if (!stationsRes.ok() || !obsRes.ok()) throw new Error("MGM HTTP error");
    const [stations, observations] = await Promise.all([stationsRes.json(), obsRes.json()]);
    const station = Array.isArray(stations) ? stations.find(s => Number(s.istNo) === Number(STATION_ID)) : null;
    const row = Array.isArray(observations) ? observations.find(o => Number(o.istNo) === Number(STATION_ID)) : null;
    if (!row || !row.veriZamani) throw new Error("MGM row missing");

    const observedAt = new Date(row.veriZamani);
    const ageMinutes = Math.max(0, (Date.now() - observedAt.getTime()) / 60000);
    const temp = Number(row.sicaklik);
    const humidity = Number(row.nem);
    const windSpeed = Number(row.ruzgarHiz);
    const windDir = Number(row.ruzgarYon);
    const rain = Number(row.yagis00Now) || Number(row.yagis1saat) || 0;
    const seaLevel = Number(row.denizeIndirgenmisBasinc);
    const stationP = Number(row.aktuelBasinc);
    const dew = Number(row.yagis00Now); // placeholder, will try to compute or leave null

    if (!Number.isFinite(temp)) throw new Error("No temperature from MGM");

    const wind = windFromDegrees(windDir);
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
      wind_speed_10m_kmh: Number.isFinite(windSpeed) ? Math.round(windSpeed * 10) / 10 : null,
      wind_direction_degrees: Number.isFinite(windDir) ? windDir : null,
      wind_direction_cardinal: wind.cardinal,
      wind_direction_tr: wind.tr,
      precipitation_1h_mm: Number.isFinite(Number(row.yagis1saat)) ? Number(row.yagis1saat) : null,
      precipitation_daily_mm: Number.isFinite(rain) ? rain : 0,
      humidity_percent: Number.isFinite(humidity) ? humidity : null,
      dew_point_c: null,
      station_pressure_hpa: Number.isFinite(seaLevel) && seaLevel > 850 ? seaLevel : (Number.isFinite(stationP) ? stationP : null),
      actual_station_pressure_hpa: Number.isFinite(stationP) ? stationP : null,
      pressure_type: Number.isFinite(seaLevel) ? "mean_sea_level" : "station",
      pressure_source: "MGM 18101",
      pressure_observed_at_utc: observedAt.toISOString(),
      pressure_age_minutes: Math.round(ageMinutes * 10) / 10
    };
  } finally {
    await client.dispose();
  }
}

function writeJsonAtomic(p, data) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

async function main() {
  const now = new Date();
  let observation = null;

  // Prefer MGM API (reliable, no browser)
  try {
    observation = await fetchFromMgm();
    console.log("[MGM] Success:", observation.temperature_2m_c + "°C", "age", observation.age_minutes, "dk");
  } catch (err) {
    console.warn("[MGM] Failed:", err.message);
    // Fallback to WStatMap only if MGM fails
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(STATION_URL, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForTimeout(1500);
      const text = await page.locator("body").innerText();
      // minimal parse fallback
      const tempMatch = text.match(/([-+]?\d+(?:[,.]\d+)?)\s*°\s*C/);
      if (!tempMatch) throw new Error("No temp in fallback");
      observation = {
        station_name: "Eyüpsultan",
        station_id: STATION_ID,
        source: "WStatMap fallback",
        observed_at_utc: now.toISOString(),
        fetched_at_utc: now.toISOString(),
        age_minutes: 0,
        is_stale: false,
        temperature_2m_c: Number(tempMatch[1].replace(",", ".")),
        humidity_percent: null,
        wind_speed_10m_kmh: null,
        precipitation_daily_mm: 0,
        dew_point_c: null,
        station_pressure_hpa: null
      };
      console.log("[FALLBACK] Used WStatMap");
    } finally {
      await browser.close();
    }
  }

  if (!observation) throw new Error("No observation obtained");

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
  if (!last || Math.abs(curTime - lastTime) > 60000 || last.temperature_2m_c !== observation.temperature_2m_c) {
    samples.push({
      logged_at_utc: now.toISOString(),
      observed_at_utc: observation.observed_at_utc,
      temperature_2m_c: observation.temperature_2m_c,
      precipitation_daily_mm: observation.precipitation_daily_mm,
      station_pressure_hpa: observation.station_pressure_hpa
    });
  }
  const cutoff = now.getTime() - 14 * 24 * 60 * 60 * 1000;
  const retained = samples.filter(s => Date.parse(s.logged_at_utc || s.observed_at_utc) >= cutoff).slice(-4500);
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
