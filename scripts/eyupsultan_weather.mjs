import { chromium, request } from "playwright";
import fs from "node:fs";
import path from "node:path";

const STATION_URL = "https://wstatmap.com/tr/stations/eyupsultan-18101";
const MGM_STATIONS_URL = "https://servis.mgm.gov.tr/web/istasyonlar/il?plaka=34";
const MGM_OBSERVATIONS_URL = "https://servis.mgm.gov.tr/web/sondurumlar/ilTumSondurum?ilPlaka=34";
const STATION_ID = "18101";
const STALE_AFTER_MINUTES = 120; // More tolerant
const HISTORY_SCHEMA = "gfs-watch.station-temperature-history.v1";
const MAX_RETRIES = 3;

const parseNumber = (match, label, required = true) => {
  if (!match) {
    if (required) throw new Error(`WStatMap sayfasında ${label} alanı bulunamadı.`);
    return null;
  }
  const value = Number(match[1].replace(",", "."));
  if (!Number.isFinite(value)) throw new Error(`WStatMap ${label} değeri geçersiz.`);
  return value;
};

const directions = [
  ["Kuzey", "N"], ["Kuzey-kuzeydoğu", "NNE"], ["Kuzeydoğu", "NE"],
  ["Doğu-kuzeydoğu", "ENE"], ["Doğu", "E"], ["Doğu-güneydoğu", "ESE"],
  ["Güneydoğu", "SE"], ["Güney-güneydoğu", "SSE"], ["Güney", "S"],
  ["Güney-güneybatı", "SSW"], ["Güneybatı", "SW"], ["Batı-güneybatı", "WSW"],
  ["Batı", "W"], ["Batı-kuzeybatı", "WNW"], ["Kuzeybatı", "NW"],
  ["Kuzey-kuzeybatı", "NNW"]
];

function parseObservation(text, fetchedAt) {
  if (!text.includes(STATION_ID) || !/Eyüpsultan/i.test(text)) {
    throw new Error("Sayfa beklenen Eyüpsultan 18101 istasyonuna ait değil.");
  }

  const temperature = parseNumber(text.match(/([-+]?\d+(?:[,.]\d+)?)\s*°\s*C/), "sıcaklık");
  const humidity = parseNumber(text.match(/Nem\s*([-+]?\d+(?:[,.]\d+)?)\s*%/i), "nem");
  const windSpeed = parseNumber(text.match(/Rüzgar Hızı\s*([-+]?\d+(?:[,.]\d+)?)\s*km\/h/i), "rüzgâr hızı");
  const directionMatch = text.match(/Rüzgar Yönü\s*(\d{1,3})\s*°/i);
  const windDegrees = directionMatch ? Number(directionMatch[1]) % 360 : null;
  const windIndex = windDegrees === null ? null : Math.floor((windDegrees + 11.25) / 22.5) % 16;
  const dailyRainMatch =
    text.match(/Bugüne\s+kadar\s+([-+]?\d+(?:[,.]\d+)?)\s*mm\s+yağış\s+düştü/i)
    || text.match(/Bugün[^\n]{0,180}?([-+]?\d+(?:[,.]\d+)?)\s*mm\s+yağış/i)
    || text.match(/Bugün\s+([-+]?\d+(?:[,.]\d+)?)\s*mm\s*yağdı/i);
  const dailyRain = parseNumber(dailyRainMatch, "günlük yağış");
  const oneHourRain = parseNumber(text.match(/1sa\s*([-+]?\d+(?:[,.]\d+)?)/i), "1 saatlik yağış", false);
  const dewPointMatch = text.match(/Çiğ Noktası\s*([-+]?\d+(?:[,.]\d+)?)/i);
  const dewPoint = dewPointMatch ? Number(dewPointMatch[1].replace(",", ".")) : null;

  const ageMatch = text.match(/Canlı\s*[·•]\s*(\d+)\s*dk\.?\s*önce\s*[·•]\s*18101/i)
    || text.match(/Canlı\s*[·•]\s*(\d+)\s*dk\.?\s*önce/i);
  if (!ageMatch) throw new Error("WStatMap sayfasında ölçüm yaşı okunamadı.");
  const ageMinutes = Math.max(0, Number(ageMatch[1]));
  const observedAt = new Date(fetchedAt.getTime() - ageMinutes * 60000);
  const wind = windIndex === null ? { tr: null, cardinal: null } : {
    tr: directions[windIndex][0], cardinal: directions[windIndex][1]
  };

  if (temperature < -35 || temperature > 55) throw new Error(`Sıcaklık makul aralık dışında: ${temperature}°C`);
  if (humidity < 0 || humidity > 100) throw new Error(`Nem makul aralık dışında: ${humidity}%`);
  if (windSpeed < 0 || windSpeed > 250) throw new Error(`Rüzgâr makul aralık dışında: ${windSpeed} km/h`);
  if (dailyRain < 0 || (oneHourRain !== null && oneHourRain < 0)) throw new Error("Yağış değeri negatif olamaz.");

  return {
    station_name: "Eyüpsultan",
    station_id: STATION_ID,
    wstatmap_station_id: "1963",
    source: "WStatMap · MGM 18101",
    source_url: STATION_URL,
    latitude: 41.102778,
    longitude: 28.924167,
    elevation_m: 54,
    observed_at_utc: observedAt.toISOString(),
    fetched_at_utc: fetchedAt.toISOString(),
    age_minutes: ageMinutes,
    stale_after_minutes: STALE_AFTER_MINUTES,
    is_stale: ageMinutes > STALE_AFTER_MINUTES,
    temperature_2m_c: temperature,
    wind_speed_10m_kmh: Math.round(windSpeed * 10) / 10,
    wind_direction_degrees: windDegrees,
    wind_direction_cardinal: wind.cardinal,
    wind_direction_tr: wind.tr,
    precipitation_1h_mm: oneHourRain,
    precipitation_daily_mm: dailyRain,
    humidity_percent: humidity,
    dew_point_c: dewPoint,
    station_pressure_hpa: null,
    actual_station_pressure_hpa: null,
    pressure_type: null,
    pressure_source: null,
    pressure_observed_at_utc: null,
    pressure_age_minutes: null
  };
}

