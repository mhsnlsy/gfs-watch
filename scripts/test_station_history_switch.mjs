import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("site/index.html", "utf8");
const functionStart = html.indexOf("function renderStationTemperatureTrend");
const functionEnd = html.indexOf("function render(data)", functionStart);
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
      addEventListener(name, callback) { this.listeners[name] = callback; }
    });
  }
  return nodes.get(id);
}

const sandbox = {
  $: node,
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
  enkaStationHistorySamples: [],
  eyupsultanStationHistorySamples: [],
  windDirectionTr: {},
  numeric: value => typeof value === "number" && Number.isFinite(value),
  fmt: (value, decimals = 1) => Number(value).toFixed(decimals).replace(".", ","),
  esc: value => String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]),
  symbolFor: () => "☁"
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

vm.createContext(sandbox);
vm.runInContext(html.slice(functionStart, functionEnd), sandbox, {
  filename: "site/index.html#station-history-functions"
});

sandbox.selectStation("eyupsultan");
assert.equal(sandbox.activeStation, "eyupsultan");
assert.equal(node("station-card-title").textContent, "Eyüpsultan · İstanbul");
assert.equal(node("temperature").textContent, "16,5°");
assert.equal(node("history-station-source").textContent, "EYÜPSULTAN · GERÇEK ÖLÇÜMLER");
assert.equal(node("station-history-panel").attributes["aria-label"], "Eyüpsultan son 24 saat geçmişi");
assert.match(node("station-trend-meta").textContent, /Eyüpsultan/);
assert.match(node("station-rain-meta").textContent, /Eyüpsultan/);
assert.match(node("station-temperature-trend").innerHTML, /Eyüpsultan son 24 saat sıcaklık geçmişi/);
assert.match(node("station-rain-trend").innerHTML, /Eyüpsultan son 24 saatteki kayan 30 dakika yağış toplamı/);
assert.match(node("station-rain-trend").innerHTML, /0,6 mm \/ 30 dk/);
assert.match(node("station-rain-meta").textContent, /0,6 mm \/ 30 dk/);
assert.match(node("station-trend-meta").textContent, /30 dk ortalama/);
assert.match(node("station-rain-meta").textContent, /üç çakışmayan 10 dk ölçüm/);
assert.doesNotMatch(node("station-trend-meta").textContent, /ENKA/);
assert.doesNotMatch(node("station-rain-meta").textContent, /ENKA/);

sandbox.selectStation("enka");
assert.equal(sandbox.activeStation, "enka");
assert.equal(node("station-card-title").textContent, "ENKA Balmumcu · İstanbul");
assert.equal(node("temperature").textContent, "8,4°");
assert.equal(node("history-station-source").textContent, "ENKA BALMUMCU · GERÇEK ÖLÇÜMLER");
assert.equal(node("station-history-panel").attributes["aria-label"], "ENKA Balmumcu son 24 saat geçmişi");
assert.match(node("station-trend-meta").textContent, /ENKA Balmumcu/);
assert.match(node("station-rain-meta").textContent, /ENKA Balmumcu/);
assert.match(node("station-temperature-trend").innerHTML, /ENKA Balmumcu son 24 saat sıcaklık geçmişi/);
assert.match(node("station-rain-trend").innerHTML, /Eyüpsultan son 24 saatteki kayan 30 dakika yağış toplamı/);
assert.match(node("station-rain-trend").innerHTML, /0,6 mm \/ 30 dk/);
assert.match(node("station-rain-meta").textContent, /0,6 mm \/ 30 dk/);
assert.match(node("station-trend-meta").textContent, /30 dk ortalama/);
assert.match(node("station-rain-meta").textContent, /üç çakışmayan 10 dk ölçüm/);
assert.doesNotMatch(node("station-trend-meta").textContent, /Eyüpsultan/);
assert.doesNotMatch(node("station-rain-meta").textContent, /Eyüpsultan/);

assert.match(html, /function attachStationHistoryTooltip/);
assert.match(html, /station-history-tooltip-value/);
assert.match(html, /bucketMs=1800000/);
assert.match(html, /EYUPSULTAN_STATION_HISTORY_URL/);
assert.match(html, /fetch\(EYUPSULTAN_STATION_HISTORY_URL/);
assert.match(html, /String\(historyDocument\.station_id\)==="18101"/);
console.log("Station history switch smoke tests passed: card, temperature trend, rainfall trend, source labels, and station isolation.");
