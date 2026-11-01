import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const STATION_URL = "https://wstatmap.com/tr/stations/eyupsultan-18101";
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
  const pressure = parseNumber(text.match(/Deniz Seviyesi Basıncı[\s\S]{0,100}?(\d{3,4}(?:[,.]\d+)?)/i), "deniz seviyesi basıncı", false);

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
  if (pressure !== null && (pressure < 850 || pressure > 1100)) throw new Error(`Basınç makul aralık dışında: ${pressure} hPa`);
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
    station_pressure_hpa: pressure,
    pressure_type: pressure === null ? null : "mean_sea_level"
  };
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
    const stationRequests = new Set();
    const stationResponses = [];
    page.on("request", request => {
      if (/wstatmap\\.com/i.test(request.url())) stationRequests.add(request.url());
    });
    page.on("response", async response => {
      if (!/wstatmap\\.com/i.test(response.url())) return;
      const contentType = response.headers()["content-type"] || "";
      stationResponses.push({url:response.url(),status:response.status(),contentType});
      if (/json|javascript|text/i.test(contentType)) {
        try {
          const body = await response.text();
          if (/api|station|history|observ|weather|data|graph/i.test(response.url()) || /pressure|basınç|history|historical|temperature|sıcaklık/i.test(body)) {
            console.log("[WSTAT RESOURCE]", JSON.stringify({url:response.url(),status:response.status(),contentType,body:body.slice(0,5000)}));
          }
        } catch {}
      }
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
    console.log("[WSTAT PAGE TEXT]", bodyText.slice(0,18000));
    for (const label of ["Deniz Seviyesi Basıncı","Basınç","Rüzgar Hızı","Nem","Geçmiş","Son 24","1sa"]) {
      const position = bodyText.toLocaleLowerCase("tr").indexOf(label.toLocaleLowerCase("tr"));
      if (position >= 0) console.log("[WSTAT FIELD]", label, JSON.stringify(bodyText.slice(Math.max(0,position-120),position+350)));
    }
    console.log("[WSTAT REQUESTS]", JSON.stringify([...stationRequests]));
    console.log("[WSTAT RESPONSES]", JSON.stringify(stationResponses));
    console.log("[WSTAT RESOURCES]", JSON.stringify(await page.evaluate(() => performance.getEntriesByType("resource").map(entry => entry.name).filter(name => /wstatmap/i.test(name)))));
    if (/Just a moment|Checking your browser|Access denied/i.test(bodyText)) {
      throw new Error("WStatMap sayfası otomatik erişim doğrulaması gösterdi; veri alınmadı.");
    }
    observation = parseObservation(bodyText, new Date());
  } finally {
    await browser.close();
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
  const duplicate = samples.some(sample => sample?.observed_at_utc === observation.observed_at_utc);
  if (!observation.is_stale && !duplicate && Number.isFinite(observation.temperature_2m_c)) {
    samples.push({
      logged_at_utc: now.toISOString(),
      observed_at_utc: observation.observed_at_utc,
      temperature_2m_c: observation.temperature_2m_c,
      precipitation_daily_mm: observation.precipitation_daily_mm
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
    aggregation_interval_minutes: 60,
    retention_days: 7,
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
