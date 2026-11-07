ALTER TABLE gfs_report_publications ADD COLUMN png_asset_key TEXT;
ALTER TABLE gfs_report_publications ADD COLUMN photo_message_id TEXT;

CREATE TABLE IF NOT EXISTS gfs_worker_heartbeat (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_started_at_utc TEXT,
  last_success_at_utc TEXT,
  last_error_at_utc TEXT,
  last_error TEXT,
  last_run_id_utc TEXT,
  last_trigger TEXT,
  updated_at_utc TEXT NOT NULL
);

INSERT OR IGNORE INTO gfs_worker_heartbeat (singleton, updated_at_utc)
VALUES (1, '1970-01-01T00:00:00.000Z');
