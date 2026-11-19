import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const appJs = fs.readFileSync("site/home-app.js", "utf8");
assert.match(appJs, /const STATIONS_API=\(window\.GFS_WATCH_API_BASE\|\|window\.location\.origin\)\+"\/api";/, "Station reads must use same-origin Cloudflare API gateway.");
assert.doesNotMatch(appJs, /gfs-watch-stations\.muhsin-ulusoy\.workers\.dev/, "Homepage app must not make cross-origin station API calls.");
assert.match(appJs, /Start weather data lanes immediately and independently/, "Station startup must not wait for PWA/push setup.");
const eyupsultanCollector = fs.readFileSync("scripts/eyupsultan_weather.mjs", "utf8");
const functionStart = appJs.indexOf("function renderStationTemperatureTrend");
const functionEnd = appJs.indexOf("function render(data)", functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, "Station history/switch functions must exist.");

const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) {
    const classes = new Set();
    nodes.set(id, {
      id,
      textContent: "",
      innerHTML: "",
      hidden: false,
      attributes: {},
      listeners: {},
      classList: {
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
        add(name) { classes.add(name); },
        contains(name) { return classes.has(name); }
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      children: [],
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children; this.innerHTML = ""; },
      querySelector() { return null; }
    });
  }
  return nodes.get(id);
}

const sandbox = {
  $: node,
  window: { addEventListener() {}, setInterval() { return 1; }, clearInterval() {} },
  setInterval() { return 1; },
  clearInterval() {},
  attachStationHistoryTooltip() {},
  safeRenderStationCard() {},
  document: {
    querySelector() { return null; },
    createElement(tagName) {
      return {
        tagName,
        className: "",
        textContent: "",
        children: [],
        style: {},
        setAttribute() {},
        addEventListener() {},
        appendChild(child) { this.children.push(child); return child; },
        classList: { add() {}, toggle() {} }
      };
    }
  },
  activeStation: "enka",
  enkaStationObservation: {
    station_name: "ENKA Balmumcu",
    station_id: "ENKA",
    temperature_2m_c: 8.4,
    wind_speed_10m_kmh: 6.2,
    wind_direction_tr: "Kuzey",
    precipitation_daily_mm: 0.8,
    precipitation_1h_mm: 0,
    humidity_percent: 72,
    station_pressure_hpa: 1018,
    observed_at_utc: new Date().toISOString(),
    is_stale: false
  },
  eyupsultanStationObservation: {
    station_name: "Eyüpsultan",
    station_id: "18101",
    temperature_2m_c: 16.5,
    wind_speed_10m_kmh: 8.6,
    wind_direction_tr: "Doğu-kuzeydoğu",
    precipitation_daily_mm: 3.7,
    precipitation_1h_mm: 0,
    humidity_percent: 89,
    station_pressure_hpa: null,
    observed_at_utc: new Date().toISOString(),
    is_stale: false
  },
  sisliStationObservation: {
    station_name: "Şişli",
    station_id: "18401",
    temperature_2m_c: 14.2,
    wind_speed_10m_kmh: 7.1,
    wind_direction_tr: "Kuzeybatı",
    precipitation_daily_mm: 0.4,
    precipitation_1h_mm: 0,
    humidity_percent: 81,
    station_pressure_hpa: 1016.2,
    observed_at_utc: new Date().toISOString(),
    is_stale: false
  },
  enkaStationHistorySamples: [],
  eyupsultanStationHistorySamples: [],
  sisliStationHistorySamples: [],
  sisliStationRainHistorySamples: [],
  eyupsultanStationRainHistorySamples: [],
  windDirectionTr: {},
  numeric: value => typeof value === "number" && Number.isFinite(value),
  fmt: (value, decimals = 1) => Number(value).toFixed(decimals).replace(".", ","),
  esc: value => String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]),
  symbolFor: () => "☁",
  timeTR: value => new Date(value).toISOString()
};

