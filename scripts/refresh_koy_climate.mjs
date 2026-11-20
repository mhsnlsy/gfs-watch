import fs from "node:fs";
import path from "node:path";
import {
  MODELS,
  istanbulParts,
  dateKey,
  downloadHistoricalMonth,
  buildPayload,
} from "../shared/koy-climate-core.js";

// GitHub Actions fallback. The primary nightly refresh runs inside the
// Cloudflare Worker (koy-gfs-worker/src/climate-nightly.js); both use
// shared/koy-climate-core.js.

function sqlLiteral(value) {
  return "'" + String(value ?? "").replaceAll("'", "''") + "'";
}

async function main() {
  const parts = istanbulParts();
  const periodDate = dateKey(parts);
  console.log("Köy climate refresh: " + periodDate);

  const payloads = [];
  for (const model of Object.keys(MODELS)) {
    const downloaded = await downloadHistoricalMonth(model, parts.month, parts.year);
    const payload = buildPayload(model, parts, downloaded, "github-actions");
    payloads.push(payload);
    console.log(JSON.stringify({
      model,
      period_date: payload.period_date,
      history_years: [payload.historical_start_year, payload.historical_end_year],
      historical_year_count: payload.historical_year_count,
      historical_same_day_samples: payload.historical_day_sample_count,
      archive_rows_downloaded: payload.archive_row_count,
      same_day_history_rows: payload.same_day_history.length,
      precipitation_supported: payload.supported.precipitation,
      wind_supported: payload.supported.wind,
      precipitation_normal_to_date_mm: payload.precipitation_normal_to_date.normal_mm,
    }));
  }

  if (payloads.length !== 3 || new Set(payloads.map(item => item.model)).size !== 3) {
    throw new Error("Refusing to publish: all three independent model payloads are required");
  }

  // One multi-row INSERT is a single atomic D1 statement. D1 does not accept
  // manual BEGIN/COMMIT statements in an import file.
  const values = payloads.map(payload => "(" + [
    payload.model + ":" + periodDate,
    payload.model,
    periodDate,
    JSON.stringify(payload),
    payload.updated_at_utc,
  ].map(sqlLiteral).join(", ") + ")");

  const sql = [
    "INSERT INTO climate_cache (cache_key, model, period_date, payload_json, updated_at_utc)",
    "VALUES",
    values.join(",\n"),
    "ON CONFLICT(cache_key) DO UPDATE SET",
    "model=excluded.model,",
    "period_date=excluded.period_date,",
    "payload_json=excluded.payload_json,",
    "updated_at_utc=excluded.updated_at_utc;",
  ].join("\n");

  // D1 rejects statements above ~100 KB (SQLITE_TOOBIG). Fail here, with a
  // clear message, instead of in the middle of the Cloudflare upload.
  const statementBytes = Buffer.byteLength(sql, "utf8");
  console.log("D1 statement size: " + statementBytes + " bytes");
  if (statementBytes > 90000) {
    throw new Error("Refusing to publish: D1 statement is " + statementBytes + " bytes (limit ~100000)");
  }

  const output = path.join(process.cwd(), "koy-climate-refresh.sql");
  fs.writeFileSync(output, sql + "\n");
  console.log("Wrote one atomic D1 statement: " + output);
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
