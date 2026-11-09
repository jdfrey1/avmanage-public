-- Per-member email update settings: how often, when, and what to include.
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  frequency       text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly', 'changes')),
  send_time       text NOT NULL DEFAULT '06:00',          -- HH:MM, app time zone
  weekday         int  NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6), -- weekly: 0 = Sunday
  sections        text[] NOT NULL DEFAULT ARRAY['schedule', 'squawks', 'insights', 'maintenance', 'currency'],
  lookahead_days  int  NOT NULL DEFAULT 7 CHECK (lookahead_days BETWEEN 1 AND 60),
  my_schedule_only boolean NOT NULL DEFAULT false,
  skip_empty      boolean NOT NULL DEFAULT true,
  app_url         text,
  last_run_date   date,                                   -- local date of the last scheduled check
  last_sent_at    timestamptz,
  last_hash       text,                                   -- content fingerprint of the last email sent
  last_items      jsonb NOT NULL DEFAULT '{}',            -- item key -> label from the last email (to mark what's new or cleared)
  updated_at      timestamptz NOT NULL DEFAULT NOW()
);
