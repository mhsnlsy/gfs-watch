CREATE TABLE IF NOT EXISTS station_current (
  station_key TEXT PRIMARY KEY,
  station_id TEXT NOT NULL,
  station_name TEXT NOT NULL,
  observed_at_utc TEXT,
  fetched_at_utc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stale',
  payload_json TEXT NOT NULL,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS station_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_key TEXT NOT NULL,
  station_id TEXT NOT NULL,
  observed_at_utc TEXT,
  fetched_at_utc TEXT NOT NULL,
  temperature_c REAL,
  humidity_percent REAL,
  pressure_hpa REAL,
  wind_speed_kmh REAL,
  wind_direction REAL,
  rain_1h_mm REAL,
  rain_10m_mm REAL,
  rain_6h_mm REAL,
  rain_12h_mm REAL,
  rain_24h_mm REAL,
  rain_00_now_mm REAL
);

CREATE INDEX IF NOT EXISTS idx_station_history_key_fetched
  ON station_history(station_key, fetched_at_utc);

CREATE INDEX IF NOT EXISTS idx_station_history_fetched
  ON station_history(fetched_at_utc);
