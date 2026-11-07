CREATE TABLE IF NOT EXISTS gfs_current (
  key TEXT PRIMARY KEY,
  run_id_utc TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gfs_runs (
  run_id_utc TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  published_at_utc TEXT NOT NULL,
  stored_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gfs_runs_published_at
  ON gfs_runs(published_at_utc DESC);
