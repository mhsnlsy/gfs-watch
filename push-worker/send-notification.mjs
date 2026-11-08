import { readFile } from "node:fs/promises";
import webPush from "web-push";

const apiBase = String(process.env.PUSH_API_URL || "").replace(/\/+$/, "");
const adminToken = process.env.PUSH_ADMIN_TOKEN || "";
const publicKey = process.env.VAPID_PUBLIC_KEY || "";
const privateKey = process.env.VAPID_PRIVATE_KEY || "";
const subject = process.env.VAPID_SUBJECT || "https://gfs-watch-web.muhsin-ulusoy.workers.dev/";
const testMode = String(process.env.PUSH_TEST_MODE || "").toLowerCase() === "true";

if (!apiBase || !adminToken || !publicKey || !privateKey) {
  throw new Error("Missing PUSH_API_URL, PUSH_ADMIN_TOKEN, VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY.");
}

const headers = {
  "Authorization": `Bearer ${adminToken}`,
  "Content-Type": "application/json"
};

async function api(path, options = {}) {
  const response = await fetch(apiBase + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}
  if (!response.ok) throw new Error(`Push API ${response.status}: ${data.error || text || response.statusText}`);
  return data;
}

let item;
if (testMode) {
  item = {
    id: `manual-test-${Date.now()}`,
    title: "GFS Watch · Test bildirimi",
    summary: "Harika! Web Push bağlantısı çalışıyor. Bu, uygulama kapalıyken teslimatı sınamak için gönderilen test mesajıdır."
  };
  console.log("[WEB PUSH] Test mode enabled; GFS duplicate protection will not be touched.");
} else {
  const feedPath = process.env.NOTIFICATION_FEED_PATH || "public/notifications/latest.json";
  const feed = JSON.parse(await readFile(feedPath, "utf8"));
  if (feed.schema !== "gfs-watch.notifications.v1" || !Array.isArray(feed.items)) {
    throw new Error("Notification feed is invalid.");
  }

  const requestedId = process.env.NOTIFICATION_ID || "";
  item = requestedId
    ? feed.items.find(entry => entry.id === requestedId)
    : feed.items[0];

  if (!item) throw new Error(requestedId ? `Notification not found in feed: ${requestedId}` : "No notification in feed.");

  const alreadySent = await api("/admin/notification-sent?id=" + encodeURIComponent(item.id));
  if (alreadySent.sent) {
    console.log(`[WEB PUSH] ${item.id} was already sent; skipping duplicate.`);
    process.exit(0);
  }
}

const { subscriptions = [] } = await api("/admin/subscriptions");
console.log(`[WEB PUSH] Registered device subscriptions: ${subscriptions.length}`);
if (!subscriptions.length) {
  console.log("[WEB PUSH] No subscribed devices yet. Nothing sent; this notification can be retried after subscribing.");
  process.exit(0);
}

webPush.setVapidDetails(subject, publicKey, privateKey);

const payload = JSON.stringify({
  title: item.title || "İstanbul Havası",
  body: String(item.summary || "Yeni İstanbul GFS hava raporu yayımlandı.").slice(0, 180),
  tag: testMode ? item.id : "gfs-" + item.id,
  url: "https://gfs-watch-web.muhsin-ulusoy.workers.dev/#bildirimler"
});

let delivered = 0;
let failed = 0;

for (const subscription of subscriptions) {
  try {
    await webPush.sendNotification(subscription, payload, { TTL: 86400, urgency: "normal" });
    delivered += 1;
  } catch (error) {
    failed += 1;
    const statusCode = Number(error.statusCode || 0);
    console.error("[WEB PUSH] Delivery failed:", statusCode || error.message);
    if (statusCode === 404 || statusCode === 410) {
      try {
        await api("/admin/subscriptions/delete", {
          method: "POST",
          body: JSON.stringify({ endpoint: subscription.endpoint })
        });
        console.log("[WEB PUSH] Expired subscription removed.");
      } catch (cleanupError) {
        console.error("[WEB PUSH] Could not remove expired subscription:", cleanupError.message);
      }
    }
  }
}

if (delivered > 0) {
  if (!testMode) {
    await api("/admin/notification-sent", {
      method: "POST",
      body: JSON.stringify({ id: item.id, recipient_count: delivered })
    });
  }
  console.log(`[WEB PUSH] ${testMode ? "Test notification" : "Sent " + item.id} accepted for ${delivered} device(s). Failed: ${failed}.`);
} else if (failed > 0) {
  throw new Error(`Could not deliver ${testMode ? "test notification" : item.id} to any device.`);
} else {
  console.log("[WEB PUSH] No deliveries were attempted.");
}
