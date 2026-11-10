ALTER TABLE radar_state ADD COLUMN last_telegram_status INTEGER NOT NULL DEFAULT 0;
ALTER TABLE radar_state ADD COLUMN last_telegram_error TEXT NOT NULL DEFAULT '';
