import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync("site/koy.html","utf8");
const js = fs.readFileSync("site/koy-observation-history.js","utf8");
const workflow = fs.readFileSync(".github/workflows/village-history.yml","utf8");

assert.match(html, /koy-observation-history\.js/);
assert.match(js, /24h/);
assert.match(js, /48h/);
assert.match(js, /7d/);
assert.match(js, /30d/);
assert.match(js, /Local/);
assert.match(js, /UTC/);
assert.match(js, /Add variable/);
assert.match(js, /Wind Chill/);
assert.match(js, /Precipitation 24h/);
assert.match(workflow, /cron: "\\*\/10 \\* \\* \\* \*"/);
assert.match(workflow, /api\/collect\/canakci/);
console.log("Köy Observation History contract OK");
