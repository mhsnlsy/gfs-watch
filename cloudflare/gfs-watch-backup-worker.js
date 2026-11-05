// Cloudflare Worker: independent GFS Watch backup trigger.
// Configure a Cron Trigger every 5 minutes and set GH_TOKEN as a Worker secret.
// GH_TOKEN needs repository Contents: write permission for mhsnlsy/gfs-watch.
const OWNER = "mhsnlsy";
const REPO = "gfs-watch";
const WORKFLOW_ID = 403757892;

function istanbulParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function latestSlotUtc(now) {
  const p = istanbulParts(now);
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  const slots = [0, 6, 12, 18];
  let slotHour = [...slots].reverse().find(h => h < hour || (h === hour && minute >= 30));
  let day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  if (slotHour === undefined) {
    day.setUTCDate(day.getUTCDate() - 1);
    slotHour = 18;
  }
  // Istanbul is UTC+3. Convert the local slot to UTC.
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), slotHour - 3, 30));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({
        worker: "gfs-watch-backup-worker",
        cron: "*/5 * * * *",
        github_dispatch_credential_configured: Boolean(env.GH_TOKEN)
      }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    if (!env.GH_TOKEN) throw new Error("Missing GH_TOKEN Worker secret");
    const now = new Date();
    const p = istanbulParts(now);
    const minute = Number(p.minute);
    const headers = {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };

    // The Cloudflare Cron is the reliable clock for the main station collector.
    // It only dispatches the existing workflow; ENKA, Eyüpsultan and Şişli
    // are still collected and published by main-station-refresh.yml.
    const stationTick = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/dispatches`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "station-refresh-clock",
        client_payload: {
          source: "cloudflare-cron",
          scheduled_at_utc: new Date(controller.scheduledTime).toISOString()
        }
      })
    });
    if (stationTick.status !== 204) {
      throw new Error(`Station refresh dispatch failed ${stationTick.status}: ${await stationTick.text()}`);
    }
    console.log(`Main station workflow tick dispatched for ${new Date(controller.scheduledTime).toISOString()}`);

    // Keep the existing GFS backup check unchanged; it only applies during
    // the Istanbul time-slot window below.
    if (minute < 40 || minute > 59) return;

    const slot = latestSlotUtc(now);
    const runsUrl = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?per_page=20`;
    const response = await fetch(runsUrl, { headers });
    if (!response.ok) throw new Error(`GitHub runs API ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const startedForSlot = (data.workflow_runs || []).some(run =>
      new Date(run.created_at).getTime() >= slot.getTime()
    );
    if (startedForSlot) return;

    const dispatch = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/dispatches`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "gfs-watch-backup",
        client_payload: { reason: "scheduled-run-missing", expected_slot_utc: slot.toISOString() }
      })
    });
    if (dispatch.status !== 204) {
      throw new Error(`GitHub dispatch API ${dispatch.status}: ${await dispatch.text()}`);
    }
    console.log(`Backup dispatch sent for missed slot ${slot.toISOString()}`);
  }
};
