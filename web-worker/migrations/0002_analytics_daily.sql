CREATE TABLE IF NOT EXISTS analytics_daily (
  day TEXT PRIMARY KEY,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  new_visitors INTEGER NOT NULL DEFAULT 0,
  returning_visitors INTEGER NOT NULL DEFAULT 0,
  devices_json TEXT NOT NULL DEFAULT '[]',
  os_json TEXT NOT NULL DEFAULT '[]',
  browsers_json TEXT NOT NULL DEFAULT '[]',
  cities_json TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '[]',
  pages_json TEXT NOT NULL DEFAULT '[]',
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_daily_day ON analytics_daily(day);
