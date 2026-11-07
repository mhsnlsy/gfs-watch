import { DurableObject } from "cloudflare:workers";

const INACTIVITY_TIMEOUT_MS = 25 * 60 * 1000;

async function ensureContainerReady(ctx) {
  const container = ctx.container;
  if (!container) throw new Error("ECMWF container is not configured");

  if (!container.running) {
    container.start();
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  const port = container.getTcpPort(8080);
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await port.fetch("http://container/health", {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return port;
      lastError = new Error("health returned " + response.status);
    } catch (error) {
      lastError = error;
    }
    await scheduler.wait(500);
  }
  throw new Error("ECMWF container did not become ready", { cause: lastError });
}

export class ECMWFContainer extends DurableObject {
  async run() {
    const port = await ensureContainerReady(this.ctx);
    const response = await port.fetch("http://container/run", { method: "POST" });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || "ECMWF container run failed");
    }
    return { port, payload };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "gfs-watch-ecmwf-container" });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      const job = env.ECMWF_CONTAINER.getByName("production");
      const result = await job.run();
      return Response.json({
        ok: true,
        run_id_utc: result.payload.run_id_utc,
        forecast_horizon_hours: result.payload.forecast_horizon_hours,
        files: result.payload.files,
      });
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env) {
    const job = env.ECMWF_CONTAINER.getByName("production");
    const { port, payload } = await job.run();

    for (const key of payload.files) {
      const response = await port.fetch(
        "http://container/file/" + encodeURIComponent(key)
      );
      if (!response.ok) {
        throw new Error("Container asset fetch failed: " + key);
      }
      const contentType =
        response.headers.get("content-type") || "application/octet-stream";
      const body = await response.arrayBuffer();
      await env.LIVE_ARCHIVE.put("data/ecmwf/" + key, body, {
        httpMetadata: {
          contentType,
          cacheControl: key.endsWith(".json")
            ? "no-store, max-age=0"
            : "public, max-age=3600, s-maxage=86400",
        },
      });
    }

    console.log(JSON.stringify({
      event: "ecmwf_container_publish",
      scheduled_time: new Date(controller.scheduledTime).toISOString(),
      run_id_utc: payload.run_id_utc,
      files: payload.files.length,
    }));
  },
};
