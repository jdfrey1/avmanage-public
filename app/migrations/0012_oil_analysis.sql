-- Engine oil analysis (e.g. Blackstone Laboratories reports). Each uploaded PDF is a file; each
-- sample (one column of a lab report) is a row. A lab report lists the current sample plus several
-- earlier ones, so samples are keyed by sample date + engine hours and merged across reports: a
-- sample's own report (lab number, comments) wins over a history column on a later report.
CREATE TABLE IF NOT EXISTS oil_analysis_files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partnership_id uuid NOT NULL REFERENCES partnerships(id) ON DELETE CASCADE,
  filename       text NOT NULL,
  file_key       text NOT NULL,
  drive_file_id  text,
  page_count     integer,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'error')),
  error_message  text,
  uploaded_by    uuid REFERENCES users(id),
  uploaded_at    timestamptz NOT NULL DEFAULT NOW(),
  processed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_oil_files_partnership ON oil_analysis_files(partnership_id);

CREATE TABLE IF NOT EXISTS oil_analysis_samples (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partnership_id uuid NOT NULL REFERENCES partnerships(id) ON DELETE CASCADE,
  file_id        uuid REFERENCES oil_analysis_files(id) ON DELETE SET NULL,
  page_number    integer,
  source         text NOT NULL DEFAULT 'report' CHECK (source IN ('report', 'history')),
  lab            text,
  lab_number     text,
  report_date    date,
  sample_date    date NOT NULL,
  oil_hours      numeric(7,1),
  unit_hours     numeric(8,1),
  makeup_oil     text,
  oil_type       text,
  engine         text,
  submitted_by   text,
  elements       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- ppm by element name, e.g. {"iron": 33}
  properties     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- viscosity, flashpoint, fuel, water, insolubles
  flags          text[] NOT NULL DEFAULT '{}',         -- values the lab marked (bold), e.g. {silicon}
  comments       text,                                 -- the lab's comments on this sample
  notes          text,                                 -- our own notes (e.g. a date discrepancy)
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  search_vector  tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(comments, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(notes, '') || ' ' || COALESCE(lab_number, '') || ' ' || COALESCE(submitted_by, '')), 'B')
  ) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oil_samples_key ON oil_analysis_samples(partnership_id, sample_date, unit_hours);
CREATE INDEX IF NOT EXISTS idx_oil_samples_search ON oil_analysis_samples USING gin(search_vector);
