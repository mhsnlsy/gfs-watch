import assert from "node:assert/strict";
import { buildKoyInteractiveSvg, koySvgKeyMatches } from "../koy-gfs-worker/src/index.js";
import { buildPanelAxis } from "../shared/gfs-chart-axis.js";

function sixHourlySeries({ runId, precipByLead = {}, temperature = 10, temperature850 = 2, temperatureByLead = {}, temperature850ByLead = {}, wind = 12 }) {
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
    forecast_source: "meteopt",
    source: "MeteoPT GFS",
    run_id_utc: runId,
    published_at_utc: runId,
    forecast_6_hourly: points,
  };
}

function fourCycles(specForCycle) {
  const base = Date.parse("2026-11-14T06:00:00.000Z");
  return [0, 1, 2, 3].map(cycle => sixHourlySeries({
    runId: new Date(base + cycle * 6 * 3600000).toISOString(),
    ...specForCycle(cycle),
  }));
}

function axisTicks(svg, panelId) {
  const start = svg.indexOf('<g id="koy-panel-' + panelId + '">');
  assert.ok(start >= 0, "missing panel " + panelId);
  const next = svg.indexOf('<g id="koy-panel-', start + 10);
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

const modest = buildKoyInteractiveSvg({
  runs: fourCycles(cycle => ({
    precipByLead: { 6: cycle === 3 ? 9.8 : 4 },
    temperature: cycle === 3 ? 11.4 : 6.2,
    temperature850: cycle === 3 ? 3.2 : -4.4,
    wind: 12 + cycle,
  })),
});
assert.ok(modest, "four Köy cycles should render a comparison SVG");
assert.equal(modest.key, "media/koy-gfs-20261115T00Z-comparison.svg");
assert.ok(modest.body.includes('id="gfs-renderer-version">cloudflare-js-v9-homepage-identical</metadata>'));
assert.ok(modest.body.includes('<svg xmlns="http://www.w3.org/2000/svg" width="1152" height="838"'));
assert.ok(modest.body.includes('x="55" y="214" width="505" height="250"'));
assert.ok(modest.body.includes('x="592" y="493" width="505" height="250"'));
assert.ok(modest.body.includes('mm / 3 saat'), "precipitation panel must use the homepage 3-hour unit");
assert.ok(!modest.body.includes("comparison_precipitation_3h_mm"), "use the same raw per-point rainfall field as the homepage renderer");
const metadataMatch = modest.body.match(/<metadata id="gfs-interactive-data"><!\[CDATA\[([\s\S]*?)\]\]><\/metadata>/);
assert.ok(metadataMatch, "shared interactive metadata must be present");
const chartMetadata = JSON.parse(metadataMatch[1]);
assert.equal(chartMetadata.renderer, "cloudflare-js-v9-homepage-identical");
assert.equal(chartMetadata.panels.length, 4);
for (const panel of chartMetadata.panels) {
  assert.equal(panel.series.length, 4, "each panel must contain four GFS cycles");
  assert.equal(panel.valid_times.length, panel.series[0].values.length, "each series must align on the same valid-time axis");
}

assert.ok(!modest.body.includes("RÜZGÂR · GİDİŞ YÖNÜ"));
assert.equal(koySvgKeyMatches(
  "notifications/koy-gfs-20261115T00Z-comparison.svg",
  modest.key
), true);
assert.equal(koySvgKeyMatches(
  "notifications/koy-gfs-20261110T12Z-comparison.svg",
  modest.key
), false);
assert.ok(modest.body.includes('id="gfs-interactive-data"'));
assert.ok(modest.body.includes('"directions_deg"'), "Köy chart metadata must retain wind directions for the shared tooltip");
assert.ok(!modest.body.includes('data-latest-peak="true"'), "Y-axis ticks must not be bound to the latest-cycle peak");
assert.ok(modest.body.includes('class="gfs-latest-peak-marker"'));
assert.ok(!modest.body.includes("gfs-latest-trough-marker"), "flat Köy temperature series must not repeat the peak label");
assert.ok(modest.body.includes('data-latest-peak-value="9,8 mm"'));
assert.ok(!axisTicks(modest.body, "precipitation").includes("9,8"));

const modestPrecip = axisTicks(modest.body, "precipitation");
const modestTemp = axisTicks(modest.body, "temperature");
const modest850 = axisTicks(modest.body, "temperature_850");
const modestWind = axisTicks(modest.body, "wind_10m");
assert.equal(buildPanelAxis("precipitation_6h_mm", [[4], [4], [4], [9.8]]).step, 1);
assert.deepEqual(modestPrecip.slice().reverse(), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
assertIntegerTicks(modestPrecip, 1, { start: 0, nonnegative: true });
assertIntegerTicks(modestTemp, 5);
assert.ok(modestTemp.includes("5") && modestTemp.includes("15"));
assertIntegerTicks(modest850, 5);
assert.ok(modest850.includes("-5") && modest850.includes("5"));
assertIntegerTicks(modestWind, 10, { start: 0, nonnegative: true });
assert.ok(modestWind.includes("0") && modestWind.includes("20"));

const heavy = buildKoyInteractiveSvg({
  runs: fourCycles(cycle => ({
    precipByLead: { [cycle === 3 ? 12 : 30 - cycle * 6]: cycle === 0 ? 22 : cycle === 3 ? 9.8 : 1 },
    temperature: cycle === 3 ? 19.6 : 6.9,
    temperature850: cycle === 3 ? 11.9 : -6.1,
    wind: cycle === 0 ? 38 : 37,
  })),
});
const heavyPrecip = axisTicks(heavy.body, "precipitation");
assert.equal(buildPanelAxis("precipitation_6h_mm", [[22], [1], [1], [9.8]]).step, 2);
assert.deepEqual(heavyPrecip.slice().reverse(), ["0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20", "22"]);
assert.ok(!heavyPrecip.includes("9,8"));
assert.ok(heavy.body.includes('data-latest-peak-value="9,8 mm"'));
assert.ok(heavy.body.includes("15.11.2026 15:00 TSİ"));
assertIntegerTicks(axisTicks(heavy.body, "temperature"), 5);
assert.ok(axisTicks(heavy.body, "temperature").includes("15") && axisTicks(heavy.body, "temperature").includes("20"));
assert.ok(!axisTicks(heavy.body, "temperature").includes("5"), "older-cycle temperature must not widen the latest-cycle axis");
assertIntegerTicks(axisTicks(heavy.body, "temperature_850"), 5);
assert.ok(axisTicks(heavy.body, "temperature_850").includes("10") && axisTicks(heavy.body, "temperature_850").includes("15"));
assert.ok(!axisTicks(heavy.body, "temperature_850").includes("-10"), "older-cycle 850 hPa temperature must not widen the latest-cycle axis");
const heavyWind = axisTicks(heavy.body, "wind_10m");
assertIntegerTicks(heavyWind, 10, { start: 0, nonnegative: true });
assert.ok(heavyWind.includes("0") && heavyWind.includes("40"));
const heavyPrecipLatestOnly = axisTicks(heavy.body, "precipitation");
assert.deepEqual(heavyPrecipLatestOnly.slice().reverse(), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
assert.ok(!heavyPrecipLatestOnly.includes("22"), "older 22 mm precipitation peak must be outside the latest-cycle axis");

assert.equal(buildKoyInteractiveSvg({ runs: fourCycles(() => ({})).slice(0, 3) }), null);
assert.ok(!heavy.body.includes("gfs-latest-trough-marker"), "flat Köy latest temperatures must not repeat the peak label");

function panelChunk(svg, panelId) {
  const start = svg.indexOf('<g id="koy-panel-' + panelId + '">');
  const next = svg.indexOf('<g id="koy-panel-', start + 10);
  return next < 0 ? svg.slice(start) : svg.slice(start, next);
}
const troughChart = buildKoyInteractiveSvg({
  runs: fourCycles(cycle => ({
    temperature: 10,
    temperature850: 8,
    temperatureByLead: cycle === 3 ? { 6: 9.7, 18: 19.6 } : {},
    temperature850ByLead: cycle === 3 ? { 12: 3.4, 24: 12.2 } : {},
  })),
});
const troughTemp = panelChunk(troughChart.body, "temperature");
const trough850 = panelChunk(troughChart.body, "temperature_850");
assert.ok(troughTemp.includes('data-latest-peak-value="19,6 °C"'));
assert.ok(troughTemp.includes('data-latest-trough-value="9,7 °C"'));
assert.ok(trough850.includes('data-latest-peak-value="12,2 °C"'));
assert.ok(trough850.includes('data-latest-trough-value="3,4 °C"'));
assert.ok(!panelChunk(troughChart.body, "precipitation").includes("gfs-latest-trough-marker"));
assert.ok(!panelChunk(troughChart.body, "wind_10m").includes("gfs-latest-trough-marker"));

console.log(JSON.stringify({
  ok: true,
  svg_bytes: new TextEncoder().encode(modest.body).length,
  modest_precip_step: 1,
  heavy_precip_step: 2,
}));
