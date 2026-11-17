CREATE TABLE IF NOT EXISTS analytics_sessions (
  session_id TEXT PRIMARY KEY,
  first_seen_utc TEXT NOT NULL,
  last_seen_utc TEXT NOT NULL,
  last_path TEXT NOT NULL DEFAULT '/',
  city TEXT,
  country TEXT,
  device TEXT,
  os TEXT,
  browser TEXT,
  referrer TEXT
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts_utc TEXT NOT NULL,
  event_type TEXT NOT NULL,
  path TEXT NOT NULL,
  city TEXT,
  country TEXT,
  device TEXT,
  os TEXT,
  browser TEXT,
  referrer TEXT
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_ts ON analytics_events(ts_utc);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_last_seen ON analytics_sessions(last_seen_utc);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_first_seen ON analytics_sessions(first_seen_utc);
