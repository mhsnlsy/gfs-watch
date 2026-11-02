import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, request } from "playwright";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const STATION_URL = "https://wstatmap.com/tr/embed?station=eyupsultan-18101&radius=30&layer=temperature&user_station=false";
const WSTAT_DETAIL_URL = "https://api.wstatmap.com/v1/station/detail-by-slug/eyupsultan-18101/";
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

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > -900 ? number : null;
}

async function readUrl(url, accept) {
  const args = [
    "-sS", "--max-time", "25", "--http1.1",
    "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "-H", "accept-language: tr-TR,tr;q=0.9,en;q=0.8",
    "-H", "referer: " + STATION_URL,
    "-H", "origin: https://wstatmap.com",
    "-H", "accept: " + accept,
    "-w", "\n%{http_code}",
    url
  ];
  try {
    const { stdout } = await execFileAsync("curl", args, { maxBuffer: 2_000_000 });
    const text = String(stdout);
    const split = text.lastIndexOf("\n");
    const body = text.slice(0, split);
    const status = Number(text.slice(split + 1).trim());
    if (status >= 200 && status < 300 && body) return body;
    throw new Error("curl HTTP " + status + " " + body.replace(/\s+/g, " ").slice(0, 160));
  } catch (err) {
    console.warn("[WSTATMAP] curl:", err.message);
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": accept,
      "Accept-Language": "tr-TR,tr;q=0.9",
      "Referer": STATION_URL,
      "Origin": "https://wstatmap.com"
    }
  });
  if (!response.ok) throw new Error("WStatMap HTTP " + response.status);
  return response.text();
}

async function fetchFromWstat() {
  const data = JSON.parse(await readUrl(WSTAT_DETAIL_URL, "application/json"));
  const station = data.station || {};
  if (station.user_station || String(station.no) !== STATION_ID) {
    throw new Error("WStatMap istasyonu 18101 değil");
  }
  const observedAt = new Date(data.timestamp);
  if (Number.isNaN(observedAt.getTime())) throw new Error("WStatMap zamanı yok");
  const temp = finiteOrNull(data.temperature && data.temperature.temperature);
  if (temp == null) throw new Error("WStatMap sıcaklığı yok");
  const rain = data.precipitation || {};
  const wind = data.wind || {};
  const air = data.atmospheric || {};
  const ageMinutes = Math.max(0, (Date.now() - observedAt.getTime()) / 60000);
  const direction = windFromDegrees(finiteOrNull(wind.direction));
  const seaLevel = finiteOrNull(air.pressure);
  const stationP = finiteOrNull(air.actual_pressure);
  const daily = finiteOrNull(rain.total_daily);
  return {
    station_name: "Eyüpsultan",
    station_id: STATION_ID,
    source: "WStatMap · MGM 18101",
    source_url: STATION_URL,
    latitude: finiteOrNull(station.latitude) ?? 41.102778,
    longitude: finiteOrNull(station.longitude) ?? 28.924167,
    elevation_m: finiteOrNull(station.elevation) ?? 54,
    observed_at_utc: observedAt.toISOString(),
    fetched_at_utc: new Date().toISOString(),
    age_minutes: Math.round(ageMinutes),
    stale_after_minutes: STALE_AFTER_MINUTES,
    is_stale: ageMinutes > STALE_AFTER_MINUTES,
    temperature_2m_c: temp,
    wind_speed_10m_kmh: finiteOrNull(wind.speed),
    wind_direction_degrees: finiteOrNull(wind.direction),
    wind_direction_cardinal: direction.cardinal,
    wind_direction_tr: direction.tr,
    precipitation_1h_mm: finiteOrNull(rain["1h"]),
    precipitation_10m_mm: finiteOrNull(rain["10m"]),
    precipitation_6h_mm: finiteOrNull(rain["6h"]),
    precipitation_12h_mm: finiteOrNull(rain["12h"]),
    precipitation_24h_mm: finiteOrNull(rain["24h"]),
    precipitation_daily_mm: daily == null ? (finiteOrNull(rain.daily) ?? 0) : daily,
    precipitation_source: "WStatMap 1sa",
    humidity_percent: finiteOrNull(air.humidity),
    dew_point_c: finiteOrNull(data.temperature && data.temperature.dewpoint),
    station_pressure_hpa: seaLevel != null && seaLevel > 850 ? seaLevel : stationP,
    actual_station_pressure_hpa: stationP,
    pressure_type: seaLevel != null ? "mean_sea_level" : "station",
    pressure_source: "WStatMap · MGM 18101",
    pressure_observed_at_utc: observedAt.toISOString(),
    pressure_age_minutes: Math.round(ageMinutes * 10) / 10
  };
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
    if (!Object.prototype.hasOwnProperty.call(row, "yagis1Saat")) {
      throw new Error("MGM yagis1Saat alanı yok; saatlik yağış yazılmadı");
    }
    const rain = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > -900 ? number : null;
    };
    const rainToday = rain(row.yagis00Now);
    const rainHour = rain(row.yagis1Saat);
    const rain10 = rain(row.yagis10Dk);
    const rain6 = rain(row.yagis6Saat);
    const rain12 = rain(row.yagis12Saat);
    const rain24 = rain(row.yagis24Saat);
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
      precipitation_1h_mm: rainHour,
      precipitation_10m_mm: rain10,
      precipitation_6h_mm: rain6,
      precipitation_12h_mm: rain12,
      precipitation_24h_mm: rain24,
      precipitation_daily_mm: rainToday == null ? 0 : rainToday,
      precipitation_source: "MGM 18101 1sa",
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

