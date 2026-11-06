-- Archive calculated apparent temperature for every station.
ALTER TABLE station_history ADD COLUMN feels_like_c REAL;

CREATE INDEX IF NOT EXISTS idx_station_history_key_observed
  ON station_history(station_key, observed_at_utc);