function sample(hoursAgo, temperature, dailyRain, rain10m = null) {
  const logged = new Date(Date.now() - hoursAgo * 3600000).toISOString();
  return {
    logged_at_utc: logged,
    observed_at_utc: logged,
    temperature_2m_c: temperature,
    precipitation_daily_mm: dailyRain,
    precipitation_10m_mm: rain10m
  };
}
const rainAnchor = Math.floor(Date.now() / 300000) * 300000;
function rainSample(minutesAgo, rain10m) {
  const stamp = new Date(rainAnchor - minutesAgo * 60000).toISOString();
  return {
    logged_at_utc: stamp,
    observed_at_utc: stamp,
    temperature_2m_c: 11,
    precipitation_daily_mm: 0.8,
    precipitation_10m_mm: rain10m
  };
}
const completedHourAnchor = Math.floor(Date.now() / 3600000) * 3600000;
function hourlyRainSample(minutesBeforeCurrentHour, precipitation1h) {
  const stamp = new Date(completedHourAnchor - minutesBeforeCurrentHour * 60000).toISOString();
  return {
    logged_at_utc: stamp,
    observed_at_utc: stamp,
    temperature_2m_c: 11,
    precipitation_daily_mm: 0.8,
    precipitation_1h_mm: precipitation1h
  };
}

sandbox.enkaStationHistorySamples = [
  sample(22, 7.1, 0.2),
  sample(12, 8.0, 0.5),
  sample(0.3, 8.4, 0.8)
];
sandbox.eyupsultanStationHistorySamples = [
  sample(22, 18.2, 2.0),
  sample(12, 17.3, 2.6),
  sample(0.3, 16.5, 3.7),
  rainSample(20, 0.1),
  rainSample(10, 0.2),
  rainSample(0, 0.3)
];
sandbox.eyupsultanStationObservation.observed_at_utc = new Date(rainAnchor).toISOString();
sandbox.eyupsultanStationObservation.precipitation_10m_mm = 0.3;
// The current chart plots the latest reading from each completed hour.
// Keep separate MGM rainfall archives so ENKA and Eyüpsultan source isolation
// is exercised without depending on the still-collecting 10-minute series.
sandbox.eyupsultanStationRainHistorySamples = [hourlyRainSample(30, 0.6)];
sandbox.sisliStationRainHistorySamples = [hourlyRainSample(30, 0.4)];

vm.createContext(sandbox);
vm.runInContext(appJs.slice(functionStart, functionEnd), sandbox, {
  filename: "site/index.html#station-history-functions"
});
// This test covers station switching and history charts only. Keep the separate
// forecast briefing renderer out of this DOM-light browser simulation.
sandbox.renderBriefing = () => {};

sandbox.selectStation("eyupsultan");
assert.equal(sandbox.activeStation, "eyupsultan");
assert.equal(node("station-card-title").textContent, "Eyüpsultan · İstanbul");
assert.equal(node("temperature").textContent, "16,5°");
assert.equal(node("history-station-source").textContent, "EYÜPSULTAN · GERÇEK ÖLÇÜMLER");
assert.equal(node("station-history-panel").attributes["aria-label"], "Eyüpsultan son 24 saat geçmişi");
assert.match(node("station-trend-meta").textContent, /Eyüpsultan/);
assert.match(node("station-rain-meta").textContent, /Eyüpsultan/);
assert.match(node("station-temperature-trend").innerHTML, /Eyüpsultan son 24 saat sıcaklık geçmişi/);
assert.match(node("station-rain-trend").innerHTML, /Eyüpsultan son 24 saatteki saatlik kayan yağış toplamı/);
assert.match(node("station-rain-trend").innerHTML, /0,6 mm \/ 1 saat/);
assert.match(node("station-rain-meta").textContent, /0,6 mm \/ 1 saat/);
assert.match(node("station-trend-meta").textContent, /30 dk ortalama/);
assert.match(node("station-rain-meta").textContent, /son tamamlanan saat/);
assert.match(node("history-source-note").textContent, /MGM Eyüpsultan ölçümleri/);
assert.doesNotMatch(node("station-trend-meta").textContent, /ENKA/);
assert.doesNotMatch(node("station-rain-meta").textContent, /ENKA/);

