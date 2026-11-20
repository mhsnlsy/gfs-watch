// Nightly CERRA / ERA5 / ERA5-Land refresh that runs INSIDE Cloudflare.
//
//   * cron "30 1 * * *" (04:30 Europe/Istanbul) refreshes all three models.
//   * the existing "*/10 * * * *" cron calls climateTick(): from 04:50 on, if
//     any model still has no cache row for today's Istanbul date (a failed or
//     rate-limited night), it refreshes exactly one missing model per tick.
//
// Each model is written as soon as it is ready, so one failing model never
// discards the others. The previous day's row stays in D1 and keeps being
// served until the new one lands (/api/climate reads the newest period_date).
// The GitHub Actions workflow is only a fallback; both paths share
// shared/koy-climate-core.js.

import {
  MODELS,
  istanbulParts,
  dateKey,
  downloadHistoricalMonth,
  buildPayload,
} from "../../shared/koy-climate-core.js";

export const NIGHTLY_CRON = "30 1 * * *";
const TICK_NOT_BEFORE_MINUTES = 4 * 60 + 50; // Istanbul local time
const KEEP_DAYS = 14;

function istanbulMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = type => Number(parts.find(part => part.type === type)?.value || 0);
  return get("hour") * 60 + get("minute");
}

async function writePayload(env, payload) {
  await env.GFS_DB.prepare(
    "INSERT INTO climate_cache (cache_key, model, period_date, payload_json, updated_at_utc) " +
    "VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(cache_key) DO UPDATE SET model=excluded.model, period_date=excluded.period_date, " +
    "payload_json=excluded.payload_json, updated_at_utc=excluded.updated_at_utc"
  ).bind(
    payload.model + ":" + payload.period_date,
    payload.model,
    payload.period_date,
    JSON.stringify(payload),
    payload.updated_at_utc
  ).run();
}

async function pruneOld(env, now) {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  await env.GFS_DB.prepare("DELETE FROM climate_cache WHERE period_date < ?").bind(cutoff).run();
}

export async function refreshClimateModel(env, model, now = new Date()) {
  const parts = istanbulParts(now);
  const downloaded = await downloadHistoricalMonth(model, parts.month, parts.year);
  const payload = buildPayload(model, parts, downloaded, "cloudflare-worker");
  const bytes = JSON.stringify(payload).length;
  if (bytes > 90000) throw new Error(model + ": payload is " + bytes + " bytes (D1 limit ~100000)");
  await writePayload(env, payload);
  return {
    model,
    period_date: payload.period_date,
    history_years: [payload.historical_start_year, payload.historical_end_year],
    same_day_samples: payload.historical_day_sample_count,
    payload_bytes: bytes,
  };
}

export async function refreshClimateAll(env, now = new Date()) {
  const results = [];
  for (const model of Object.keys(MODELS)) {
    try {
      results.push({ ok: true, ...(await refreshClimateModel(env, model, now)) });
    } catch (error) {
      results.push({ ok: false, model, error: String(error?.message || error) });
    }
  }
  try { await pruneOld(env, now); } catch (_) { /* pruning is best-effort */ }
  return { ok: results.every(item => item.ok), results };
}

export async function climateTick(env, now = new Date()) {
  if (istanbulMinutes(now) < TICK_NOT_BEFORE_MINUTES) return { idle: true, reason: "before-nightly-window" };
  const today = dateKey(istanbulParts(now));
  const rows = await env.GFS_DB.prepare(
    "SELECT model FROM climate_cache WHERE period_date = ?"
  ).bind(today).all();
  const have = new Set((rows.results || []).map(row => row.model));
  const missing = Object.keys(MODELS).filter(model => !have.has(model));
  if (!missing.length) return { idle: true, reason: "cache-current" };
  const model = missing[0];
  try {
    return { ok: true, missing, ...(await refreshClimateModel(env, model, now)) };
  } catch (error) {
    return { ok: false, model, missing, error: String(error?.message || error) };
  }
}
