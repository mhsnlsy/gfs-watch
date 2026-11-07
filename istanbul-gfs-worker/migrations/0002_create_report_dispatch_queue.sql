CREATE TABLE IF NOT EXISTS gfs_report_dispatch_queue (
  run_id_utc TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at_utc TEXT NOT NULL,
  dispatched_at_utc TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_gfs_report_dispatch_pending
  ON gfs_report_dispatch_queue(status, created_at_utc);
