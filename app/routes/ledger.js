const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const reports = require('../services/reports');

const router = express.Router();
router.use(requireAuth);

async function getMembership(userId) {
  const { rows } = await pool.query(
    'SELECT partnership_id, role FROM partnership_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return { partnershipId: rows[0].partnership_id, role: rows[0].role };
}

async function isPartnershipMember(partnershipId, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM partnership_members WHERE partnership_id = $1 AND user_id = $2',
    [partnershipId, userId]
  );
  return rows.length > 0;
}

// CTE: running_balance computed via window function, partitioned per lessee
// Params: $1 = partnershipId, $2 = lesseeId
const BALANCE_CTE = `
  WITH computed AS (
    SELECT l.id, l.entry_type, l.direction, l.amount, l.lessee_id,
      TO_CHAR(l.effective_date, 'YYYY-MM-DD') AS effective_date,
      l.description, l.created_at, l.related_flight_id,
      COALESCE((SELECT json_agg(json_build_object('id', i.id, 'invoice_number', i.invoice_number) ORDER BY i.invoice_number)
        FROM ledger_invoices li JOIN invoices i ON i.id = li.invoice_id WHERE li.ledger_id = l.id), '[]'::json) AS invoices,
      COALESCE((SELECT json_agg(json_build_object('id', d.id, 'title', d.title) ORDER BY d.title)
        FROM ledger_documents ld JOIN documents d ON d.id = ld.document_id WHERE ld.ledger_id = l.id), '[]'::json) AS documents,
      u.name AS created_by_name,
      lu.name AS lessee_name,
      SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END)
        OVER (PARTITION BY l.lessee_id ORDER BY l.effective_date ASC, l.created_at ASC)
        AS running_balance
    FROM financial_ledger l
    JOIN users u ON u.id = l.created_by
    LEFT JOIN users lu ON lu.id = l.lessee_id
    WHERE l.partnership_id = $1
      AND l.lessee_id = $2
  )
`;

// Simple select without running_balance (for single-entry fetches)
const SELECT_ENTRY = `
  SELECT l.id, l.entry_type, l.direction, l.amount, l.lessee_id,
    TO_CHAR(l.effective_date, 'YYYY-MM-DD') AS effective_date,
    l.description, l.created_at, l.related_flight_id,
    COALESCE((SELECT json_agg(json_build_object('id', i.id, 'invoice_number', i.invoice_number) ORDER BY i.invoice_number)
        FROM ledger_invoices li JOIN invoices i ON i.id = li.invoice_id WHERE li.ledger_id = l.id), '[]'::json) AS invoices,
    COALESCE((SELECT json_agg(json_build_object('id', d.id, 'title', d.title) ORDER BY d.title)
        FROM ledger_documents ld JOIN documents d ON d.id = ld.document_id WHERE ld.ledger_id = l.id), '[]'::json) AS documents,
    u.name AS created_by_name,
    lu.name AS lessee_name
  FROM financial_ledger l
  JOIN users u ON u.id = l.created_by
  LEFT JOIN users lu ON lu.id = l.lessee_id
`;

// Resolve which lessee's ledger to view: default to self, allow any member to view others via ?lessee_id
async function resolveLesseeId(userId, role, partnershipId, queryParam) {
  return queryParam || userId;
}

// ── static routes first (must come before /:id) ──────────────────────────────

