-- The aircraft's AD (and SB) list, as of the latest AD compliance report: one row per AD/SB with
-- how it was complied with and, for recurring ones, when it is next due. Grouped the way the
-- report groups them (airframe, engine, propeller), plus service bulletins.
CREATE TABLE IF NOT EXISTS ad_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partnership_id       uuid NOT NULL REFERENCES partnerships(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('ad', 'sb')),
  applies_to           text NOT NULL CHECK (applies_to IN ('airframe', 'engine', 'propeller', 'service_bulletin')),
  number               text NOT NULL,
  effective_date       date,
  subject              text,
  status               text NOT NULL CHECK (status IN ('complied', 'not_applicable', 'superseded')),
  method_of_compliance text,
  recurring            boolean NOT NULL DEFAULT false,
  recurring_note       text,
  complied_date        date,
  complied_hours       numeric(8,1),
  next_due_hours       numeric(8,1),
  next_due_date        date,
  -- The line for this AD/SB on the compliance report (or SB compliance log) it was taken from.
  report_entry_id      uuid REFERENCES logbook_entries(id) ON DELETE SET NULL,
  sort_order           integer NOT NULL DEFAULT 0,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_items_partnership ON ad_items(partnership_id, applies_to, sort_order);

-- Logbook entries that record work for an AD/SB but don't quote its number the way the list does
-- (entries that do are found automatically).
CREATE TABLE IF NOT EXISTS ad_item_links (
  ad_item_id uuid NOT NULL REFERENCES ad_items(id) ON DELETE CASCADE,
  entry_id   uuid NOT NULL REFERENCES logbook_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (ad_item_id, entry_id)
);
