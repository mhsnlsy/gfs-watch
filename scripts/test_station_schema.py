#!/usr/bin/env python3
"""Fail if station worker SQL references columns that do not exist in migrations."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "station-worker" / "src" / "index.js"
MIGRATIONS = ROOT / "station-worker" / "migrations"

CURRENT_COLUMNS = {
    "station_key", "station_id", "station_name", "observed_at_utc", "fetched_at_utc",
    "status", "payload_json", "last_error", "last_success_utc", "last_attempt_utc",
}
HISTORY_COLUMNS = {
    "id", "station_key", "station_id", "station_name", "observed_at_utc", "fetched_at_utc",
    "temperature_c", "humidity_percent", "pressure_hpa", "wind_speed_kmh", "wind_direction",
    "rain_1h_mm", "rain_10m_mm", "rain_6h_mm", "rain_12h_mm", "rain_24h_mm", "rain_00_now_mm",
    "feels_like_c", "payload_json", "precipitation_1h_mm", "precipitation_daily_mm",
}

def extract_insert_columns(sql: str, table: str) -> set[str]:
    pattern = re.compile(
        rf"INSERT\s+(?:OR\s+\w+\s+)?INTO\s+{table}\s*\(([^)]+)\)",
        re.IGNORECASE,
    )
    cols = set()
    for match in pattern.finditer(sql):
        raw = match.group(1)
        for part in raw.split(","):
            name = part.strip().strip('"').strip("`")
            if name:
                cols.add(name)
    return cols

def main() -> int:
    if not WORKER.exists():
        print("worker missing", WORKER)
        return 1
    sql = WORKER.read_text(encoding="utf-8")
    errors = []

    diagnostics_migration = MIGRATIONS / "0006_station_collection_diagnostics.sql"
    if not diagnostics_migration.exists():
        errors.append("missing station collection diagnostics migration 0006")
    else:
        migration_sql = diagnostics_migration.read_text(encoding="utf-8")
        if "station_collection_diagnostics" not in migration_sql:
            errors.append("migration 0006 does not create station_collection_diagnostics")
    if "Promise.all(" not in sql or "Object.keys(STATION_DEFS).map" not in sql:
        errors.append("station collection must fetch independent stations concurrently")
    if "recordCollectionFailure" not in sql or "collection_status" not in sql:
        errors.append("station collection failures must be persisted and exposed by /api/health")
    if not re.search(r"INSERT\\s+OR\\s+REPLACE\\s+INTO\\s+station_history", sql, re.IGNORECASE):
        errors.append("repeated source timestamps must update the existing history row instead of failing on the unique key")
    if 'collectAll(env, "cron")' not in sql or 'collectAll(env, "manual")' not in sql:
        errors.append("cron and bootstrap collection sources must be tracked separately")

    for table, allowed in (("station_current", CURRENT_COLUMNS), ("station_history", HISTORY_COLUMNS)):
        used = extract_insert_columns(sql, table)
        bad = used - allowed
        if bad:
            errors.append(f"{table}: worker inserts unknown columns {sorted(bad)}")

    # Health endpoint must exist so deploy verification can see collection status.
    if "/api/health" not in sql and 'path === "/health"' not in sql:
        errors.append("station worker missing /api/health endpoint")

    if errors:
        print("STATION SCHEMA CONTRACT FAILED")
        for err in errors:
            print(" -", err)
        return 1

    print("STATION SCHEMA CONTRACT PASSED")
    return 0

if __name__ == "__main__":
    sys.exit(main())