// GET /api/ledger/lessees — list all members in partnership (for switcher)
// GET /api/ledger/cost-analysis?start=YYYY-MM-DD&end=YYYY-MM-DD (default: year to date)
router.get('/cost-analysis', async (req, res) => {
  try {
    const { rows: [m] } = await pool.query('SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1', [req.session.userId]);
    if (!m) return res.status(404).json({ error: 'No partnership found' });
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    const today = new Date().toLocaleDateString('en-CA');
    const start = isDate(req.query.start) ? req.query.start : `${today.slice(0, 4)}-01-01`;
    const end = isDate(req.query.end) ? req.query.end : today;
    res.json(await reports.getCostAnalysis(m.partnership_id, start, end));
  } catch (err) {
    console.error('GET /ledger/cost-analysis error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/lessees', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    const { rows } = await pool.query(
      `SELECT u.id, u.name, pm.role FROM users u
       JOIN partnership_members pm ON pm.user_id = u.id
       WHERE pm.partnership_id = $1
       ORDER BY u.name`,
      [partnershipId]
    );
    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /ledger/lessees error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/ledger/recurring — list recurring charges for a lessee
router.get('/recurring', async (req, res) => {
  try {
    const { partnershipId, role } = await getMembership(req.session.userId);
    const lesseeId = await resolveLesseeId(req.session.userId, role, partnershipId, req.query.lessee_id);
    if (!lesseeId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT r.id, r.lessee_id, r.entry_type, r.direction, r.amount,
              r.description_template, r.day_of_month, r.active, r.created_at,
              TO_CHAR(r.next_due_date, 'YYYY-MM-DD') AS next_due_date,
              u.name AS lessee_name
       FROM recurring_charges r
       JOIN users u ON u.id = r.lessee_id
       WHERE r.partnership_id = $1 AND r.lessee_id = $2 AND r.active = true
       ORDER BY r.next_due_date ASC`,
      [partnershipId, lesseeId]
    );
    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /ledger/recurring error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/ledger/recurring — create a recurring charge
router.post('/recurring', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    const { entry_type, direction, amount, description_template, day_of_month = 1, next_due_date, lessee_id: bodyLesseeId } = req.body;
    const lesseeId = bodyLesseeId || req.session.userId;

    if (!entry_type || !direction || !amount || !description_template || !next_due_date) {
      return res.status(400).json({ error: 'entry_type, direction, amount, description_template, and next_due_date are required' });
    }
    if (!['debit', 'credit'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be debit or credit' });
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be positive' });
    if (!(await isPartnershipMember(partnershipId, lesseeId))) {
      return res.status(400).json({ error: 'lessee_id is not a member of this partnership' });
    }

    const { rows: [r] } = await pool.query(`
      INSERT INTO recurring_charges
        (partnership_id, lessee_id, entry_type, direction, amount, description_template, day_of_month, next_due_date, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [partnershipId, lesseeId, entry_type, direction, amt, description_template, day_of_month, next_due_date, req.session.userId]);
    res.status(201).json(r);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /ledger/recurring error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/ledger/recurring/:id/post — apply next occurrence as a ledger entry
router.post('/recurring/:id/post', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    const { rows: [charge] } = await pool.query(
      'SELECT * FROM recurring_charges WHERE id = $1 AND partnership_id = $2 AND active = true',
      [req.params.id, partnershipId]
    );
    if (!charge) return res.status(404).json({ error: 'Recurring charge not found' });

    const effectiveDate = charge.next_due_date instanceof Date
      ? charge.next_due_date.toISOString().slice(0, 10)
      : String(charge.next_due_date).slice(0, 10);

    const { rows: [inserted] } = await pool.query(`
      INSERT INTO financial_ledger
        (partnership_id, created_by, lessee_id, entry_type, direction, amount, effective_date, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id
    `, [partnershipId, req.session.userId, charge.lessee_id, charge.entry_type, charge.direction,
        charge.amount, effectiveDate, charge.description_template]);

    // Advance next_due_date by 1 month
    await pool.query(
      `UPDATE recurring_charges SET next_due_date = next_due_date + INTERVAL '1 month' WHERE id = $1`,
      [charge.id]
    );

    const { rows: [entry] } = await pool.query(
      `${BALANCE_CTE} SELECT * FROM computed WHERE id = $3`,
      [partnershipId, charge.lessee_id, inserted.id]
    );
    res.status(201).json(entry);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /ledger/recurring/:id/post error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/ledger/recurring/:id
router.patch('/recurring/:id', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    const allowed = ['entry_type', 'direction', 'amount', 'description_template', 'day_of_month', 'next_due_date'];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    if (req.body.direction && !['debit', 'credit'].includes(req.body.direction)) {
      return res.status(400).json({ error: 'direction must be debit or credit' });
    }
    if (req.body.amount !== undefined) {
      const amt = parseFloat(req.body.amount);
      if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be positive' });
    }

    const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const { rows: [r] } = await pool.query(
      `UPDATE recurring_charges SET ${setClauses} WHERE id = $1 AND partnership_id = $${updates.length + 2}
       RETURNING id, lessee_id, entry_type, direction, amount, description_template, day_of_month, active, created_at,
         TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date`,
      [req.params.id, ...updates.map(([, v]) => v), partnershipId]
    );
    if (!r) return res.status(404).json({ error: 'Recurring charge not found' });
    res.json(r);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /ledger/recurring/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/ledger/recurring/:id
router.delete('/recurring/:id', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    const { rowCount } = await pool.query(
      'UPDATE recurring_charges SET active = false WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Recurring charge not found' });
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /ledger/recurring/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── parameterized routes ──────────────────────────────────────────────────────

// GET /api/ledger
router.get('/', async (req, res) => {
  try {
    const { partnershipId, role } = await getMembership(req.session.userId);
    const lesseeId = await resolveLesseeId(req.session.userId, role, partnershipId, req.query.lessee_id);
    if (!lesseeId) return res.json([]);
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const { rows } = await pool.query(
      `${BALANCE_CTE} SELECT * FROM computed ORDER BY effective_date DESC, created_at DESC LIMIT $3 OFFSET $4`,
      [partnershipId, lesseeId, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /ledger error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/ledger
router.post('/', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    const { entry_type, direction, amount, effective_date, description, related_flight_id, lessee_id: bodyLesseeId } = req.body;
    const lesseeId = bodyLesseeId || req.session.userId;

    if (!entry_type || !direction || !amount || !effective_date || !description) {
      return res.status(400).json({ error: 'entry_type, direction, amount, effective_date, and description are required' });
    }
    if (!['debit', 'credit'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be debit or credit' });
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!(await isPartnershipMember(partnershipId, lesseeId))) {
      return res.status(400).json({ error: 'lessee_id is not a member of this partnership' });
    }

    const { rows: [inserted] } = await pool.query(`
      INSERT INTO financial_ledger
        (partnership_id, created_by, lessee_id, entry_type, direction, amount, effective_date, description, related_flight_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id
    `, [partnershipId, req.session.userId, lesseeId, entry_type, direction, amt, effective_date, description, related_flight_id || null]);

    const { rows: [entry] } = await pool.query(
      `${BALANCE_CTE} SELECT * FROM computed WHERE id = $3`,
      [partnershipId, lesseeId, inserted.id]
    );
    res.status(201).json(entry);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /ledger error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/ledger/:id
router.get('/:id', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    const { rows: [entry] } = await pool.query(
      `${SELECT_ENTRY} WHERE l.id = $1 AND l.partnership_id = $2`,
      [req.params.id, partnershipId]
    );
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    res.json(entry);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /ledger/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/ledger/:id
router.patch('/:id', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    const { rows: [existing] } = await pool.query(
      'SELECT id, lessee_id FROM financial_ledger WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!existing) return res.status(404).json({ error: 'Entry not found' });

    const allowed = ['entry_type', 'direction', 'amount', 'effective_date', 'description'];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    if (req.body.direction && !['debit', 'credit'].includes(req.body.direction)) {
      return res.status(400).json({ error: 'direction must be debit or credit' });
    }
    if (req.body.amount !== undefined) {
      const amt = parseFloat(req.body.amount);
      if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be positive' });
    }

    const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    await pool.query(
      `UPDATE financial_ledger SET ${setClauses} WHERE id = $1`,
      [req.params.id, ...updates.map(([, v]) => v)]
    );

    const { rows: [entry] } = await pool.query(
      `${SELECT_ENTRY} WHERE l.id = $1`,
      [req.params.id]
    );
    res.json(entry);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /ledger/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/ledger/:id/documents { document_id } — link an aircraft document (e.g. an insurance binder)
router.post('/:id/documents', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    const { rowCount } = await pool.query(
      `INSERT INTO ledger_documents (ledger_id, document_id)
       SELECT l.id, d.id FROM financial_ledger l, documents d
       WHERE l.id = $1 AND l.partnership_id = $3 AND d.id = $2 AND d.partnership_id = $3
       ON CONFLICT DO NOTHING`, [req.params.id, req.body.document_id, partnershipId]);
    if (!rowCount) {
      const { rows: [ok] } = await pool.query(
        'SELECT 1 FROM ledger_documents ld JOIN financial_ledger l ON l.id = ld.ledger_id WHERE ld.ledger_id = $1 AND ld.document_id = $2 AND l.partnership_id = $3',
        [req.params.id, req.body.document_id, partnershipId]);
      if (!ok) return res.status(404).json({ error: 'Entry or document not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /ledger/:id/documents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/ledger/:id/documents/:documentId — unlink
router.delete('/:id/documents/:documentId', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    await pool.query(
      `DELETE FROM ledger_documents ld USING financial_ledger l
       WHERE ld.ledger_id = $1 AND ld.document_id = $2 AND l.id = ld.ledger_id AND l.partnership_id = $3`,
      [req.params.id, req.params.documentId, partnershipId]);
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /ledger/:id/documents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/ledger/:id
router.delete('/:id', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    const { rowCount } = await pool.query(
      'DELETE FROM financial_ledger WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /ledger/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
