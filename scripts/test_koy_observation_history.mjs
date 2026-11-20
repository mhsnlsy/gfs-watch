import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync("site/koy.html", "utf8");
const js = fs.readFileSync("site/koy-observation-history.js", "utf8");
const workflow = fs.readFileSync(".github/workflows/canakci-history-10m.yml", "utf8");
const testWorkflow = fs.readFileSync(".github/workflows/test-koy-observation-history.yml", "utf8");
const worker = fs.readFileSync("station-worker/src/index.js", "utf8");

assert.match(html, /<script src="\.\/koy-observation-history\.js\?v=[^"]+" defer><\/script>/);
assert.ok(html.includes('<div class="koy-climate-panel">'), "History anchor must exist in the Köy climate panel");
assert.match(js, /querySelector\("\.koy-climate-panel"\)/);
assert.match(js, /Geçmiş/);
assert.match(js, /aria-expanded/);
for (const token of ["24h", "48h", "7d", "30d", "Local", "UTC", "Add variable",
  "Wind Chill", "Heat Index", "Relative Humidity", "Wind Direction", "Pressure",
  "Precipitation 10m", "Precipitation 6h", "Precipitation 12h", "Precipitation 24h"]) {
  assert.ok(js.includes(token), "Missing UI feature: " + token);
}
assert.ok(workflow.includes('cron: "*/10 * * * *"'));
assert.ok(workflow.includes("/api/collect/canakci"));
assert.ok(workflow.includes("/api/history-graph/canakci?hours=24&bucket=10"));
assert.ok(testWorkflow.includes(".github/workflows/canakci-history-10m.yml"));
assert.ok(!testWorkflow.includes(".github/workflows/village-history.yml"));
assert.match(worker, /MAX_HISTORY_HOURS = 8760/);
assert.match(worker, /history-graph/);
assert.match(worker, /archiveHistory: !\(key === "canakci" && triggerSource === "cron"\)/);
assert.match(worker, /collectAll\(env, "cron"\)/);
console.log("Köy Observation History contract OK");