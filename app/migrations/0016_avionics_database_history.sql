-- Photos of the Garmin Aux → Databases page, taken after each update (kept instead of a logbook
-- entry), and a history of which databases were updated to which cycle and when.
CREATE TABLE IF NOT EXISTS avionics_database_photos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partnership_id uuid NOT NULL REFERENCES partnerships(id) ON DELETE CASCADE,
  filename       text NOT NULL,
  file_key       text NOT NULL,
  mime_type      text NOT NULL,
  drive_file_id  text,
  taken_date     date NOT NULL DEFAULT CURRENT_DATE,
  uploaded_by    uuid REFERENCES users(id),
  uploaded_at    timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_avionics_db_photos_partnership ON avionics_database_photos(partnership_id, taken_date DESC);

-- database_name is copied so the history still reads correctly if a database is renamed or removed.
CREATE TABLE IF NOT EXISTS avionics_database_updates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partnership_id  uuid NOT NULL REFERENCES partnerships(id) ON DELETE CASCADE,
  database_id     uuid REFERENCES avionics_databases(id) ON DELETE SET NULL,
  database_name   text NOT NULL,
  previous_cycle  text,
  cycle           text,
  expires_date    date,
  updated_on      date NOT NULL DEFAULT CURRENT_DATE,
  photo_id        uuid REFERENCES avionics_database_photos(id) ON DELETE SET NULL,
  recorded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_avionics_db_updates_partnership ON avionics_database_updates(partnership_id, updated_on DESC);
