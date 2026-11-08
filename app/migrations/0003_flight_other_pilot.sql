-- A flight flown by someone who isn't a member. pilot_id stays the member whose hours the
-- flight is charged to; pilot_name (when set) is who actually flew it.
ALTER TABLE public.flights ADD COLUMN IF NOT EXISTS pilot_name TEXT;
