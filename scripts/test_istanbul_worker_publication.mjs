import assert from "node:assert/strict";
import { buildIstanbulInteractiveSvg, buildIstanbulReportText } from "../istanbul-gfs-worker/src/publication.js";
import { renderIstanbulPhotoPng } from "../istanbul-gfs-worker/src/photo.js";

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
      { date_istanbul: "2026-11-04", temperature_min_c: 10, temperature_max_c: 18, precipitation_total_mm: 3.4, wind_speed_max_10m_kmh: 28 },
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
assert.ok(chart.body.includes("cloudflare-js-v1"));
assert.ok(chart.body.includes("fill: #0a1b29"));
assert.ok(chart.body.includes("fill: #102a3a"));

const photoPng = await renderIstanbulPhotoPng(chart.body);
assert.ok(photoPng.length > 1024);
assert.deepEqual([...photoPng.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

const report = buildIstanbulReportText(runs[3], new Date("2026-11-01T12:00:00Z"));
assert.ok(report.includes("İSTANBUL GFS TAHMİN RAPORU"));
assert.ok(report.includes("GÜNÜN KALANINDA"));
assert.ok(report.includes("ÖNÜMÜZDEKİ 3 GÜN"));
assert.ok(report.includes("SON DÖRT GFS") || report.includes("Son dört GFS") || report.includes("Son 4 GFS"));
assert.ok(report.length < 4096, "Telegram report must fit one text message");
console.log(JSON.stringify({
  ok: true,
  svg_bytes: new TextEncoder().encode(chart.body).length,
  common_valid_time_count: chart.common_valid_time_count,
  report_characters: report.length,
  telegram_photo_png_bytes: photoPng.length,
}));
