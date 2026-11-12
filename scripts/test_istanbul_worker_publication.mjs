import assert from "node:assert/strict";
import { buildIstanbulInteractiveSvg, buildIstanbulReportText } from "../istanbul-gfs-worker/src/publication.js";
import { loadIstanbulTelegramFont, renderIstanbulPhotoPng } from "../istanbul-gfs-worker/src/photo.js";
import { buildPanelAxis, seriesCalloutPlacement } from "../shared/gfs-chart-axis.js";

const base = Date.UTC(2026, 10, 1, 0, 0, 0);
const runs = [];
for (let cycle = 0; cycle < 4; cycle += 1) {
  const run = new Date(base + cycle * 6 * 3600000);
  const points = [];
  for (let lead = 6; lead <= 180; lead += 6) {
    const valid = new Date(run.getTime() + lead * 3600000);
    const localHour = (valid.getUTCHours() + 3) % 24;
    points.push({
      forecast_hour: lead,
      valid_time_utc: valid.toISOString(),
      temperature_2m_c: 12 + Math.sin(lead / 18) * 5 + cycle * 0.4,
      humidity_2m_percent: 62 + Math.round(Math.abs(Math.sin(lead / 24)) * 24) - cycle,
      temperature_850hpa_c: -2 + Math.cos(lead / 20) * 4 + cycle * 0.2,
      precipitation_6h_mm: localHour >= 12 && localHour <= 18 ? 1.2 + cycle * 0.1 : 0,
      wind_speed_10m_kmh: 15 + Math.abs(Math.sin(lead / 12)) * 18 + cycle,
      wind_direction_10m_deg: (210 + lead + cycle * 8) % 360,
    });
  }
  runs.push({
    run_id_utc: run.toISOString(),
    published_at_utc: run.toISOString(),
    forecast_6_hourly: points,
    daily_summary: [
      { date_istanbul: "2026-11-02", temperature_min_c: 9, temperature_max_c: 16, precipitation_total_mm: 2.1, wind_speed_max_10m_kmh: 24 },
      { date_istanbul: "2026-11-03", temperature_min_c: 8, temperature_max_c: 15, precipitation_total_mm: 0, wind_speed_max_10m_kmh: 17 },
      { date_istanbul: "2026-11-04", temperature_min_c: 10, temperature_max_c: 18, humidity_min_percent: 58, humidity_max_percent: 88, precipitation_total_mm: 3.4, wind_speed_max_10m_kmh: 28, wind_direction_max_10m_deg: 230 },
      { date_istanbul: "2026-11-05", temperature_min_c: 11, temperature_max_c: 19, humidity_min_percent: 55, humidity_max_percent: 82, precipitation_total_mm: 0, wind_speed_max_10m_kmh: 16 },
      { date_istanbul: "2026-11-06", temperature_min_c: 12, temperature_max_c: 20, humidity_min_percent: 48, humidity_max_percent: 79, precipitation_total_mm: 1.2, wind_speed_max_10m_kmh: 22, wind_direction_max_10m_deg: 45 },
    ],
  });
}

const earlyChart = buildIstanbulInteractiveSvg(runs.slice(0, 1));
assert.equal(earlyChart.key, "notifications/istanbul-gfs-20261101T00Z-comparison.svg");
assert.ok(earlyChart.common_valid_time_count >= 20, "single-cycle report should still have aligned valid times");
assert.ok(earlyChart.body.includes("1 döngü karşılaştırması"));

