const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const googleAuth = require('../services/googleAuth');
const googleDrive = require('../services/googleDrive');
const { extractPdfText, parseWorkOrder, buildSearchText } = require('../services/invoiceParser');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = express.Router();
router.use(requireAuth);

async function getPartnershipId(userId) {
  const { rows } = await pool.query('SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1', [userId]);
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return rows[0].partnership_id;
}

const INVOICE_COLS = `
  i.id, i.document_id, i.vendor, i.invoice_number, TO_CHAR(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
  i.customer, i.summary, i.responsible, i.labor::float, i.parts::float, i.shipping::float, i.tax::float,
  i.total::float, i.total_time::float, i.hobbs::float, i.flight_timer::float, i.notes`;

function handle(label, fn) {
  return async (req, res) => {
    try { await fn(req, res); } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error(`${label} error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// GET /api/invoices?q= — list; with q, only invoices with a line item matching the search,
// plus the matching items.
router.get('/', handle('GET /invoices', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  const q = (req.query.q || '').trim();
  const { rows: invoices } = await pool.query(`
    SELECT ${INVOICE_COLS},
      (SELECT COUNT(*)::int FROM ledger_invoices li WHERE li.invoice_id = i.id) AS ledger_count,
      (SELECT COUNT(*)::int FROM logbook_entries e WHERE e.invoice_id = i.id) AS logbook_count
    FROM invoices i
    WHERE i.partnership_id = $1
    ORDER BY i.invoice_date DESC NULLS LAST, i.invoice_number DESC`, [partnershipId]);
  if (!q) return res.json(invoices.map(i => ({ ...i, matches: [] })));

  const { rows: hits } = await pool.query(`
    SELECT it.invoice_id, it.item_no, it.status, it.description, it.work_performed,
           it.total_amount::float AS total_amount,
           ts_headline('english', it.description || ' — ' || coalesce(it.work_performed, ''), websearch_to_tsquery('english', $2),
                       'MaxWords=30, MinWords=10') AS snippet
    FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
    WHERE i.partnership_id = $1 AND it.search_vector @@ websearch_to_tsquery('english', $2)
    ORDER BY ts_rank(it.search_vector, websearch_to_tsquery('english', $2)) DESC
    LIMIT 100`, [partnershipId, q]);
  // Invoices without parsed line items (e.g. other vendors) are searched by their full text.
  const { rows: textHits } = await pool.query(`
    SELECT i.id AS invoice_id, 0 AS item_no, 'text' AS status, i.total::float AS total_amount,
           ts_headline('english', d.extracted_text, websearch_to_tsquery('english', $2), 'MaxWords=30, MinWords=10') AS snippet
    FROM invoices i JOIN documents d ON d.id = i.document_id
    WHERE i.partnership_id = $1 AND d.extracted_text IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM invoice_items it WHERE it.invoice_id = i.id)
      AND to_tsvector('english', d.extracted_text) @@ websearch_to_tsquery('english', $2)`, [partnershipId, q]);
  const byInvoice = {};
  for (const h of [...hits, ...textHits]) (byInvoice[h.invoice_id] ||= []).push(h);
  res.json(invoices.filter(i => byInvoice[i.id]).map(i => ({ ...i, matches: byInvoice[i.id] })));
}));

// GET /api/invoices/:id — invoice, items, linked ledger entries and logbook entries
router.get('/:id', handle('GET /invoices/:id', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  const { rows: [invoice] } = await pool.query(
    `SELECT ${INVOICE_COLS} FROM invoices i WHERE i.id = $1 AND i.partnership_id = $2`, [req.params.id, partnershipId]);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const [{ rows: items }, { rows: ledger }, { rows: logbook }] = await Promise.all([
    pool.query(`SELECT id, item_no, status, TO_CHAR(item_date, 'YYYY-MM-DD') AS item_date, description, work_performed,
                       labor_hours::float, labor_rate::float, labor_amount::float, parts, parts_amount::float, total_amount::float
                FROM invoice_items WHERE invoice_id = $1 ORDER BY item_no`, [invoice.id]),
    pool.query(`SELECT l.id, l.lessee_id, u.name AS lessee_name, l.entry_type, l.direction, l.amount::float,
                       TO_CHAR(l.effective_date, 'YYYY-MM-DD') AS effective_date, l.description
                FROM ledger_invoices li JOIN financial_ledger l ON l.id = li.ledger_id LEFT JOIN users u ON u.id = l.lessee_id
                WHERE li.invoice_id = $1 ORDER BY l.effective_date`, [invoice.id]),
    pool.query(`SELECT id, TO_CHAR(entry_date, 'YYYY-MM-DD') AS entry_date, category, summary
                FROM logbook_entries WHERE invoice_id = $1 ORDER BY entry_date`, [invoice.id]),
  ]);
  res.json({ ...invoice, items, ledger_entries: ledger, logbook_entries: logbook });
}));

// GET /api/invoices/:id/file — the invoice PDF
router.get('/:id/file', handle('GET /invoices/:id/file', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  const { rows: [doc] } = await pool.query(
    `SELECT d.file_key FROM invoices i JOIN documents d ON d.id = i.document_id WHERE i.id = $1 AND i.partnership_id = $2`,
    [req.params.id, partnershipId]);
  if (!doc) return res.status(404).json({ error: 'Invoice not found' });
  const filepath = path.join(UPLOADS_DIR, doc.file_key);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File missing' });
  res.sendFile(filepath);
}));

// PATCH /api/invoices/:id — header details and notes (line items are never edited here)
router.patch('/:id', handle('PATCH /invoices/:id', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  const b = req.body;
  const sets = [], params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if ('notes' in b) add('notes', b.notes || null);
  if ('vendor' in b) { if (!String(b.vendor).trim()) return res.status(400).json({ error: 'vendor is required' }); add('vendor', String(b.vendor).trim()); }
  if ('invoice_number' in b) { if (!String(b.invoice_number).trim()) return res.status(400).json({ error: 'invoice number is required' }); add('invoice_number', String(b.invoice_number).trim()); }
  if ('invoice_date' in b) {
    if (b.invoice_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.invoice_date)) return res.status(400).json({ error: 'invoice_date must be YYYY-MM-DD' });
    add('invoice_date', b.invoice_date || null);
  }
  if ('summary' in b) add('summary', b.summary || null);
  if ('customer' in b) add('customer', b.customer || null);
  if ('total' in b) {
    const t = Number(b.total);
    if (!isFinite(t) || t < 0) return res.status(400).json({ error: 'total must be a number' });
    add('total', t);
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id, partnershipId);
  try {
    const { rows: [r] } = await pool.query(
      `UPDATE invoices SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND partnership_id = $${params.length} RETURNING id, document_id`, params);
    if (!r) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An invoice with that vendor and number already exists' });
    throw err;
  }
}));

// POST /api/invoices/upload — attach an invoice file (PDF or photo), typically from a ledger entry.
// multipart: file, optional ledger_ids (comma-separated entries to link), vendor, invoice_number,
// invoice_date, total, summary. A PDF's text layer is read for searching; work orders from shops with a
// parser (see services/invoiceParsers) are parsed into line items. No AI is used.
router.post('/upload', upload.single('file'), handle('POST /invoices/upload', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  const mime = req.file.mimetype;
  const isPdf = mime === 'application/pdf';
  if (!isPdf && !mime.startsWith('image/')) return res.status(400).json({ error: 'File must be a PDF or an image' });

  const ledgerIds = (req.body.ledger_ids || '').split(',').map(x => x.trim()).filter(Boolean);
  let ledgerTotal = 0;
  if (ledgerIds.length) {
    const { rows } = await pool.query(
      'SELECT id, amount::float FROM financial_ledger WHERE id = ANY($1::uuid[]) AND partnership_id = $2', [ledgerIds, partnershipId]);
    if (rows.length !== ledgerIds.length) return res.status(404).json({ error: 'Ledger entry not found' });
    ledgerTotal = rows.reduce((s, r) => s + r.amount, 0);
  }

  const text = isPdf ? await extractPdfText(req.file.buffer) : '';
  const parsed = text ? parseWorkOrder(text) : null;
  const h = parsed?.header;
  const f = req.body;
  const vendor = (f.vendor || h?.vendor || 'Unknown vendor').trim();
  const invoiceNumber = (f.invoice_number || h?.invoice_number || `UPLOAD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`).trim();
  const invoiceDate = f.invoice_date || h?.invoice_date || null;
  const total = f.total !== undefined && f.total !== '' ? Number(f.total) : (h?.total ?? ledgerTotal);
  if (!isFinite(total)) return res.status(400).json({ error: 'total must be a number' });

  const { rows: [dupe] } = await pool.query(
    'SELECT id FROM invoices WHERE partnership_id = $1 AND vendor = $2 AND invoice_number = $3', [partnershipId, vendor, invoiceNumber]);
  if (dupe) return res.status(409).json({ error: `Invoice ${invoiceNumber} from ${vendor} is already in the system`, invoice_id: dupe.id });

  const ext = isPdf ? 'pdf' : (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const fileKey = path.join('documents', `${crypto.randomUUID()}.${ext}`);
  fs.mkdirSync(path.join(UPLOADS_DIR, 'documents'), { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, fileKey), req.file.buffer);

  const title = `${vendor.replace(/, LLC$/, '')} Invoice ${invoiceNumber}${invoiceDate ? ` (${invoiceDate})` : ''}`;
  const searchText = parsed?.itemsOk ? buildSearchText(h, parsed.items) : text;
  const client = await pool.connect();
  let invoice;
  try {
    await client.query('BEGIN');
    const { rows: [doc] } = await client.query(
      `INSERT INTO documents (partnership_id, uploaded_by, doc_type, title, file_key, extracted_text, text_status)
       VALUES ($1,$2,'invoice',$3,$4,$5,$6) RETURNING id`,
      [partnershipId, req.session.userId, title, fileKey, searchText || null, searchText ? 'ready' : 'skipped']);
    const { rows: [inv] } = await client.query(
      `INSERT INTO invoices (partnership_id, document_id, vendor, invoice_number, invoice_date, customer, summary,
         labor, parts, shipping, tax, total, total_time, hobbs, flight_timer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, document_id`,
      [partnershipId, doc.id, vendor, invoiceNumber, invoiceDate, h?.customer || null, f.summary || h?.summary || null,
       h?.labor ?? null, h?.parts ?? null, h?.shipping ?? null, h?.tax ?? null, total, h?.total_time ?? null, h?.hobbs ?? null, h?.flight_timer ?? null]);
    invoice = inv;
    if (parsed?.itemsOk) {
      for (const i of parsed.items) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, item_no, status, item_date, description, work_performed, labor_hours, labor_rate,
             labor_amount, parts, parts_amount, total_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [inv.id, i.n, i.status, i.date, i.description, i.work || null, i.hours, i.rate, i.labor, JSON.stringify(i.parts),
           Math.round(i.parts.reduce((a, x) => a + x.ext, 0) * 100) / 100, i.total]);
      }
    }
    if (ledgerIds.length) {
      await client.query('INSERT INTO ledger_invoices (ledger_id, invoice_id) SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING',
        [ledgerIds, inv.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    fs.rmSync(path.join(UPLOADS_DIR, fileKey), { force: true });
    throw err;
  } finally {
    client.release();
  }

  // Archive to the Drive "Invoices" folder (best-effort; never blocks the upload).
  try {
    if (await googleAuth.isConnected()) {
      const driveFileId = await googleDrive.uploadFile('invoices', { name: `${title}.${ext}`, mimeType: mime, buffer: req.file.buffer });
      await pool.query('UPDATE documents SET drive_file_id = $1 WHERE id = $2', [driveFileId, invoice.document_id]);
    }
  } catch (err) {
    console.error(`Drive sync failed for invoice ${invoiceNumber}:`, err.message);
  }

  res.status(201).json({ id: invoice.id, document_id: invoice.document_id, invoice_number: invoiceNumber, items: parsed?.itemsOk ? parsed.items.length : 0, parsed: !!parsed?.itemsOk });
}));

// POST /api/invoices/:id/ledger { ledger_id } — link an existing ledger entry to this invoice
router.post('/:id/ledger', handle('POST /invoices/:id/ledger', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  const { rowCount } = await pool.query(
    `INSERT INTO ledger_invoices (ledger_id, invoice_id)
     SELECT l.id, i.id FROM financial_ledger l, invoices i
     WHERE l.id = $1 AND l.partnership_id = $3 AND i.id = $2 AND i.partnership_id = $3
     ON CONFLICT DO NOTHING`, [req.body.ledger_id, req.params.id, partnershipId]);
  if (!rowCount) {
    const { rows: [ok] } = await pool.query(
      `SELECT 1 FROM ledger_invoices li JOIN invoices i ON i.id = li.invoice_id
       WHERE li.ledger_id = $1 AND li.invoice_id = $2 AND i.partnership_id = $3`, [req.body.ledger_id, req.params.id, partnershipId]);
    if (!ok) return res.status(404).json({ error: 'Invoice or ledger entry not found' });
  }
  res.json({ ok: true });
}));

// DELETE /api/invoices/:id/ledger/:ledgerId — unlink
router.delete('/:id/ledger/:ledgerId', handle('DELETE /invoices/:id/ledger', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  await pool.query(
    `DELETE FROM ledger_invoices li USING invoices i
     WHERE li.ledger_id = $1 AND li.invoice_id = $2 AND i.id = li.invoice_id AND i.partnership_id = $3`,
    [req.params.ledgerId, req.params.id, partnershipId]);
  res.sendStatus(204);
}));

// POST /api/invoices/:id/logbook { entry_id } — link a logbook entry to this invoice
router.post('/:id/logbook', handle('POST /invoices/:id/logbook', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  const { rows: [inv] } = await pool.query('SELECT id FROM invoices WHERE id = $1 AND partnership_id = $2', [req.params.id, partnershipId]);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const { rowCount } = await pool.query(
    'UPDATE logbook_entries SET invoice_id = $1 WHERE id = $2 AND partnership_id = $3', [inv.id, req.body.entry_id, partnershipId]);
  if (!rowCount) return res.status(404).json({ error: 'Logbook entry not found' });
  res.json({ ok: true });
}));

// DELETE /api/invoices/:id/logbook/:entryId — unlink
router.delete('/:id/logbook/:entryId', handle('DELETE /invoices/:id/logbook', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  await pool.query('UPDATE logbook_entries SET invoice_id = NULL WHERE id = $1 AND invoice_id = $2 AND partnership_id = $3',
    [req.params.entryId, req.params.id, partnershipId]);
  res.sendStatus(204);
}));

module.exports = router;
