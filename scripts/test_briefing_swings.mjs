import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = fs.readFileSync(new URL("../site/home-app.js", import.meta.url), "utf8");
const clock = app.slice(app.indexOf("const meteoptCanonicalDateLabel"), app.indexOf("const symbolFor"));
const start = app.indexOf("function tableForecastDayKey");
const end = app.indexOf('window.addEventListener("meteopt-gfs-f72-updated"', start);
assert.ok(start > 0 && end > start, "briefing helpers must be present");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(clock + "\n" + app.slice(start, end), sandbox);

const now = Date.parse("2026-11-11T06:00:00Z");
const run = Date.parse("2026-11-11T00:00:00Z");
const points = [];
for (let step = 3; step <= 150; step += 3) {
  const iso = new Date(run + step * 3600000).toISOString();
  let temp = 16;
  let mm = 0;
  if (iso.startsWith("2026-11-14T12")) temp = 19.6;
  if (iso.startsWith("2026-11-14T15")) temp = 13.9;
  if (iso.startsWith("2026-11-14T18")) { temp = 12.3; mm = 2.3; }
  if (iso.startsWith("2026-11-14T21")) { temp = 11.6; mm = 6.1; }
  if (iso.startsWith("2026-11-15T00")) { temp = 11.1; mm = 11.8; }
  if (iso > "2026-11-15T00") temp = 11.6;
  if (iso.startsWith("2026-11-16T18")) mm = 3.2;
  if (iso.startsWith("2026-11-16T21")) mm = 1.1;
  points.push({
    valid_time_utc: iso,
    temperature_2m_c: temp,
    precipitation_6h_mm: mm,
    forecast_hour: step
  });
}

const swings = [...sandbox.temperatureSwingLines(points, now)];
assert.deepEqual(swings, ["Cumartesi · 12:00–15:00 −5,7°C"]);
const thresholdPoints = [
  { valid_time_utc: "2026-11-11T12:00:00Z", temperature_2m_c: 10, forecast_hour: 12 },
  { valid_time_utc: "2026-11-11T15:00:00Z", temperature_2m_c: 14.2, forecast_hour: 15 },
  { valid_time_utc: "2026-11-11T18:00:00Z", temperature_2m_c: 14.2, forecast_hour: 18 },
  { valid_time_utc: "2026-11-13T12:00:00Z", temperature_2m_c: 10, forecast_hour: 60 },
  { valid_time_utc: "2026-11-13T15:00:00Z", temperature_2m_c: 13.9, forecast_hour: 63 }
];
const thresholdSwings = [...sandbox.temperatureSwingLines(thresholdPoints, now)];
assert.deepEqual(thresholdSwings, ["Çarşamba · 12:00–15:00 +4,2°C"]);

const rain = [...sandbox.rainDayLines(points, now)];
assert.ok(rain.includes("Cumartesi · 18:00–21:00 · akşam · 8,4 mm"));
assert.ok(!rain.some(line => line.startsWith("Cumartesi") && line.includes("yağış yok")));
assert.ok(!rain.some(line => line.includes("00:00") && line.startsWith("Cumartesi")), "Sunday 00:00 rain stays on Sunday");
assert.ok(rain.includes("Çarşamba · yağış yok"));

const fromThursday = [...sandbox.rainDayLines(points, Date.parse("2026-11-12T06:00:00Z"))];
assert.ok(fromThursday.some(line => line.startsWith("Pazar") && line.includes("11,8")));
const fromFriday = [...sandbox.rainDayLines(points, Date.parse("2026-11-13T06:00:00Z"))];
assert.ok(fromFriday.some(line => line.startsWith("Pazartesi") && line.includes("18:00–21:00") && line.includes("akşam")));

const traced = points.map(point => point.valid_time_utc.startsWith("2026-11-14T15")
  ? { ...point, precipitation_6h_mm: 0.5 }
  : point);
const tracedRain = [...sandbox.rainDayLines(traced, now)].find(line => line.startsWith("Cumartesi"));
assert.equal(tracedRain, "Cumartesi · 15:00–21:00 · öğleden sonra–akşam · 8,9 mm");

console.log(JSON.stringify({ ok: true, swings, saturday: rain.find(line => line.startsWith("Cumartesi")) }));