const chart = buildIstanbulInteractiveSvg(runs);
assert.match(chart.key, /^notifications\/istanbul-gfs-20261101T18Z-comparison\.svg$/);
assert.ok(chart.common_valid_time_count >= 20, "common UTC valid times should be aligned");
for (const id of ["patch_1", "patch_6", "patch_11", "patch_16", "patch_21", "gfs-interactive-data"]) {
  assert.ok(chart.body.includes(id), "SVG should include " + id);
}
function panelChunk(svg, panelId) {
  const start = svg.indexOf('<g id="istanbul-panel-' + panelId + '">');
  const next = svg.indexOf('<g id="istanbul-panel-', start + 10);
  return next < 0 ? svg.slice(start) : svg.slice(start, next);
}
const defaultTempPanel = panelChunk(chart.body, "temperature");
assert.ok(defaultTempPanel.includes('class="gfs-latest-trough-marker"'));
assert.ok(defaultTempPanel.includes('class="gfs-latest-peak-marker"'));
assert.ok(!panelChunk(chart.body, "precipitation").includes("gfs-latest-trough-marker"));
assert.ok(!panelChunk(chart.body, "wind_10m").includes("gfs-latest-trough-marker"));
const flatTempChart = buildIstanbulInteractiveSvg([
  sixHourlySeries({
    runId: "2026-11-15T00:00:00.000Z",
    precipByLead: { 6: 1 },
    temperature: 19.6,
    temperature850: 11.9,
  }),
]);
assert.ok(flatTempChart.body.includes('class="gfs-latest-peak-marker"'));
assert.ok(!flatTempChart.body.includes("gfs-latest-trough-marker"), "a flat latest temperature series must not repeat the peak label");
const troughChart = buildIstanbulInteractiveSvg([
  sixHourlySeries({
    runId: "2026-11-14T18:00:00.000Z",
    precipByLead: { 6: 1 },
    temperature: 8,
    temperature850: 1,
  }),
  sixHourlySeries({
    runId: "2026-11-15T00:00:00.000Z",
    precipByLead: { 6: 1 },
    temperature: 14,
    temperature850: 8,
    temperatureByLead: { 6: 9.7, 18: 19.6 },
    temperature850ByLead: { 12: 3.4, 24: 12.2 },
  }),
]);
const troughTemp = panelChunk(troughChart.body, "temperature");
const trough850 = panelChunk(troughChart.body, "temperature_850");
assert.ok(troughTemp.includes('data-latest-peak-value="19,6 °C"'));
assert.ok(troughTemp.includes('data-latest-trough-value="9,7 °C"'));
assert.ok(trough850.includes('data-latest-peak-value="12,2 °C"'));
assert.ok(trough850.includes('data-latest-trough-value="3,4 °C"'));
assert.equal(buildPanelAxis("temperature_2m_c", [[8], [9.7, 19.6, 14]]).latestTrough, 9.7);
assert.equal(buildPanelAxis("temperature_2m_c", [[19.6, 19.6]]).latestTrough, null);
assert.equal(buildPanelAxis("precipitation_6h_mm", [[0, 9.8]]).latestTrough, null);
assert.equal(buildPanelAxis("wind_speed_10m_kmh", [[12, 40]]).latestTrough, null);
const peakPlace = seriesCalloutPlacement({
  x: 100, y: 40, plotX: 50, plotY: 20, plotWidth: 400, plotHeight: 146, label: "19,6 °C"
});
const troughPlace = seriesCalloutPlacement({
  x: 110, y: 52, plotX: 50, plotY: 20, plotWidth: 400, plotHeight: 146, label: "9,7 °C",
  avoidBoxes: [peakPlace.box]
});
assert.equal(peakPlace.below, false);
assert.equal(troughPlace.below, true);
assert.ok(chart.body.includes("cloudflare-js-v3"));
assert.ok(chart.body.includes("fill: #0a1b29"));
assert.ok(chart.body.includes("fill: #102a3a"));
assert.ok(!chart.body.includes('data-latest-peak="true"'), "Y-axis ticks must not be bound to the latest-cycle peak");
assert.ok(chart.body.includes('class="gfs-latest-peak-marker"'), "latest-cycle peak should be marked on the series");

