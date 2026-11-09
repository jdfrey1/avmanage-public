-- Currency expiration warnings: each member picks their own time (was one partnership-wide cron).
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency_alert_time text NOT NULL DEFAULT '08:00';
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency_alert_last_date date;
-- Today's partnership-wide check already ran; start the per-member checks tomorrow.
UPDATE users SET currency_alert_last_date = (NOW() AT TIME ZONE 'America/New_York')::date WHERE currency_alert_last_date IS NULL;
