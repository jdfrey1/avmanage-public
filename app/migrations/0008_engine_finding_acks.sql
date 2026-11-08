-- Engine findings marked as addressed (hidden from the Engine tab's findings list).
CREATE TABLE IF NOT EXISTS public.engine_finding_acks (
  partnership_id UUID NOT NULL REFERENCES public.partnerships(id) ON DELETE CASCADE,
  finding_key    TEXT NOT NULL,
  note           TEXT,
  acked_by       UUID REFERENCES public.users(id) ON DELETE SET NULL,
  acked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (partnership_id, finding_key)
);
