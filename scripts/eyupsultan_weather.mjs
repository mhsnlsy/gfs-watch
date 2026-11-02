import { chromium, request } from "playwright";
import fs from "node:fs";
import path from "node:path";

const STATION_URL = "https://wstatmap.com/tr/stations/eyupsultan-18101";
const MGM_STATIONS_URL = "https://servis.mgm.gov.tr/web/istasyonlar/il?plaka=34";
const MGM_OBSERVATIONS_URL = "https://servis.mgm.gov.tr/web/sondurumlar/ilTumSondurum?ilPlaka=34";
const STATION_ID = "18101";
const STALE_AFTER_MINUTES = 20;
const HISTORY_SCHEMA = "gfs-watch.station-temperature-history.v1";

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
  const dailyRain = parseNumber(text.match(/Bugün\s*([-+]?\d+(?:[,.]\d+)?)\s*mm\s*yağdı/i), "günlük yağış");
  const oneHourRain = parseNumber(text.match(/1sa\s*([-+]?\d+(?:[,.]\d+)?)/i), "1 saatlik yağış", false);

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
    station_pressure_hpa: null,
    actual_station_pressure_hpa: null,
    pressure_type: null,
    pressure_source: null,
    pressure_observed_at_utc: null,
    pressure_age_minutes: null
  };
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
      client.get(MGM_STATIONS_URL, { timeout: 20000 }),
      client.get(MGM_OBSERVATIONS_URL, { timeout: 20000 })
    ]);
    if (!stationsResponse.ok() || !observationsResponse.ok()) {
      throw new Error(`MGM servis yanıtı başarısız: istasyonlar ${stationsResponse.status()}, gözlemler ${observationsResponse.status()}`);
    }

    const [stations, observations] = await Promise.all([
      stationsResponse.json(),
      observationsResponse.json()
    ]);
    const station = Array.isArray(stations)
      ? stations.find(item => Number(item.istNo) === Number(STATION_ID))
      : null;
    if (!station || String(station.istAd || "").trim().toLocaleUpperCase("tr-TR") !== "EYÜPSULTAN") {
      throw new Error("MGM istasyon listesinde 18101 / EYÜPSULTAN eşleşmesi doğrulanamadı.");
    }
    if (Math.abs(Number(station.enlem) - 41.102778) > 0.01 || Math.abs(Number(station.boylam) - 28.924167) > 0.01) {
      throw new Error("MGM 18101 koordinatları beklenen Eyüpsultan istasyonuyla eşleşmiyor.");
    }

    const row = Array.isArray(observations)
      ? observations.find(item => Number(item.istNo) === Number(STATION_ID))
      : null;
    if (!row || !row.veriZamani) throw new Error("MGM 18101 için güncel gözlem satırı bulunamadı.");

    const observedAt = new Date(row.veriZamani);
    if (Number.isNaN(observedAt.getTime())) throw new Error("MGM basınç ölçüm zamanı geçersiz.");
    const ageMinutes = Math.max(0, (Date.now() - observedAt.getTime()) / 60000);
    if (ageMinutes > STALE_AFTER_MINUTES) throw new Error(`MGM 18101 basınç ölçümü eski: ${Math.round(ageMinutes)} dk.`);

    const seaLevelPressure = Number(row.denizeIndirgenmisBasinc);
    const stationPressure = Number(row.aktuelBasinc);
    const validSeaLevel = Number.isFinite(seaLevelPressure) && seaLevelPressure >= 850 && seaLevelPressure <= 1100;
    const validStation = Number.isFinite(stationPressure) && stationPressure >= 850 && stationPressure <= 1100;
    if (!validSeaLevel && !validStation) throw new Error("MGM 18101 basınç alanları geçerli değil.");

    return {
      station_pressure_hpa: validSeaLevel ? seaLevelPressure : null,
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

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, document) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(document, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, filePath);
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  let observation;
  try {
    const page = await browser.newPage({
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1440, height: 1000 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
    });
    const response = await page.goto(STATION_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!response || response.status() !== 200) {
      throw new Error(`WStatMap istasyon sayfası HTTP ${response?.status() ?? "yanıt yok"} döndürdü.`);
    }
    await page.waitForFunction(() => document.body && document.body.innerText.includes("18101"), { timeout: 20000 });
    await page.waitForTimeout(1500);
    const bodyText = await page.locator("body").innerText();
    if (/Just a moment|Checking your browser|Access denied/i.test(bodyText)) {
      throw new Error("WStatMap sayfası otomatik erişim doğrulaması gösterdi; veri alınmadı.");
    }
    observation = parseObservation(bodyText, new Date());
    if (observation.is_stale) {
      throw new Error(`WStatMap 18101 ölçümü ${observation.age_minutes} dk yaşında; 20 dk sınırını aştığı için eski veri yayımlanmadı.`);
    }
  } finally {
    await browser.close();
  }

  try {
    const pressure = await fetchMgmPressure();
    Object.assign(observation, pressure);
  } catch (error) {
    console.warn("[MGM PRESSURE] Basınç alınamadı; değer boş bırakıldı:", error?.message || error);
  }

  const previousPath = process.env.EYUPSULTAN_PREVIOUS_OBSERVATION_PATH;
  const previousDocument = readJsonIfExists(previousPath);
  const previous = previousDocument?.station_observation;
  if (previous?.observed_at_utc && String(previous.station_id) === STATION_ID) {
    const previousTime = Date.parse(previous.observed_at_utc);
    const currentTime = Date.parse(observation.observed_at_utc);
    if (Number.isFinite(previousTime) && Number.isFinite(currentTime)) {
      const backwardSkewMs = previousTime - currentTime;
      const comparisonFields = [
        "temperature_2m_c",
        "wind_speed_10m_kmh",
        "wind_direction_degrees",
        "precipitation_1h_mm",
        "precipitation_daily_mm",
        "humidity_percent",
        "station_pressure_hpa"
      ];
      const sameMeasurement = comparisonFields.every(
        field => (previous[field] ?? null) === (observation[field] ?? null)
      );

      // WStatMap displays observation age in whole minutes. While the same
      // reading remains on the page, that rounding can make a later poll's
      // calculated timestamp appear up to 2.5 minutes older. Preserve the
      // previous timestamp for an identical reading instead of rejecting it.
      if (backwardSkewMs > 150000) {
        throw new Error("WStatMap önceki yayımlanmış ölçümden belirgin biçimde daha eski veri döndürdü; eski ölçüm yayımlanmadı.");
      }
      if (backwardSkewMs > 0 && sameMeasurement) {
        observation.observed_at_utc = previous.observed_at_utc;
        observation.age_minutes = Math.max(
          0,
          Math.floor((Date.parse(observation.fetched_at_utc) - previousTime) / 60000)
        );
        observation.is_stale = observation.age_minutes > STALE_AFTER_MINUTES;
      }
    }
  }

  const now = new Date();
  const observationDocument = {
    schema: "gfs-watch.station-observation.v1",
    station_observation: observation,
    updated_at_utc: now.toISOString()
  };
  const outputPath = "public/eyupsultan-station-observation.json";
  writeJsonAtomic(outputPath, observationDocument);

  const historyPath = process.env.EYUPSULTAN_TEMPERATURE_HISTORY_PATH || "public/eyupsultan-station-temperature-history.json";
  const historyDocument = readJsonIfExists(historyPath);
  if (historyDocument && historyDocument.schema !== HISTORY_SCHEMA) {
    throw new Error("Eyüpsultan sıcaklık geçmişi şeması beklenenden farklı.");
  }
  const samples = Array.isArray(historyDocument?.samples) ? historyDocument.samples : [];
  const lastSample = samples.length ? samples[samples.length - 1] : null;
  const lastObservedTime = Date.parse(lastSample?.observed_at_utc || "");
  const currentObservedTime = Date.parse(observation.observed_at_utc || "");
  const sameSourceReading = Number.isFinite(lastObservedTime)
    && Number.isFinite(currentObservedTime)
    && Math.abs(currentObservedTime - lastObservedTime) <= 90000
    && Number(lastSample.temperature_2m_c) === Number(observation.temperature_2m_c)
    && Number(lastSample.precipitation_daily_mm) === Number(observation.precipitation_daily_mm);
  if (!observation.is_stale && !sameSourceReading && Number.isFinite(observation.temperature_2m_c)) {
    samples.push({
      logged_at_utc: now.toISOString(),
      observed_at_utc: observation.observed_at_utc,
      pressure_observed_at_utc: observation.pressure_observed_at_utc,
      temperature_2m_c: observation.temperature_2m_c,
      precipitation_daily_mm: observation.precipitation_daily_mm,
      station_pressure_hpa: observation.station_pressure_hpa,
      actual_station_pressure_hpa: observation.actual_station_pressure_hpa
    });
  }
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const retained = samples.filter(sample => {
    const time = Date.parse(sample?.logged_at_utc || "");
    return Number.isFinite(time) && time >= cutoff && Number.isFinite(Number(sample.temperature_2m_c));
  }).slice(-2016);
  writeJsonAtomic(historyPath, {
    schema: HISTORY_SCHEMA,
    station_id: STATION_ID,
    station_name: "Eyüpsultan",
    sampling_interval_minutes: 5,
    aggregation_interval_minutes: 30,
    retention_days: 7,
    sample_semantics: "one_point_per_distinct_source_observation",
    updated_at_utc: now.toISOString(),
    samples: retained
  });

  console.log(
    `[WSTAT LIVE] Eyüpsultan | ${observation.temperature_2m_c}°C | ${observation.wind_speed_10m_kmh} km/sa | ${observation.humidity_percent}% nem | ${observation.station_pressure_hpa} hPa | yağış ${observation.precipitation_daily_mm} mm | ölçüm yaşı ${observation.age_minutes} dk`
  );
  console.log("[WSTAT JSON]", JSON.stringify(observation));
}

main().catch(error => {
  console.error("[WSTAT ERROR]", error?.stack || error);
  process.exitCode = 1;
});
