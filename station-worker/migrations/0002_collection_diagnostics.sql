ALTER TABLE station_current ADD COLUMN last_success_utc TEXT;
ALTER TABLE station_current ADD COLUMN last_attempt_utc TEXT;

UPDATE station_current
SET last_success_utc = fetched_at_utc,
    last_attempt_utc = fetched_at_utc
WHERE last_success_utc IS NULL;
