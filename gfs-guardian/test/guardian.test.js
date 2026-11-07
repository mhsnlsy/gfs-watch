import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const originalLog = console.log;
const originalError = console.error;

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

function binding(health, calls) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({ url: url.pathname, method: request.method, authorization: request.headers.get("Authorization") });
      if (url.pathname === "/api/health") return Response.json(health);
      if (url.pathname === "/internal/reconcile") {
        return Response.json({ ok: true, result: { run_id_utc: "2026-11-08T00:00:00+00:00" } });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

test("does not trigger recovery while the Cloudflare primary Cron is healthy", async () => {
  const now = Date.now();
  const calls = [];
  const env = {
    ISTANBUL_GFS: binding({
      ok: true,
      service: "gfs-watch-istanbul-gfs",
      last_cron_started_at_utc: new Date(now - 2 * 60000).toISOString(),
      last_cron_success_at_utc: new Date(now - 1 * 60000).toISOString(),
    }, calls),
    GFS_DISPATCH_TOKEN: "worker-token",
  };
  let task;
  await worker.scheduled({ scheduledTime: now }, env, { waitUntil: promise => { task = promise; } });
  await task;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/health");
});

test("recovers a stale primary Cron through Cloudflare Service Binding", async () => {
  const now = Date.now();
  const calls = [];
  const env = {
    ISTANBUL_GFS: binding({
      ok: true,
      service: "gfs-watch-istanbul-gfs",
      last_cron_started_at_utc: new Date(now - 40 * 60000).toISOString(),
      last_cron_success_at_utc: new Date(now - 45 * 60000).toISOString(),
      last_cron_error: "temporary source timeout",
    }, calls),
    GFS_DISPATCH_TOKEN: "worker-token",
  };
  let task;
  await worker.scheduled({ scheduledTime: now }, env, { waitUntil: promise => { task = promise; } });
  await task;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "/internal/reconcile");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].authorization, "Bearer worker-token");
});

test("does not race a recently started primary collection", async () => {
  const now = Date.now();
  const calls = [];
  const env = {
    ISTANBUL_GFS: binding({
      ok: true,
      service: "gfs-watch-istanbul-gfs",
      last_cron_started_at_utc: new Date(now - 5 * 60000).toISOString(),
      last_cron_success_at_utc: new Date(now - 50 * 60000).toISOString(),
    }, calls),
    GFS_DISPATCH_TOKEN: "worker-token",
  };
  await worker.scheduled({ scheduledTime: now }, env, { waitUntil: promise => promise });
  assert.equal(calls.length, 1);
});

test("health endpoint exposes its Cloudflare-only recovery design without secrets", async () => {
  const response = await worker.fetch(new Request("https://guardian.example/health"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.cron, "5,15,25,35,45,55 * * * *");
  assert.equal(body.github_runtime_dependency, false);
  assert.equal("GFS_DISPATCH_TOKEN" in body, false);
});
