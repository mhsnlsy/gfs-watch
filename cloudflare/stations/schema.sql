CREATE TABLE IF NOT EXISTS observations (
  station_key TEXT PRIMARY KEY,
  station_id TEXT NOT NULL,
  observed_at_utc TEXT NOT NULL,
  fetched_at_utc TEXT NOT NULL,
  temperature_c REAL,
  pressure_hpa REAL,
  humidity_percent REAL,
  wind_speed_kmh REAL,
  wind_direction_degrees REAL,
  precipitation_1h_mm REAL,
  precipitation_daily_mm REAL,
  is_stale INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS station_history (
  station_key TEXT NOT NULL,
  observed_at_utc TEXT NOT NULL,
  fetched_at_utc TEXT NOT NULL,
  temperature_c REAL,
  pressure_hpa REAL,
  precipitation_1h_mm REAL,
  precipitation_daily_mm REAL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (station_key, observed_at_utc)
);
CREATE INDEX IF NOT EXISTS idx_station_history_time ON station_history(station_key, observed_at_utc);