async function fetchWithRetry(page, url, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      if (response && response.status() === 200) {
        await page.waitForFunction(() => document.body && document.body.innerText.includes("18101"), { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);
        return await page.locator("body").innerText();
      }
    } catch (e) {
      console.warn(`[RETRY ${i+1}/${retries}] ${e.message}`);
      if (i === retries - 1) throw e;
      await page.waitForTimeout(2000 * (i + 1));
    }
  }
  throw new Error("Tüm denemeler başarısız.");
}

async function fetchMgmPressure() {
  const client = await request.newContext({
    extraHTTPHeaders: {
      "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0; station observation client)",
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://istanbul.mgm.gov.tr",
      "Referer": "https://istanbul.mgm.gov.tr/sondurum/turkiye.aspx"
    }
  });
  try {
    const [stationsResponse, observationsResponse] = await Promise.all([
      client.get(MGM_STATIONS_URL, { timeout: 15000 }),
      client.get(MGM_OBSERVATIONS_URL, { timeout: 15000 })
    ]);
    if (!stationsResponse.ok() || !observationsResponse.ok()) {
      throw new Error(`MGM servis yanıtı başarısız`);
    }
    const [stations, observations] = await Promise.all([stationsResponse.json(), observationsResponse.json()]);
    const station = Array.isArray(stations) ? stations.find(item => Number(item.istNo) === Number(STATION_ID)) : null;
    if (!station) throw new Error("MGM istasyon eşleşmedi");
    const row = Array.isArray(observations) ? observations.find(item => Number(item.istNo) === Number(STATION_ID)) : null;
    if (!row || !row.veriZamani) throw new Error("MGM gözlem yok");
    const observedAt = new Date(row.veriZamani);
    const ageMinutes = Math.max(0, (Date.now() - observedAt.getTime()) / 60000);
    const seaLevelPressure = Number(row.denizeIndirgenmisBasinc);
    const stationPressure = Number(row.aktuelBasinc);
    const validSeaLevel = Number.isFinite(seaLevelPressure) && seaLevelPressure >= 850 && seaLevelPressure <= 1100;
    const validStation = Number.isFinite(stationPressure) && stationPressure >= 850 && stationPressure <= 1100;
    if (!validSeaLevel && !validStation) throw new Error("Basınç geçersiz");
    return {
      station_pressure_hpa: validSeaLevel ? seaLevelPressure : stationPressure,
      actual_station_pressure_hpa: validStation ? stationPressure : null,
      pressure_type: validSeaLevel ? "mean_sea_level" : "station",
      pressure_source: "MGM 18101",
      pressure_observed_at_utc: observedAt.toISOString(),
      pressure_age_minutes: Math.round(ageMinutes * 10) / 10
    };
  } finally {
    await client.dispose();
  }
}

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function writeJsonAtomic(p, data) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

async function main() {
  const now = new Date();
  let observation = null;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
      "Cache-Control": "no-cache"
    });
    const bodyText = await fetchWithRetry(page, STATION_URL);
    if (/Just a moment|Checking your browser|Access denied/i.test(bodyText)) {
      throw new Error("WStatMap erişim doğrulaması");
    }
    observation = parseObservation(bodyText, now);
    if (observation.is_stale) {
      console.warn(`[WSTAT STALE] Ölçüm ${observation.age_minutes} dk yaşında. Yine de yayınlanıyor.`);
    }
  } finally {
    await browser.close();
  }

  try {
    const pressure = await fetchMgmPressure();
    Object.assign(observation, pressure);
  } catch (error) {
    console.warn("[MGM PRESSURE] Alınamadı:", error?.message || error);
  }

  const outDir = "public";
  fs.mkdirSync(outDir, { recursive: true });
  const obsPath = path.join(outDir, "eyupsultan-station-observation.json");
  writeJsonAtomic(obsPath, {
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
  const isNew = !last || Math.abs(curTime - lastTime) > 60000 || last.temperature_2m_c !== observation.temperature_2m_c;
  if (isNew && Number.isFinite(observation.temperature_2m_c)) {
    samples.push({
      logged_at_utc: now.toISOString(),
      observed_at_utc: observation.observed_at_utc,
      temperature_2m_c: observation.temperature_2m_c,
      precipitation_daily_mm: observation.precipitation_daily_mm,
      station_pressure_hpa: observation.station_pressure_hpa
    });
  }
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const retained = samples.filter(s => Date.parse(s.logged_at_utc) >= cutoff).slice(-2016);
  writeJsonAtomic(historyPath, {
    schema: HISTORY_SCHEMA,
    station_id: STATION_ID,
    station_name: "Eyüpsultan",
    sampling_interval_minutes: 5,
    updated_at_utc: now.toISOString(),
    samples: retained
  });

  console.log(`[WSTAT LIVE] Eyüpsultan | ${observation.temperature_2m_c}°C | ${observation.humidity_percent}% | ${observation.age_minutes} dk${observation.is_stale ? " (STALE)" : ""}`);
}

main().catch(err => {
  console.error("[WSTAT ERROR]", err?.stack || err);
  process.exitCode = 1;
});
