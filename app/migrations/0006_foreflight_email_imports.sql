-- ForeFlight logbook exports forwarded to the shared Gmail account, so each email is processed once.
CREATE TABLE IF NOT EXISTS public.foreflight_email_imports (
  msg_id      TEXT PRIMARY KEY,
  user_id     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  status      TEXT NOT NULL,           -- imported | skipped | error
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
