-- A logbook entry can be billed across more than one invoice (e.g. an annual whose squawk work was
-- invoiced separately), so entry ↔ invoice links move from logbook_entries.invoice_id to a join table.
CREATE TABLE IF NOT EXISTS logbook_entry_invoices (
  entry_id   uuid NOT NULL REFERENCES logbook_entries(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entry_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_logbook_entry_invoices_invoice ON logbook_entry_invoices(invoice_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'logbook_entries' AND column_name = 'invoice_id') THEN
    INSERT INTO logbook_entry_invoices (entry_id, invoice_id)
      SELECT id, invoice_id FROM logbook_entries WHERE invoice_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    ALTER TABLE logbook_entries DROP COLUMN invoice_id;
  END IF;
END $$;