sandbox.selectStation("enka");
assert.equal(sandbox.activeStation, "enka");
assert.equal(node("station-card-title").textContent, "ENKA Balmumcu · İstanbul");
assert.equal(node("temperature").textContent, "8,4°");
assert.equal(node("history-station-source").textContent, "ENKA BALMUMCU · GERÇEK ÖLÇÜMLER");
assert.equal(node("station-history-panel").attributes["aria-label"], "ENKA Balmumcu son 24 saat geçmişi");
assert.match(node("station-trend-meta").textContent, /ENKA Balmumcu/);
assert.match(node("station-rain-meta").textContent, /ENKA Balmumcu · MGM · son tamamlanan saat/);
assert.match(node("station-temperature-trend").innerHTML, /ENKA Balmumcu son 24 saat sıcaklık geçmişi/);
assert.match(node("station-rain-trend").innerHTML, /ENKA Balmumcu son 24 saatteki saatlik kayan yağış toplamı/);
assert.match(node("station-rain-trend").innerHTML, /0,4 mm \/ 1 saat/);
assert.match(node("station-rain-meta").textContent, /0,4 mm \/ 1 saat/);
assert.match(node("station-trend-meta").textContent, /30 dk ortalama/);
assert.match(node("station-rain-meta").textContent, /son tamamlanan saat/);
assert.doesNotMatch(node("station-trend-meta").textContent, /Eyüpsultan/);
assert.match(node("history-source-note").textContent, /Yağış: MGM Şişli ölçümleri/);

assert.match(appJs, /function attachStationHistoryTooltip/);
assert.match(appJs, /station-history-tooltip-value/);
assert.match(appJs, /bucketMs=1800000/);
assert.match(appJs, /const STATION_HISTORY_API=key=>STATIONS_API\+"\/history\/"\+encodeURIComponent\(key\)\+"\?hours=72"/);
assert.match(appJs, /historyKeys=stationKey==="enka"\?\["enka","sisli"\]:\[stationKey\]/);
assert.match(appJs, /fetchStationsApi\("\/history\/".*encodeURIComponent\(key\).*hours=72/);
assert.match(appJs, /if\(station\.station_id==="18101"\)eyupsultanStationObservation=station/);
assert.match(eyupsultanCollector, /precipitation_10m_mm: observation\.precipitation_10m_mm/);
assert.match(eyupsultanCollector, /last\.precipitation_10m_mm = sample\.precipitation_10m_mm/);
console.log("Station history switch smoke tests passed: card, temperature trend, rainfall trend, source labels, and station isolation.");


// Köy Ev station-history contract regression:
// the Worker historically returned source_observed_at_utc while the chart
// renderer only read observed_at_utc/logged_at_utc. Verify normalization,
// pressure aliases, and that the normalized records produce real SVG charts.
const koyAppJs = fs.readFileSync("site/koy.js", "utf8");
const stationApiStart = koyAppJs.indexOf("async function getStation(path){");
const stationApiEnd = koyAppJs.indexOf("function pointsOf(run,max=180){", stationApiStart);
assert.ok(stationApiStart >= 0 && stationApiEnd > stationApiStart, "Köy station API adapter must exist.");
const virtualStart = koyAppJs.indexOf("function buildVirtualHomeObservation(source){");
const virtualEnd = koyAppJs.indexOf("function buildVirtualHomeHistory(source){", virtualStart);
assert.ok(virtualStart >= 0 && virtualEnd > virtualStart, "Köy Ev virtual observation adapter must exist.");
const chartStart = koyAppJs.indexOf("function svgStationHistory(");
const chartEnd = koyAppJs.indexOf("let activeStationTooltip", chartStart);
assert.ok(chartStart >= 0 && chartEnd > chartStart, "Köy station history chart renderer must exist.");

const hourAnchor = Math.floor(Date.now() / 3600000) * 3600000;
const sourceObservedAt = new Date(hourAnchor - 30 * 60000).toISOString();
const stationApiSandbox = {
  STATIONS_API: "https://stations.example.test/api",
  num: value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value),
  fmt: (value, decimals = 1) => value == null ? "—" : Number(value).toFixed(decimals).replace(".", ","),
  esc: value => String(value == null ? "" : value).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])),
  feelsLike: value => value,
  HOME_ELEVATION_M: 363,
  MGM_STATION_ELEVATION_M: 146,
  HOME_DELTA_M: 217,
  HOME_STANDARD_LAPSE_K_PER_KM: 6.5,
  MGM_HOME_TEMP_CORRECTION_C: 217 / 1000 * 6.5,
  fetch: async url => ({
    ok: true,
    json: async () => String(url).includes("/history/")
      ? {
          ok: true,
          count: 1,
          samples: [{
            source_observed_at_utc: sourceObservedAt,
            fetched_at_utc: new Date(hourAnchor - 29 * 60000).toISOString(),
            temperature_c: 12.2,
            humidity_percent: 100,
            pressure_hpa: 970.4,
            wind_speed_kmh: 0,
            rain_1h_mm: 1.6
          }]
        }
      : {
          ok: true,
          station: {
            station_id: "CANAKCI-DYNAMIC",
            station_name: "MGM Çanakçı",
            observed_at_utc: new Date().toISOString(),
            temperature_2m_c: 12.2,
            humidity_percent: 100,
            station_pressure_hpa: 970.4,
            actual_station_pressure_hpa: 970.4,
            wind_speed_10m_kmh: 0,
            precipitation_1h_mm: 1.6
          }
        }
  })
};
vm.createContext(stationApiSandbox);
const stationTestSource = [
  koyAppJs.slice(stationApiStart, stationApiEnd),
  koyAppJs.slice(virtualStart, virtualEnd),
  koyAppJs.slice(chartStart, chartEnd),
  "this.getKoyStation = getStation;",
  "this.buildKoyVirtualObservation = buildVirtualHomeObservation;",
  "this.renderKoyStationHistory = svgStationHistory;"
].join(String.fromCharCode(10));
vm.runInContext(
  stationTestSource,
  stationApiSandbox,
  {filename:"site/koy.js#station-history-contract"}
);

