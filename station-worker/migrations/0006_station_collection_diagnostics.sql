CREATE TABLE IF NOT EXISTS station_collection_diagnostics (
  station_key TEXT PRIMARY KEY,
  last_attempt_utc TEXT,
  last_success_utc TEXT,
  last_error TEXT,
  last_trigger_source TEXT,
  collection_duration_ms INTEGER
);

-- Seed diagnostics from the existing current-state table without changing
-- observation payloads or removing any archived station history.
INSERT OR IGNORE INTO station_collection_diagnostics (
  station_key,
  last_attempt_utc,
  last_success_utc,
  last_error,
  last_trigger_source,
  collection_duration_ms
)
SELECT
  station_key,
  last_attempt_utc,
  last_success_utc,
  last_error,
  'legacy',
  NULL
FROM station_current;
