-- Avionics databases loaded in the aircraft (Garmin Aux → Databases, "Active" column): the cycle
-- installed and when it expires. Some (basemap, terrain) never expire, so expires_date is optional.
CREATE TABLE IF NOT EXISTS avionics_databases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partnership_id uuid NOT NULL REFERENCES partnerships(id) ON DELETE CASCADE,
  name           text NOT NULL,
  cycle          text,
  expires_date   date,
  warn_days      integer NOT NULL DEFAULT 7,
  notes          text,
  sort_order     integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT NOW(),
  created_at     timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_avionics_databases_partnership ON avionics_databases(partnership_id);