const koyHistory = await stationApiSandbox.getKoyStation("/history/canakci?hours=72");
assert.equal(koyHistory.samples[0].observed_at_utc, sourceObservedAt,
  "source_observed_at_utc must be normalized to observed_at_utc.");
assert.equal(koyHistory.samples[0].logged_at_utc, sourceObservedAt,
  "legacy chart timestamp alias must be populated.");
assert.equal(koyHistory.samples[0].temperature_2m_c, 12.2,
  "temperature_c must be normalized to temperature_2m_c.");
assert.equal(koyHistory.samples[0].precipitation_1h_mm, 1.6,
  "rain_1h_mm must be normalized to precipitation_1h_mm.");

const koyCurrent = await stationApiSandbox.getKoyStation("/stations/canakci");
assert.equal(koyCurrent.station.pressure_hpa, 970.4,
  "MGM station_pressure_hpa must be exposed as pressure_hpa.");
const koyHomeCurrent = stationApiSandbox.buildKoyVirtualObservation(koyCurrent.station);
assert.notEqual(koyHomeCurrent.pressure_hpa, null,
  "Köy Ev altitude correction must retain the available MGM pressure value.");

const temperatureSvg = stationApiSandbox.renderKoyStationHistory(
  koyHistory.samples, "temperature_2m_c", "Köy Ev sıcaklık", "°C"
);
const rainfallSvg = stationApiSandbox.renderKoyStationHistory(
  koyHistory.samples, "precipitation_1h_mm", "Köy Ev yağış", "mm"
);
assert.match(temperatureSvg, /<svg/,
  "normalized source timestamps must produce a temperature history chart.");
assert.match(rainfallSvg, /<svg/,
  "normalized source timestamps must produce a rainfall history chart.");
console.log("Köy station history regression passed: source timestamp alias, rainfall/temp charts, and pressure mapping.");
