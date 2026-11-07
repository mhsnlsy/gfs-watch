CREATE TABLE IF NOT EXISTS gfs_report_publications (
  run_id_utc TEXT PRIMARY KEY,
  report_text TEXT NOT NULL,
  svg_asset_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  text_message_id TEXT,
  document_message_id TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  sent_at_utc TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_gfs_report_publications_pending
  ON gfs_report_publications(status, created_at_utc);
