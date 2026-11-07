import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
});

function isoMinutesAgo(minutes, now = Date.now()) {
  return new Date(now - minutes * 60_000).toISOString();
}

function mockRuns(runs, calls) {
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/runs?")) {
      return Response.json({ workflow_runs: runs });
    }
    return new Response(null, { status: 204 });
  };
}

test("does not dispatch when the GFS pipeline has a recent successful heartbeat", async () => {
  const now = Date.now();
  const calls = [];
  mockRuns([{
    id: 101,
    event: "schedule",
    status: "completed",
    conclusion: "success",
    completed_at: isoMinutesAgo(4, now),
    created_at: isoMinutesAgo(5, now),
  }], calls);

  await worker.scheduled({ scheduledTime: now }, { GITHUB_DISPATCH_TOKEN: "test-token" });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /actions\/workflows\/istanbul-gfs-10min\.yml\/runs/);
});

test("dispatches the existing workflow when the last success is stale", async () => {
  const now = Date.now();
  const calls = [];
  mockRuns([{
    id: 102,
    event: "schedule",
    status: "completed",
    conclusion: "success",
    completed_at: isoMinutesAgo(22, now),
    created_at: isoMinutesAgo(23, now),
  }], calls);

  await worker.scheduled({ scheduledTime: now }, { GITHUB_DISPATCH_TOKEN: "test-token" });

  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /actions\/workflows\/istanbul-gfs-10min\.yml\/dispatches$/);
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body), { ref: "main" });
});

test("does not dispatch while a GFS workflow run is active", async () => {
  const now = Date.now();
  const calls = [];
  mockRuns([{
    id: 103,
    event: "schedule",
    status: "in_progress",
    conclusion: null,
    created_at: isoMinutesAgo(2, now),
  }], calls);

  await worker.scheduled({ scheduledTime: now }, { GITHUB_DISPATCH_TOKEN: "test-token" });

  assert.equal(calls.length, 1);
});

test("applies the cooldown after a previous fallback dispatch", async () => {
  const now = Date.now();
  const calls = [];
  mockRuns([
    {
      id: 104,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
      created_at: isoMinutesAgo(6, now),
      completed_at: isoMinutesAgo(5, now),
    },
    {
      id: 105,
      event: "schedule",
      status: "completed",
      conclusion: "success",
      created_at: isoMinutesAgo(60, now),
      completed_at: isoMinutesAgo(59, now),
    },
  ], calls);

  await worker.scheduled({ scheduledTime: now }, { GITHUB_DISPATCH_TOKEN: "test-token" });

  assert.equal(calls.length, 1);
});

test("exposes a minimal health response without exposing secrets", async () => {
  const response = await worker.fetch(new Request("https://guardian.example/health"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.cron, "*/9 * * * *");
  assert.equal("GITHUB_DISPATCH_TOKEN" in body, false);
});
