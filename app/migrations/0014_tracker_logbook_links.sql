-- Links a tracked item (Maintenance → Tracking) to the logbook entry or entries that record when it
-- was last done. An item can need several (an annual has airframe, engine and prop entries; the
-- muffler replacement is logged per side), so this is a join table. Exactly one of
-- inspection_item_id / interval_id is set.
CREATE TABLE IF NOT EXISTS tracker_logbook_links (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_item_id uuid REFERENCES inspection_items(id) ON DELETE CASCADE,
  interval_id        uuid REFERENCES maintenance_intervals(id) ON DELETE CASCADE,
  entry_id           uuid NOT NULL REFERENCES logbook_entries(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT NOW(),
  CHECK ((inspection_item_id IS NULL) <> (interval_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_links_inspection ON tracker_logbook_links(inspection_item_id, entry_id) WHERE inspection_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_links_interval ON tracker_logbook_links(interval_id, entry_id) WHERE interval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracker_links_entry ON tracker_logbook_links(entry_id);
