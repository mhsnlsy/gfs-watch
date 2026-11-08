CREATE TABLE IF NOT EXISTS radar_state (
  id INTEGER PRIMARY KEY,
  history_json TEXT NOT NULL DEFAULT '[]',
  last_frame_ts INTEGER NOT NULL DEFAULT 0,
  last_alert_ts INTEGER NOT NULL DEFAULT 0,
  last_intensity TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);