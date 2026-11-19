CREATE TABLE IF NOT EXISTS climate_cache (
  cache_key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  period_date TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_climate_cache_model
  ON climate_cache(model, period_date);
