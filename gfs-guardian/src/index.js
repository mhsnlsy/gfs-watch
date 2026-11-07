const REPOSITORY = "mhsnlsy/gfs-watch";
const WORKFLOW_FILE = "istanbul-gfs-10min.yml";
const API_ROOT = "https://api.github.com";
const HEALTH_WINDOW_MS = 15 * 60 * 1000;
const DISPATCH_COOLDOWN_MS = 18 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function githubRequest(path, token, options = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "gfs-watch-cloudflare-guardian",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    // Keep response bodies and credentials out of Worker logs.
    throw new Error(`GitHub API request failed: HTTP ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function ageMs(timestamp, now) {
  const parsed = Date.parse(timestamp || "");
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : Number.POSITIVE_INFINITY;
}

function newest(items, timestampField) {
  return items
    .filter((item) => Number.isFinite(Date.parse(item[timestampField] || "")))
    .sort((a, b) => Date.parse(b[timestampField]) - Date.parse(a[timestampField]))[0] || null;
}

async function runGuardian(env, scheduledTime) {
  if (!env.GITHUB_DISPATCH_TOKEN) {
    throw new Error("GITHUB_DISPATCH_TOKEN secret is not configured");
  }

  const workflowPath = `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&per_page=20`;
  const payload = await githubRequest(workflowPath, env.GITHUB_DISPATCH_TOKEN);
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const now = Date.now();

  const active = runs
    .filter((run) => run.status === "queued" || run.status === "in_progress")
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0];

  if (active) {
    console.log(JSON.stringify({
      event: "guardian_skip",
      reason: "pipeline_active",
      run_id: active.id,
      run_status: active.status,
      scheduled_time: new Date(scheduledTime).toISOString(),
    }));
    return;
  }

  const latestDispatch = newest(
    runs.filter((run) => run.event === "workflow_dispatch"),
    "created_at",
  );

  if (latestDispatch && ageMs(latestDispatch.created_at, now) < DISPATCH_COOLDOWN_MS) {
    console.log(JSON.stringify({
      event: "guardian_skip",
      reason: "dispatch_cooldown",
      run_id: latestDispatch.id,
      created_at: latestDispatch.created_at,
      scheduled_time: new Date(scheduledTime).toISOString(),
    }));
    return;
  }

  const latestSuccess = newest(
    runs.filter((run) => run.status === "completed" && run.conclusion === "success"),
    "completed_at",
  );
  const successAge = latestSuccess
    ? ageMs(latestSuccess.completed_at, now)
    : Number.POSITIVE_INFINITY;

  if (successAge <= HEALTH_WINDOW_MS) {
    console.log(JSON.stringify({
      event: "guardian_healthy",
      latest_success_run_id: latestSuccess.id,
      completed_at: latestSuccess.completed_at,
      age_minutes: Math.round(successAge / 60_000 * 10) / 10,
      scheduled_time: new Date(scheduledTime).toISOString(),
    }));
    return;
  }

  await githubRequest(
    `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    env.GITHUB_DISPATCH_TOKEN,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    },
  );

  console.log(JSON.stringify({
    event: "guardian_dispatched",
    reason: latestSuccess ? "last_success_stale" : "no_successful_run_found",
    latest_success_run_id: latestSuccess?.id ?? null,
    latest_success_completed_at: latestSuccess?.completed_at ?? null,
    success_age_minutes: Number.isFinite(successAge)
      ? Math.round(successAge / 60_000 * 10) / 10
      : null,
    scheduled_time: new Date(scheduledTime).toISOString(),
  }));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        ok: true,
        service: "gfs-watch-gfs-guardian",
        repository: REPOSITORY,
        workflow: WORKFLOW_FILE,
        cron: "*/9 * * * *",
        stale_after_minutes: 15,
        dispatch_cooldown_minutes: 18,
        role: "watchdog-only; GitHub Actions remains the sole GFS poller and publisher",
      });
    }
    return json({ ok: false, error: "not_found" }, 404);
  },

  async scheduled(controller) {
    try {
      await runGuardian({}, controller.scheduledTime);
    } catch (error) {
      console.error(JSON.stringify({
        event: "guardian_error",
        message: error instanceof Error ? error.message : "Unknown Guardian error",
        scheduled_time: new Date(controller.scheduledTime).toISOString(),
      }));
    }
  },
};