async function fetchRainCups() {
  const html = await readUrl(STATION_URL, "text/html");
  const pairs = [...html.matchAll(/tabular-nums[^>]*>([^<]+)<\/span><span[^>]*>([^<]+)<\/span>/g)];
  const cups = {};
  for (const match of pairs) {
    const label = match[2].trim();
    const value = Number(match[1].trim().replace(",", "."));
    if (!Number.isFinite(value) || cups[label] != null) continue;
    cups[label] = value;
  }
  if (!Number.isFinite(cups["1sa"])) throw new Error("WStatMap 1sa cup missing");
  return cups;
}

function applyRainCups(observation, cups) {
  observation.precipitation_1h_mm = cups["1sa"];
  observation.precipitation_10m_mm = Number.isFinite(cups["10dk"]) ? cups["10dk"] : null;
  observation.precipitation_6h_mm = Number.isFinite(cups["6sa"]) ? cups["6sa"] : null;
  observation.precipitation_12h_mm = Number.isFinite(cups["12sa"]) ? cups["12sa"] : null;
  observation.precipitation_24h_mm = Number.isFinite(cups["24sa"]) ? cups["24sa"] : null;
  if (Number.isFinite(cups["Bugün"])) observation.precipitation_daily_mm = cups["Bugün"];
  observation.precipitation_source = "WStatMap 1sa";
  return observation;
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

  // Embed parametresi: station=eyupsultan-18101, user_station=false.
  // Harita sayfada yok; aynı istasyonun 1sa yağışı API'den okunur.
  try {
    observation = await fetchFromWstat();
    console.log("[WSTATMAP] Success:", observation.temperature_2m_c + "°C", "1sa", observation.precipitation_1h_mm, "mm", "age", observation.age_minutes, "dk");
  } catch (err) {
    console.warn("[WSTATMAP] Failed:", err.message);
  }

  if (!observation) try {
    observation = await fetchFromMgm();
    console.log("[MGM] Success:", observation.temperature_2m_c + "°C", "1sa", observation.precipitation_1h_mm, "mm", "age", observation.age_minutes, "dk");
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
  if (observation.precipitation_1h_mm == null) {
    const historyPathForPrevious = process.env.EYUPSULTAN_TEMPERATURE_HISTORY_PATH || "";
    const previousPath = historyPathForPrevious
      ? path.join(path.dirname(historyPathForPrevious), "eyupsultan-station-observation.json")
      : "";
    const previous = previousPath ? readJsonIfExists(previousPath) : null;
    const previousObservation = previous && previous.station_observation;
    const previousAt = previousObservation ? Date.parse(previousObservation.observed_at_utc || "") : NaN;
    const previousRain = previousObservation ? previousObservation.precipitation_1h_mm : null;
    if (Number.isFinite(previousRain) && Number.isFinite(previousAt) && Date.now() - previousAt < 30 * 60000) {
      observation.precipitation_1h_mm = previousRain;
      observation.precipitation_source = (previousObservation.precipitation_source || "WStatMap 1sa") + " · son sağlam";
      console.warn("[MGM] Saatlik yağış boş geldi, son sağlam değer tutuldu:", previousRain, "mm");
    }
  }

  if (observation.precipitation_source !== "WStatMap 1sa") {
    try {
      const cups = await fetchRainCups();
      applyRainCups(observation, cups);
      console.log("[WSTATMAP] 1sa", cups["1sa"], "mm · bugün", cups["Bugün"], "mm");
    } catch (err) {
      console.warn("[WSTATMAP] Saatlik yağış alınamadı:", err.message);
    }
  }

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
    precipitation_10m_mm: observation.precipitation_10m_mm,
    station_pressure_hpa: observation.station_pressure_hpa
  };
  const bucket = (time) => Math.floor(time / 600000);
  if (last && bucket(lastTime) === bucket(curTime)) {
    if (sample.precipitation_1h_mm != null) last.precipitation_1h_mm = sample.precipitation_1h_mm;
    if (sample.precipitation_10m_mm != null) last.precipitation_10m_mm = sample.precipitation_10m_mm;
    last.precipitation_daily_mm = sample.precipitation_daily_mm;
    last.temperature_2m_c = sample.temperature_2m_c;
    last.observed_at_utc = sample.observed_at_utc;
    last.logged_at_utc = sample.logged_at_utc;
  } else {
    samples.push(sample);
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
