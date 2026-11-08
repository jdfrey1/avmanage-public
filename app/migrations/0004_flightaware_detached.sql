-- The logged flight a FlightAware flight was detached from by hand, so automatic matching
-- doesn't attach it to the same flight again.
ALTER TABLE public.flightaware_flights ADD COLUMN IF NOT EXISTS detached_flight_id UUID;