const fontCache = new Map();
const fontArchive = {
  async get(key) {
    const bytes = fontCache.get(key);
    return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null;
  },
  async put(key, bytes) {
    fontCache.set(key, new Uint8Array(bytes));
  },
};
const telegramFont = await loadIstanbulTelegramFont(fontArchive);
assert.ok(telegramFont.length > 100000, "Telegram Inter font should be loaded and cached");
const photoPng = await renderIstanbulPhotoPng(chart.body, telegramFont);
assert.ok(photoPng.length > 1024);
assert.deepEqual([...photoPng.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
const pngUInt32 = offset =>
  photoPng[offset] * 0x1000000 + photoPng[offset + 1] * 0x10000 +
  photoPng[offset + 2] * 0x100 + photoPng[offset + 3];
assert.equal(pngUInt32(16), 2048, "Telegram image should preserve homepage 2x2 chart canvas width");
assert.equal(pngUInt32(20), 1490, "Telegram image should preserve homepage 2x2 aspect ratio");

const stationObservation = {
  station_name: "ENKA Balmumcu",
  observed_at_utc: "2026-11-01T11:55:00Z",
  age_minutes: 5,
  temperature_2m_c: 13.2,
  humidity_percent: 81,
  station_pressure_hpa: 1018.4,
  wind_speed_10m_kmh: 11.1,
  wind_direction_cardinal: "NE",
  precipitation_daily_mm: 2.4,
  is_stale: false,
};
const report = buildIstanbulReportText(runs[3], new Date("2026-11-01T12:00:00Z"), stationObservation);
assert.ok(report.includes("İSTANBUL GFS · 18Z"));
assert.ok(report.includes("ÖNÜMÜZDEKİ 24 SAAT"));
assert.ok(report.includes("5 GÜNLÜK TAHMİN"));
assert.ok(report.includes("Kaynak: MeteoPT GFS"));
assert.ok(report.includes("ENKA BALMUMCU"));
assert.ok(report.includes("13,2°C"));
assert.ok(report.includes("2,4 mm"));
assert.ok(report.includes("ÖNÜMÜZDEKİ 24 SAAT"));
assert.ok(report.includes("Nem"));
assert.ok(report.includes("5 GÜNLÜK TAHMİN"));
assert.ok(report.includes("Cum 06.11"));
assert.ok(report.includes("YAĞIŞ ZAMANLARI · 72 SAAT"));
assert.ok(!report.includes("\n\n\n"), "Telegram report should not contain excessive blank lines");
const reportWithoutStation = buildIstanbulReportText(runs[3], new Date("2026-11-01T12:00:00Z"), null);
assert.ok(!reportWithoutStation.includes("ENKA BALMUMCU"));
assert.ok(!reportWithoutStation.includes("Ölçüm zamanı: —"));
assert.ok(reportWithoutStation.length < 4096);
assert.ok(report.length < 4096, "Telegram report must fit one text message");
console.log(JSON.stringify({
  ok: true,
  svg_bytes: new TextEncoder().encode(chart.body).length,
  common_valid_time_count: chart.common_valid_time_count,
  report_characters: report.length,
  telegram_photo_png_bytes: photoPng.length,
}));


function axisTicks(svg, panelId) {
  const start = svg.indexOf('<g id="istanbul-panel-' + panelId + '">');
  assert.ok(start >= 0, "missing panel " + panelId);
  const next = svg.indexOf('<g id="istanbul-panel-', start + 10);
  const chunk = next < 0 ? svg.slice(start) : svg.slice(start, next);
  return [...chunk.matchAll(/data-axis-tick="true"[^>]*>([^<]+)</g)].map(match => match[1]);
}

function assertIntegerTicks(ticks, step, { start, nonnegative = false } = {}) {
  assert.ok(ticks.length >= 2, "expected a fixed tick range, got " + ticks.join(","));
  const values = ticks.map(tick => Number(tick.replace(",", ".")));
  for (const value of values) {
    assert.ok(Number.isInteger(value), "tick must be a whole number: " + value);
    if (nonnegative) assert.ok(value >= 0, "tick must be >= 0: " + value);
    assert.equal(Math.abs(value) % step, 0, "tick " + value + " must follow step " + step);
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (start !== undefined) assert.equal(sorted[0], start, "range should start at " + start + ": " + ticks.join(","));
  for (let i = 1; i < sorted.length; i += 1) {
    assert.equal(sorted[i] - sorted[i - 1], step, "ticks must be evenly spaced: " + ticks.join(","));
  }
}

function sixHourlySeries({ runId, precipByLead, temperature = 10, temperature850 = 2, temperatureByLead = {}, temperature850ByLead = {}, wind = 12 }) {
  const startMs = Date.parse(runId);
  const points = [];
  for (let lead = 6; lead <= 180; lead += 6) {
    points.push({
      forecast_hour: lead,
      valid_time_utc: new Date(startMs + lead * 3600000).toISOString(),
      temperature_2m_c: temperatureByLead[lead] ?? temperature,
      humidity_2m_percent: 70,
      temperature_850hpa_c: temperature850ByLead[lead] ?? temperature850,
      precipitation_6h_mm: precipByLead[lead] || 0,
      wind_speed_10m_kmh: wind,
      wind_direction_10m_deg: 200,
    });
  }
  return {
    run_id_utc: runId,
    published_at_utc: runId,
    forecast_6_hourly: points,
  };
}

const defaultPrecipTicks = axisTicks(chart.body, "precipitation");
const defaultTempTicks = axisTicks(chart.body, "temperature");
const default850Ticks = axisTicks(chart.body, "temperature_850");
const defaultWindTicks = axisTicks(chart.body, "wind_10m");
assert.deepEqual(defaultPrecipTicks.slice().reverse(), ["0", "1", "2"]);
assertIntegerTicks(defaultPrecipTicks, 1, { start: 0, nonnegative: true });
assertIntegerTicks(defaultTempTicks, 5);
assertIntegerTicks(default850Ticks, 5);
assertIntegerTicks(defaultWindTicks, 10, { start: 0, nonnegative: true });
assert.ok(!defaultPrecipTicks.includes("9,8") && !defaultPrecipTicks.includes("1,5"));

const peakChart = buildIstanbulInteractiveSvg([
  sixHourlySeries({
    runId: "2026-11-14T18:00:00.000Z",
    precipByLead: { 12: 22 },
    temperature: 6.9,
    temperature850: -6.1,
    wind: 38,
  }),
  sixHourlySeries({
    runId: "2026-11-15T00:00:00.000Z",
    precipByLead: { 6: 9.8 },
    temperature: 19.6,
    temperature850: 11.9,
    wind: 37,
  }),
]);
const precipTicks = axisTicks(peakChart.body, "precipitation");
const tempTicks = axisTicks(peakChart.body, "temperature");
const ticks850 = axisTicks(peakChart.body, "temperature_850");
const windTicks = axisTicks(peakChart.body, "wind_10m");
assert.deepEqual(precipTicks.slice().reverse(), ["0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20", "22"]);
assert.equal(buildPanelAxis("precipitation_6h_mm", [[22], [9.8]]).step, 2);
assert.ok(!precipTicks.includes("9,8") && !peakChart.body.includes('data-latest-peak="true"'));
assert.ok(peakChart.body.includes('data-latest-peak-value="9,8 mm"'));
assert.ok(peakChart.body.includes("15.11.2026 09:00 TSİ"));
assert.ok(peakChart.body.includes('class="gfs-latest-peak-marker"'));
assertIntegerTicks(tempTicks, 5);
assert.ok(tempTicks.includes("5") && tempTicks.includes("20"));
assertIntegerTicks(ticks850, 5);
assert.ok(ticks850.includes("-10") && ticks850.includes("15"));
assertIntegerTicks(windTicks, 10, { start: 0, nonnegative: true });
assert.ok(windTicks.includes("0") && windTicks.includes("40"));

const modestChart = buildIstanbulInteractiveSvg([
  sixHourlySeries({
    runId: "2026-11-14T18:00:00.000Z",
    precipByLead: { 12: 4 },
    temperature: 6.9,
    temperature850: -6.1,
    wind: 18,
  }),
  sixHourlySeries({
    runId: "2026-11-15T00:00:00.000Z",
    precipByLead: { 6: 9.8 },
    temperature: 11,
    temperature850: 2,
    wind: 12,
  }),
]);
const modestPrecipTicks = axisTicks(modestChart.body, "precipitation");
assert.equal(buildPanelAxis("precipitation_6h_mm", [[4], [9.8]]).step, 1);
assert.deepEqual(modestPrecipTicks.slice().reverse(), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
assert.ok(!modestPrecipTicks.includes("9,8"));
assert.ok(modestChart.body.includes('data-latest-peak-value="9,8 mm"'));

const atThreshold = buildPanelAxis("precipitation_6h_mm", [[0, 16]]);
const aboveThreshold = buildPanelAxis("precipitation_6h_mm", [[16.1]]);
assert.equal(atThreshold.step, 1);
assert.equal(atThreshold.ticks.at(-1), 17);
assert.equal(atThreshold.ticks[1] - atThreshold.ticks[0], 1);
assert.equal(aboveThreshold.step, 2);
assert.deepEqual(aboveThreshold.ticks, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
