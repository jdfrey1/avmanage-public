-- A logged flight can have several FlightAware tracks (one per leg).
DROP INDEX IF EXISTS public.idx_flightaware_flights_flight;
CREATE INDEX IF NOT EXISTS idx_flightaware_flights_flight ON public.flightaware_flights (flight_id) WHERE flight_id IS NOT NULL;
