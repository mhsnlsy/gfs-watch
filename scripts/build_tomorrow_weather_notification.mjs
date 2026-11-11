import { mkdir, writeFile } from "node:fs/promises";
import { tomorrowLocalWind } from "../shared/tomorrow-local-wind.js";
const API_URL = "https://api.meteopt.com/gfs/json?lat=41.014&lon=28.95&run=12&lang=en";
const OUTPUT = process.env.TOMORROW_NOTIFICATION_FEED || "tmp/tomorrow-weather-notification.json";
const TZ = "Europe/Istanbul";
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function dateKey(date) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
function hour(date) { return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(date)); }
function cloudLabel(value) { const n = finite(value); if (n === null || n < 0 || n > 100) throw new Error("Invalid Clouds value: " + value); if (n < 40) return "güneşli"; if (n < 70) return "parçalı bulutlu"; return "bulutlu"; }
function fmt(value) { return String(Math.round(Math.abs(value) * 10) / 10).replace(".", ","); }
const response = await fetch(API_URL, { headers: { "User-Agent": "IstanbulunHavasi-TomorrowPush/1.0", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(45000) });
if (!response.ok) throw new Error("MeteoPT HTTP " + response.status);
const doc = await response.json();
if (!doc || typeof doc !== "object" || !doc.run || !doc.steps || !doc.steps.values || !doc.data) throw new Error("MeteoPT 12Z response is invalid.");
const runDigits = String(doc.run).replace(/\D/g, "").slice(0, 10);
if (runDigits.length !== 10 || Number(runDigits.slice(8, 10)) !== 12) throw new Error("Expected MeteoPT 12Z run, received: " + doc.run);
const cycle = new Date(Date.UTC(Number(runDigits.slice(0, 4)), Number(runDigits.slice(4, 6)) - 1, Number(runDigits.slice(6, 8)), 12));
const steps = doc.steps.values.map(finite);
const series = { tmp2m: (doc.data.tmp2m && doc.data.tmp2m.values) || [], apcp: (doc.data.apcp && doc.data.apcp.values) || [], clouds: (doc.data.clouds && doc.data.clouds.values) || [], wind10m: (doc.data.wind10m && doc.data.wind10m.values) || [], wind10mdir: (doc.data.wind10mdir && doc.data.wind10mdir.values) || (doc.data.winddir10m && doc.data.winddir10m.values) || [] };
const points = [];
for (let i = 0; i < steps.length; i += 1) { const lead = steps[i]; if (lead === null || lead <= 0) continue; const valid = new Date(cycle.getTime() + lead * 3600000); points.push({ lead, valid, date: dateKey(valid), hour: hour(valid), temp: finite(series.tmp2m[i]), precip: finite(series.apcp[i]), clouds: finite(series.clouds[i]), wind: finite(series.wind10m[i]), windDir: finite(series.wind10mdir[i]) }); }
if (!points.length) throw new Error("MeteoPT 12Z output has no forecast points.");
const today = dateKey(new Date());
const tomorrow = dateKey(new Date(Date.now() + 24 * 3600000));
const todayPoints = points.filter(p => p.date === today && p.temp !== null);
const tomorrowPoints = points.filter(p => p.date === tomorrow && p.temp !== null);
if (!todayPoints.length || !tomorrowPoints.length) throw new Error("12Z GFS does not contain both today and tomorrow temperature points.");
const todayMax = Math.max(...todayPoints.map(p => p.temp));
const tomorrowMax = Math.max(...tomorrowPoints.map(p => p.temp));
const cloudPoint = tomorrowPoints.filter(p => p.clouds !== null).sort((a, b) => Math.abs(a.hour - 15) - Math.abs(b.hour - 15))[0];
const rainTomorrow = tomorrowPoints.some(p => p.precip !== null && p.precip > 0);
const weatherLabel = rainTomorrow
  ? "yağmurlu"
  : cloudPoint && cloudPoint.clouds !== null
    ? cloudLabel(cloudPoint.clouds)
    : "bulutlu";
const delta = tomorrowMax - todayMax;
const tempSentence = Math.abs(delta) < 0.05 ? "bugünle aynı sıcaklıkta" : "bugünden " + fmt(delta) + "°C daha " + (delta > 0 ? "sıcak" : "soğuk");
const localWind = tomorrowLocalWind(points.filter(p => p.date === tomorrow).map(p => ({ speed: p.wind, direction: p.windDir })));
const body = "Yarın hava " + fmt(tomorrowMax) + "°C, " + tempSentence + ", " + weatherLabel + (localWind ? ", " + localWind.phrase : "") + ".";
const notificationId = "tomorrow-weather-" + runDigits + "Z-" + tomorrow;
const feed = { schema: "gfs-watch.notifications.v1", items: [{ id: notificationId, title: "İstanbul · Yarın hava nasıl?", summary: body }], metadata: { run_id_utc: cycle.toISOString(), forecast_date_istanbul: tomorrow, source: "MeteoPT GFS 12Z", tomorrow_max_c: tomorrowMax, today_max_c: todayMax, delta_c: Math.round(delta * 10) / 10, clouds_percent: cloudPoint ? cloudPoint.clouds : null, clouds_valid_time_istanbul: cloudPoint ? cloudPoint.valid.toISOString() : null, precipitation_expected: rainTomorrow, local_wind: localWind ? localWind.phrase : null, local_wind_max_kmh: localWind ? localWind.max_speed_kmh : null, local_wind_direction_deg: localWind ? localWind.direction_deg : null } };
await mkdir(OUTPUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
await writeFile(OUTPUT, JSON.stringify(feed, null, 2), "utf8");
console.log(JSON.stringify(feed.metadata, null, 2));
console.log("WEB PUSH BODY: " + body);