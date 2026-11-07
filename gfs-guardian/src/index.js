const STALE_AFTER_MS = 25 * 60 * 1000;
const RECENT_START_GRACE_MS = 18 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function timestampAgeMs(value, now) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : Number.POSITIVE_INFINITY;
}

async function getPrimaryHealth(env) {
  if (!env.ISTANBUL_GFS) throw new Error("Istanbul GFS Service Binding is not configured");
  const response = await env.ISTANBUL_GFS.fetch(
    new Request("https://istanbul-gfs.internal/api/health", { method: "GET" })
  );
  if (!response.ok) throw new Error("Istanbul GFS health request failed: HTTP " + response.status);
  const health = await response.json();
  if (health.ok !== true || health.service !== "gfs-watch-istanbul-gfs") {
    throw new Error("Istanbul GFS health response is invalid");
  }
  return health;
}

async function triggerPrimary(env) {
  if (!env.GFS_DISPATCH_TOKEN) throw new Error("Worker-to-Worker recovery token is not configured");
  const response = await env.ISTANBUL_GFS.fetch(
    new Request("https://istanbul-gfs.internal/internal/reconcile", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.GFS_DISPATCH_TOKEN },
    })
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    throw new Error("Istanbul GFS recovery request failed: HTTP " + response.status + " " +
      String(payload.error || "unknown error").slice(0, 250));
  }
  return payload.result || {};
}

async function runGuardian(env, scheduledTime) {
  const now = Number(scheduledTime);
  const health = await getPrimaryHealth(env);
  const successAge = timestampAgeMs(health.last_cron_success_at_utc, now);
  const startAge = timestampAgeMs(health.last_cron_started_at_utc, now);

  // Avoid racing a primary Cron that is still running. Recover when the last
  // successful collection is stale and no recent collection is in progress.
  if (successAge <= STALE_AFTER_MS || startAge <= RECENT_START_GRACE_MS) {
    console.log(JSON.stringify({
      event: "guardian_healthy",
      last_success_at_utc: health.last_cron_success_at_utc,
      success_age_minutes: Number.isFinite(successAge) ? Math.round(successAge / 60000 * 10) / 10 : null,
      collection_started_at_utc: health.last_cron_started_at_utc,
      scheduled_time: new Date(now).toISOString(),
    }));
    return { recovered: false, healthy: true };
  }

  const result = await triggerPrimary(env);
  console.log(JSON.stringify({
    event: "guardian_recovery_triggered",
    previous_success_at_utc: health.last_cron_success_at_utc,
    previous_error: health.last_cron_error || null,
    result_run_id_utc: result.run_id_utc || null,
    scheduled_time: new Date(now).toISOString(),
  }));
  return { recovered: true, result };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        ok: true,
        service: "gfs-watch-gfs-guardian",
        cron: "5,15,25,35,45,55 * * * *",
        stale_after_minutes: 25,
        recent_start_grace_minutes: 18,
        recovery: "Cloudflare Service Binding -> Istanbul GFS Worker /internal/reconcile",
        github_runtime_dependency: false,
      });
    }
    return json({ ok: false, error: "not_found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runGuardian(env, controller.scheduledTime).catch(error => {
        console.error(JSON.stringify({
          event: "guardian_error",
          message: error instanceof Error ? error.message : "Unknown Guardian error",
          scheduled_time: new Date(controller.scheduledTime).toISOString(),
        }));
      })
    );
  },
};
