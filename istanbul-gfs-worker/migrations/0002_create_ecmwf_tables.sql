CREATE TABLE IF NOT EXISTS ecmwf_runs (
  run_id_utc TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  published_at_utc TEXT NOT NULL,
  stored_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ecmwf_runs_published
  ON ecmwf_runs(published_at_utc);

CREATE TABLE IF NOT EXISTS ecmwf_current (
  key TEXT PRIMARY KEY,
  run_id_utc TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
