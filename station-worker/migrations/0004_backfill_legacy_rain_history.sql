-- Preserve rainfall already archived by the previous D1 schema.
UPDATE station_history
SET rain_1h_mm = precipitation_1h_mm
WHERE rain_1h_mm IS NULL
  AND precipitation_1h_mm IS NOT NULL;

UPDATE station_history
SET rain_00_now_mm = precipitation_daily_mm
WHERE rain_00_now_mm IS NULL
  AND precipitation_daily_mm IS NOT NULL;
