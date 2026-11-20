import assert from "node:assert/strict";
import { refreshClimateAll, climateTick, refreshClimateModel } from "../koy-gfs-worker/src/climate-nightly.js";

// Offline end-to-end test of the Cloudflare nightly path: fake Open-Meteo + fake D1.
// The core waits between archive requests; make that instant for the test.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, 0, ...a);

const calls = [];
let failModel = null;
let limitOnce = null;
globalThis.fetch = async url => {
  const u = new URL(url);
  const model = u.searchParams.get("models");
  calls.push(model + " " + u.searchParams.get("start_date") + ".." + u.searchParams.get("end_date"));
  if (model === failModel) return new Response("upstream down", { status: 503 });
  if (model === limitOnce) { limitOnce = null; return new Response("slow down", { status: 429, headers: { "retry-after": "0" } }); }
  const vars = u.searchParams.get("daily").split(",");
  const time = [];
  for (let t = Date.parse(u.searchParams.get("start_date") + "T00:00:00Z"); t <= Date.parse(u.searchParams.get("end_date") + "T00:00:00Z"); t += 86400000) {
    time.push(new Date(t).toISOString().slice(0, 10));
  }
  const daily = { time };
  for (const v of vars) {
    daily[v] = time.map((d, i) => {
      const y = Number(d.slice(0, 4)), day = Number(d.slice(8, 10));
      if (v.startsWith("temperature_2m_mean")) return 8 + (y % 7) * 0.5 + (day % 5) * 0.2;
      if (v === "temperature_2m_max") return 12 + (y % 7) * 0.5;
      if (v === "temperature_2m_min") return 4 + (y % 7) * 0.5;
      if (v === "precipitation_sum") return (y + day) % 4 === 0 ? 3.5 : 0;
      return 5 + (day % 4);
    });
  }
  return new Response(JSON.stringify({ daily }), { status: 200 });
};

function fakeD1() {
  const rows = new Map();
  return {
    rows,
    GFS_DB: {
      prepare: sql => ({
        bind: (...args) => ({
          async run() {
            if (sql.startsWith("INSERT INTO climate_cache")) {
              rows.set(args[0], { cache_key: args[0], model: args[1], period_date: args[2], payload_json: args[3], updated_at_utc: args[4] });
            } else if (sql.startsWith("DELETE FROM climate_cache")) {
              for (const [k, r] of rows) if (r.period_date < args[0]) rows.delete(k);
            } else throw new Error("unexpected run: " + sql);
            return {};
          },
          async all() {
            assert.match(sql, /WHERE period_date = \?/);
            return { results: [...rows.values()].filter(r => r.period_date === args[0]).map(r => ({ model: r.model })) };
          },
        }),
      }),
    },
  };
}

const NIGHT = new Date("2026-11-20T01:30:00Z");   // 04:30 Istanbul
const EARLY = new Date("2026-11-20T01:40:00Z");   // 04:40 Istanbul, before the tick window
const LATE = new Date("2026-11-20T01:50:00Z");    // 04:50 Istanbul

// --- nightly: all three models land, with the real long-term numbers
{
  const env = fakeD1();
  const out = await refreshClimateAll(env, NIGHT);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([...env.rows.keys()].sort(), ["cerra:2026-11-20", "era5:2026-11-20", "era5_land:2026-11-20"]);
  for (const row of env.rows.values()) {
    const p = JSON.parse(row.payload_json);
    assert.equal(p.schema, "koy-climate.v2");
    assert.equal(p.refreshed_by, "cloudflare-worker");
    assert.equal(p.period_date, "2026-11-20");
    assert.ok(row.payload_json.length < 90000);
    assert.ok(p.long_term.min_c <= p.long_term.avg_c && p.long_term.avg_c <= p.long_term.max_c);
    assert.ok(p.same_day_history.length >= 20);
  }
  const cerra = JSON.parse(env.rows.get("cerra:2026-11-20").payload_json);
  assert.deepEqual([cerra.historical_end_year <= 2021, cerra.historical_start_year >= 1985], [true, true]);
  const land = JSON.parse(env.rows.get("era5_land:2026-11-20").payload_json);
  assert.deepEqual(land.supported, { temperature: true, precipitation: false, wind: false });
  assert.equal(land.long_term.record_daily_precipitation_mm, null);

  // after a complete night the 10-minute tick has nothing to do and makes no calls
  const before = calls.length;
  assert.deepEqual(await climateTick(env, LATE), { idle: true, reason: "cache-current" });
  assert.equal(calls.length, before);
}

// --- one failing model must not discard the others, and the tick repairs it
{
  const env = fakeD1();
  failModel = "era5";
  const out = await refreshClimateAll(env, NIGHT);
  assert.equal(out.ok, false);
  assert.deepEqual(out.results.map(r => r.ok), [true, false, true]);
  assert.match(out.results[1].error, /HTTP 503/);
  assert.deepEqual([...env.rows.keys()].sort(), ["cerra:2026-11-20", "era5_land:2026-11-20"]);

  assert.deepEqual(await climateTick(env, EARLY), { idle: true, reason: "before-nightly-window" });
  failModel = "era5";
  const stillFailing = await climateTick(env, LATE);
  assert.equal(stillFailing.ok, false);
  assert.equal(stillFailing.model, "era5");
  assert.equal(env.rows.size, 2, "no partial row is written on failure");

  failModel = null;
  const repaired = await climateTick(env, LATE);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.model, "era5");
  assert.equal(env.rows.size, 3);
  assert.deepEqual(await climateTick(env, LATE), { idle: true, reason: "cache-current" });
}

// --- a 429 is retried by the core, not surfaced as a failure
{
  const env = fakeD1();
  limitOnce = "cerra";
  const r = await refreshClimateModel(env, "cerra", NIGHT);
  assert.equal(r.model, "cerra");
  assert.ok(env.rows.has("cerra:2026-11-20"));
}

// --- old rows are pruned, yesterday's row survives until replaced
{
  const env = fakeD1();
  env.rows.set("era5:2026-10-01", { cache_key: "era5:2026-10-01", model: "era5", period_date: "2026-10-01", payload_json: "{}", updated_at_utc: "x" });
  env.rows.set("era5:2026-11-19", { cache_key: "era5:2026-11-19", model: "era5", period_date: "2026-11-19", payload_json: "{}", updated_at_utc: "x" });
  await refreshClimateAll(env, NIGHT);
  assert.ok(!env.rows.has("era5:2026-10-01"));
  assert.ok(env.rows.has("era5:2026-11-19"));
}

console.log("Köy climate Cloudflare nightly tests passed");
