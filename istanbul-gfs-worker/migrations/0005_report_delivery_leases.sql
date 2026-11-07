ALTER TABLE gfs_report_publications
  ADD COLUMN lease_until_utc TEXT;

CREATE INDEX IF NOT EXISTS idx_gfs_report_publications_lease
  ON gfs_report_publications(status, lease_until_utc);
