-- Expand the pre-existing station_history table in place.
-- The live database predates this Worker and has a compact schema.
ALTER TABLE station_history ADD COLUMN humidity_percent REAL;
ALTER TABLE station_history ADD COLUMN wind_speed_kmh REAL;
ALTER TABLE station_history ADD COLUMN wind_direction REAL;
ALTER TABLE station_history ADD COLUMN rain_1h_mm REAL;
ALTER TABLE station_history ADD COLUMN rain_10m_mm REAL;
ALTER TABLE station_history ADD COLUMN rain_6h_mm REAL;
ALTER TABLE station_history ADD COLUMN rain_12h_mm REAL;
ALTER TABLE station_history ADD COLUMN rain_24h_mm REAL;
ALTER TABLE station_history ADD COLUMN rain_00_now_mm REAL;

CREATE INDEX IF NOT EXISTS idx_station_history_key_fetched
  ON station_history(station_key, fetched_at_utc);
