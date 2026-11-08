-- Garmin avionics data logs (one per engine run), attached to logged flights.
CREATE TABLE IF NOT EXISTS public.garmin_data_logs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partnership_id     UUID NOT NULL REFERENCES public.partnerships(id) ON DELETE CASCADE,
  flight_id          UUID REFERENCES public.flights(id) ON DELETE SET NULL,
  detached_flight_id UUID,
  filename           TEXT,
  file_key           TEXT NOT NULL,
  drive_file_id      TEXT,
  started_at         TIMESTAMPTZ NOT NULL,
  ended_at           TIMESTAMPTZ NOT NULL,
  engine_on_at       TIMESTAMPTZ,
  engine_off_at      TIMESTAMPTZ,
  takeoff_at         TIMESTAMPTZ,
  landing_at         TIMESTAMPTZ,
  engine_hrs         NUMERIC(6,2),
  air_hrs            NUMERIC(6,2),
  fuel_used_gal      NUMERIC(6,1),
  fuel_start_gal     NUMERIC(6,1),
  fuel_end_gal       NUMERIC(6,1),
  origin             TEXT,
  destination        TEXT,
  max_cht            NUMERIC(6,0),
  max_cht_cyl        INTEGER,
  stats              JSONB NOT NULL DEFAULT '{}'::jsonb,
  series             JSONB,
  meta               JSONB,
  uploaded_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (partnership_id, started_at)
);
CREATE INDEX IF NOT EXISTS idx_garmin_logs_flight ON public.garmin_data_logs (flight_id) WHERE flight_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_garmin_logs_started ON public.garmin_data_logs (partnership_id, started_at DESC);
