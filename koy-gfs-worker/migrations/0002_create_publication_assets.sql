CREATE TABLE IF NOT EXISTS gfs_publication_assets (
  asset_key TEXT PRIMARY KEY,
  run_id_utc TEXT,
  content_type TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_koy_gfs_publication_assets_run
  ON gfs_publication_assets(run_id_utc);
