import fs from "node:fs";
import assert from "node:assert/strict";

const read = path => fs.readFileSync(path, "utf8");
const refresh = read("scripts/refresh_koy_climate.mjs");
const stationWorker = read("station-worker/src/index.js");
const climateWorker = read("koy-gfs-worker/src/index.js");
const climateUi = read("site/koy-climate.js");
const climateWorkflow = read(".github/workflows/koy-climate-refresh.yml");
const stationWorkflow = read(".github/workflows/deploy-stations-worker.yml");

assert.match(refresh, /models:\s*model/);
assert.match(refresh, /ARCHIVE_MIN_INTERVAL_MS = 4500/);
assert.match(refresh, /chunkYears = 25/);
assert.match(refresh, /waitForArchiveSlot/);
assert.match(refresh, /65000/);

assert.match(refresh, /row\.day\s*===\s*parts\.day/);
assert.match(refresh, /precipitation_normal_to_date/);
assert.match(refresh, /historicalEndYear/);
assert.match(refresh, /model === "cerra"/);
assert.match(refresh, /2021\s*:\s*2020/);
assert.match(refresh, /ON CONFLICT\(cache_key\) DO UPDATE/);
assert.doesNotMatch(refresh, /\bBEGIN\s*;/i);
assert.doesNotMatch(refresh, /\bCOMMIT\s*;/i);

assert.ok(stationWorker.includes("climateMonthMatch = path.match"));
assert.ok(stationWorker.includes("canakci"));
assert.match(stationWorker, /date\(fetched_at_utc, '\+3 hours'\)/);
assert.match(stationWorker, /MAX\(rain_00_now_mm\)/);
assert.match(stationWorker, /station_id:\s*String\(row\.istNo\s*\|\|\s*def\.station_id\)/);
assert.match(stationWorker, /temperature_coverage_percent/);

assert.match(climateWorker, /if \(path === "\/api\/climate"\)/);
assert.match(climateWorker, /getClimateCache\(env, model\)/);
assert.match(climateWorker, /Climate cache unavailable for model/);

assert.match(climateUi, /\/api\/climate\/month\/canakci/);
assert.ok(climateUi.includes("historicalDoc?.data?.model !== model"));
assert.match(climateUi, /aynı takvim günü/);
assert.doesNotMatch(climateUi, /CURRENT_API/);
assert.doesNotMatch(climateUi, /api\.open-meteo\.com\/v1\/forecast/);

assert.match(climateWorkflow, /workflow_run:/);
assert.match(climateWorkflow, /Deploy Cloudflare Station Service/);
assert.match(climateWorkflow, /Publish all three model caches in one atomic INSERT/);
assert.match(climateWorkflow, /Verify all three model caches through the public Cloudflare Worker/);
assert.match(climateWorkflow, /climate\/month\/canakci/);
assert.doesNotMatch(climateWorkflow, /\bBEGIN\s*;/i);
assert.doesNotMatch(climateWorkflow, /\bCOMMIT\s*;/i);

assert.match(stationWorkflow, /Verify the live Çanakçı monthly observation summary/);
assert.match(stationWorkflow, /station_id.*18223/);

console.log("Köy climate contracts passed: MGM month-to-date observations, same-calendar-day normals, independent model caches and atomic D1 publishing.");
