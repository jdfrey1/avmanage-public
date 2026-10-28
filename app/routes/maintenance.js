const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const pool    = require('../db');
const requireAuth = require('../middleware/requireAuth');
const googleDrive = require('../services/googleDrive');
const googleAuth = require('../services/googleAuth');
const reports = require('../services/reports');

const router = express.Router();
router.use(requireAuth);

const upload    = multer({ storage: multer.memoryStorage() });
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

const VALID_CATEGORIES = ['maintenance', 'insurance', 'avionics', 'hangar', 'fuel', 'misc'];

async function getPartnershipId(userId) {
  const { rows } = await pool.query(
    'SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return rows[0].partnership_id;
}

async function deleteAttachmentsFor(parentType, parentId) {
  const { rows } = await pool.query(
    'SELECT file_key FROM maintenance_attachments WHERE parent_type = $1 AND parent_id = $2',
    [parentType, parentId]
  );
  for (const a of rows) {
    fs.unlink(path.join(UPLOADS_DIR, a.file_key), () => {});
  }
  await pool.query(
    'DELETE FROM maintenance_attachments WHERE parent_type = $1 AND parent_id = $2',
    [parentType, parentId]
  );
}

// ── Attachment endpoints ─────────────────────────────────────────────────────

// POST /api/maintenance/attachments/upload
router.post('/attachments/upload', upload.single('file'), async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const mime = req.file.mimetype;
    if (!mime.startsWith('image/') && mime !== 'application/pdf') {
      return res.status(400).json({ error: 'File must be an image or PDF' });
    }

    const { parent_type, parent_id } = req.body;
    if (!['log', 'squawk'].includes(parent_type)) {
      return res.status(400).json({ error: 'parent_type must be log or squawk' });
    }
    if (!parent_id) return res.status(400).json({ error: 'parent_id is required' });

    // Verify parent belongs to this partnership
    const table = parent_type === 'log' ? 'maintenance_log' : 'squawks';
    const { rows: [parent] } = await pool.query(
      `SELECT id FROM ${table} WHERE id = $1 AND partnership_id = $2`,
      [parent_id, partnershipId]
    );
    if (!parent) return res.status(404).json({ error: 'Parent entry not found' });

    const ext = mime === 'application/pdf' ? 'pdf' : (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const fileKey = `${crypto.randomUUID()}.${ext}`;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, fileKey), req.file.buffer);

    const { rows: [att] } = await pool.query(`
      INSERT INTO maintenance_attachments
        (partnership_id, parent_type, parent_id, file_key, mime_type, original_name, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, parent_type, parent_id, file_key, mime_type, original_name, uploaded_at
    `, [partnershipId, parent_type, parent_id, fileKey, mime, req.file.originalname || null, req.session.userId]);

    // Archive a copy to the shared Google Drive, if connected. Best-effort.
    if (await googleAuth.isConnected()) {
      try {
        const driveFileId = await googleDrive.uploadFile('maintenance', {
          name: req.file.originalname || fileKey, mimeType: mime, buffer: req.file.buffer,
        });
        await pool.query('UPDATE maintenance_attachments SET drive_file_id = $1 WHERE id = $2', [driveFileId, att.id]);
        att.drive_file_id = driveFileId;
      } catch (err) {
        console.error(`Drive sync failed for maintenance attachment ${att.id}:`, err.message);
      }
    }

    res.status(201).json(att);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /maintenance/attachments/upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/maintenance/attachments?parent_type=log&parent_id=UUID
router.get('/attachments', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { parent_type, parent_id } = req.query;
    if (!parent_type || !parent_id) {
      return res.status(400).json({ error: 'parent_type and parent_id are required' });
    }
    const { rows } = await pool.query(
      `SELECT id, parent_type, parent_id, file_key, mime_type, original_name, uploaded_at
       FROM maintenance_attachments
       WHERE partnership_id = $1 AND parent_type = $2 AND parent_id = $3
       ORDER BY uploaded_at ASC`,
      [partnershipId, parent_type, parent_id]
    );
    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /maintenance/attachments error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/maintenance/attachments/:id/file
router.get('/attachments/:id/file', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [att] } = await pool.query(
      'SELECT file_key, mime_type FROM maintenance_attachments WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!att) return res.status(404).json({ error: 'Attachment not found' });
    const filepath = path.join(UPLOADS_DIR, att.file_key);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File missing' });
    res.sendFile(filepath);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /maintenance/attachments/:id/file error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/maintenance/attachments/:id
router.delete('/attachments/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [att] } = await pool.query(
      'SELECT file_key FROM maintenance_attachments WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!att) return res.status(404).json({ error: 'Attachment not found' });
    fs.unlink(path.join(UPLOADS_DIR, att.file_key), () => {});
    await pool.query('DELETE FROM maintenance_attachments WHERE id = $1', [req.params.id]);
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /maintenance/attachments/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Static sub-routes (must come before /:id) ────────────────────────────────

router.get('/summary', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const year = parseInt(req.query.year) || new Date().getFullYear();
    res.json(await reports.getMaintenanceCostSummary(partnershipId, year));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /maintenance/summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/cost-analysis', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);

    let startDate, endDate;
    const today = new Date().toISOString().slice(0, 10);
    const currentYear = new Date().getFullYear();

    if (req.query.start && req.query.end) {
      startDate = req.query.start;
      endDate   = req.query.end;
    } else if (req.query.year) {
      const year = parseInt(req.query.year);
      startDate = `${year}-01-01`;
      endDate   = `${year}-12-31`;
    } else {
      // Default: YTD
      startDate = `${currentYear}-01-01`;
      endDate   = today;
    }

    const [{ rows: costRows }, { rows: flightRows }] = await Promise.all([
      pool.query(`
        SELECT category, COALESCE(SUM(cost_amount), 0)::float AS total
        FROM maintenance_log
        WHERE partnership_id = $1
          AND cost_amount IS NOT NULL
          AND entry_date >= $2 AND entry_date <= $3
        GROUP BY category
      `, [partnershipId, startDate, endDate]),
      pool.query(`
        SELECT f.pilot_id, u.name AS pilot_name, COALESCE(SUM(f.flight_time), 0)::float AS hours
        FROM flights f
        JOIN users u ON u.id = f.pilot_id
        WHERE f.partnership_id = $1
          AND f.flight_date >= $2 AND f.flight_date <= $3
        GROUP BY f.pilot_id, u.name
        ORDER BY hours DESC
      `, [partnershipId, startDate, endDate]),
    ]);

    const byCategory  = costRows;
    const totalCost   = costRows.reduce((s, r) => s + r.total, 0);
    const variableCost = costRows.find(r => r.category === 'fuel')?.total ?? 0;
    const fixedCost   = totalCost - variableCost;
    const totalHours  = flightRows.reduce((s, r) => s + r.hours, 0);
    const costPerHour = totalHours > 0 ? totalCost / totalHours : 0;

    const pilots = flightRows.map(r => ({
      pilot_id:   r.pilot_id,
      pilot_name: r.pilot_name,
      hours:      r.hours,
      pct:        totalHours > 0 ? (r.hours / totalHours) * 100 : 0,
    }));

    res.json({ start_date: startDate, end_date: endDate, total_hours: totalHours, pilots, total_cost: totalCost, fixed_cost: fixedCost, variable_cost: variableCost, cost_per_hour: costPerHour, by_category: byCategory });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /maintenance/cost-analysis error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Hour-based maintenance intervals (e.g. oil change every 50 Flight hrs) ──
router.get('/intervals', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    res.json(await reports.getHourIntervals(partnershipId));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /maintenance/intervals error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/intervals', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { title, description, interval_hours, last_done_hours, last_done_date, warn_hours } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
    if (!(parseFloat(interval_hours) > 0)) return res.status(400).json({ error: 'interval_hours must be positive' });
    let lastDone = last_done_hours;
    if (lastDone == null || lastDone === '') lastDone = await reports.getCurrentFlightHours(partnershipId);
    if (lastDone == null) return res.status(400).json({ error: 'last_done_hours is required (no flights logged yet)' });
    const { rows: [row] } = await pool.query(`
      INSERT INTO maintenance_intervals
        (partnership_id, created_by, title, description, interval_hours, last_done_hours, last_done_date, warn_hours)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [partnershipId, req.session.userId, title.trim(), description || null,
        interval_hours, lastDone, last_done_date || null, warn_hours ?? 10]);
    res.status(201).json(row);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /maintenance/intervals error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/intervals/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const allowed = ['title', 'description', 'interval_hours', 'last_done_hours', 'last_done_date', 'warn_hours'];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
    const sets = updates.map(([k], i) => `${k} = $${i + 3}`).join(', ');
    const { rowCount } = await pool.query(
      `UPDATE maintenance_intervals SET ${sets} WHERE id = $1 AND partnership_id = $2`,
      [req.params.id, partnershipId, ...updates.map(([, v]) => (v === '' ? null : v))]);
    if (!rowCount) return res.status(404).json({ error: 'Interval not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /maintenance/intervals/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark done: resets the interval from the given Flight-timer reading (default: current).
router.post('/intervals/:id/done', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    let hours = req.body?.hours;
    if (hours == null || hours === '') hours = await reports.getCurrentFlightHours(partnershipId);
    if (hours == null) return res.status(400).json({ error: 'hours is required (no flights logged yet)' });
    const { rowCount } = await pool.query(
      `UPDATE maintenance_intervals SET last_done_hours = $3, last_done_date = $4
       WHERE id = $1 AND partnership_id = $2 AND active = true`,
      [req.params.id, partnershipId, hours, req.body?.date || new Date().toISOString().slice(0, 10)]);
    if (!rowCount) return res.status(404).json({ error: 'Interval not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /maintenance/intervals/:id/done error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/intervals/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rowCount } = await pool.query(
      'UPDATE maintenance_intervals SET active = false WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]);
    if (!rowCount) return res.status(404).json({ error: 'Interval not found' });
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /maintenance/intervals/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Aircraft status (Dashboard banner / scheduler): grounded, overdue inspections, insurance ──
router.get('/aircraft-status', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    res.json(await reports.getAircraftStatus(partnershipId));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /maintenance/aircraft-status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Date-based inspections & expirations (annual, ELT, avionics checks, CAPS, registration) ──
router.get('/inspections', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    res.json(await reports.getInspections(partnershipId));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /maintenance/inspections error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/inspections', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { title, notes, interval_months, due_date, last_done_date, warn_days } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
    const { rows: [row] } = await pool.query(`
      INSERT INTO inspection_items (partnership_id, title, notes, interval_months, due_date, last_done_date, warn_days)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [partnershipId, title.trim(), notes || null, interval_months || null, due_date || null, last_done_date || null, warn_days ?? 30]);
    res.status(201).json(row);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /maintenance/inspections error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/inspections/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const allowed = ['title', 'notes', 'interval_months', 'last_done_date', 'due_date', 'warn_days'];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
    const sets = updates.map(([k], i) => `${k} = $${i + 3}`).join(', ');
    const { rowCount } = await pool.query(
      `UPDATE inspection_items SET ${sets} WHERE id = $1 AND partnership_id = $2`,
      [req.params.id, partnershipId, ...updates.map(([, v]) => (v === '' ? null : v))]);
    if (!rowCount) return res.status(404).json({ error: 'Inspection not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /maintenance/inspections/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark done on a date. With an interval, the next due date is the end of the calendar month
// that many months later (how annuals and the 24-month checks are counted); without one, only
// the last-done date is recorded and the due date is left for you to set.
router.post('/inspections/:id/done', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const date = req.body?.date || new Date().toISOString().slice(0, 10);
    const { rowCount } = await pool.query(
      `UPDATE inspection_items SET last_done_date = $3::date,
         due_date = CASE WHEN interval_months IS NULL THEN due_date
                    ELSE (date_trunc('month', $3::date + make_interval(months => interval_months)) + interval '1 month - 1 day')::date END
       WHERE id = $1 AND partnership_id = $2 AND active`,
      [req.params.id, partnershipId, date]);
    if (!rowCount) return res.status(404).json({ error: 'Inspection not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /maintenance/inspections/:id/done error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/inspections/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rowCount } = await pool.query(
      'UPDATE inspection_items SET active = false WHERE id = $1 AND partnership_id = $2', [req.params.id, partnershipId]);
    if (!rowCount) return res.status(404).json({ error: 'Inspection not found' });
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /maintenance/inspections/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/recurring', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows } = await pool.query(`
      SELECT id, category, title, description, cost_amount, day_of_month,
             TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date, active, created_at
      FROM maintenance_recurring
      WHERE partnership_id = $1 AND active = true
      ORDER BY next_due_date ASC
    `, [partnershipId]);
    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /maintenance/recurring error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/recurring', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { category, title, description, cost_amount, day_of_month, next_due_date } = req.body;

    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
    if (!cost_amount || parseFloat(cost_amount) <= 0) return res.status(400).json({ error: 'cost_amount must be positive' });
    if (!next_due_date) return res.status(400).json({ error: 'next_due_date is required' });

    const { rows: [entry] } = await pool.query(`
      INSERT INTO maintenance_recurring
        (partnership_id, created_by, category, title, description, cost_amount, day_of_month, next_due_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, category, title, description, cost_amount, day_of_month,
                TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date, active, created_at
    `, [
      partnershipId, req.session.userId, category, title.trim(),
      description ?? null, parseFloat(cost_amount),
      parseInt(day_of_month) || 1, next_due_date,
    ]);

    res.status(201).json(entry);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /maintenance/recurring error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/recurring/:id/post', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { id } = req.params;

    const { rows: [rec] } = await pool.query(
      'SELECT * FROM maintenance_recurring WHERE id = $1 AND partnership_id = $2 AND active = true',
      [id, partnershipId]
    );
    if (!rec) return res.status(404).json({ error: 'Recurring entry not found' });

    const { rows: [logEntry] } = await pool.query(`
      INSERT INTO maintenance_log
        (partnership_id, created_by, entry_date, category, title, description, cost_amount)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, TO_CHAR(entry_date, 'YYYY-MM-DD') AS entry_date,
                category, title, description, cost_amount, tach_at_service, performed_by, created_at
    `, [partnershipId, req.session.userId, rec.next_due_date, rec.category, rec.title, rec.description, rec.cost_amount]);

    await pool.query(
      "UPDATE maintenance_recurring SET next_due_date = next_due_date + INTERVAL '1 month' WHERE id = $1",
      [id]
    );

    const { rows: [{ name }] } = await pool.query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
    res.status(201).json({ ...logEntry, created_by_name: name });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /maintenance/recurring/:id/post error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/recurring/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { id } = req.params;

    const { rows: [existing] } = await pool.query(
      'SELECT id FROM maintenance_recurring WHERE id = $1 AND partnership_id = $2',
      [id, partnershipId]
    );
    if (!existing) return res.status(404).json({ error: 'Recurring entry not found' });

    const { category, title, description, cost_amount, day_of_month, next_due_date } = req.body;
    if (category && !VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });

    const sets = [];
    const params = [];
    if (category      !== undefined) { params.push(category);             sets.push(`category = $${params.length}`); }
    if (title         !== undefined) { params.push(title.trim());         sets.push(`title = $${params.length}`); }
    if (description   !== undefined) { params.push(description);          sets.push(`description = $${params.length}`); }
    if (cost_amount   !== undefined) { params.push(parseFloat(cost_amount)); sets.push(`cost_amount = $${params.length}`); }
    if (day_of_month  !== undefined) { params.push(parseInt(day_of_month)); sets.push(`day_of_month = $${params.length}`); }
    if (next_due_date !== undefined) { params.push(next_due_date);        sets.push(`next_due_date = $${params.length}`); }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    const { rows: [entry] } = await pool.query(`
      UPDATE maintenance_recurring SET ${sets.join(', ')} WHERE id = $${params.length}
      RETURNING id, category, title, description, cost_amount, day_of_month,
                TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date, active, created_at
    `, params);

    res.json(entry);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /maintenance/recurring/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/recurring/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rowCount } = await pool.query(
      'UPDATE maintenance_recurring SET active = false WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Recurring entry not found' });
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /maintenance/recurring/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Log entries CRUD ─────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { year } = req.query;

    const conditions = ['m.partnership_id = $1'];
    const params = [partnershipId];

    if (year) {
      params.push(parseInt(year));
      conditions.push(`EXTRACT(YEAR FROM m.entry_date) = $${params.length}`);
    }

    const { rows } = await pool.query(`
      SELECT
        m.id,
        TO_CHAR(m.entry_date, 'YYYY-MM-DD') AS entry_date,
        m.category, m.title, m.description,
        m.cost_amount, m.tach_at_service, m.performed_by,
        m.created_at,
        u.name AS created_by_name
      FROM maintenance_log m
      JOIN users u ON u.id = m.created_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.entry_date DESC, m.created_at DESC
    `, params);

    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /maintenance error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { entry_date, category, title, description, cost_amount, tach_at_service, performed_by } = req.body;

    if (!entry_date) return res.status(400).json({ error: 'entry_date is required' });
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });

    const { rows: [entry] } = await pool.query(`
      INSERT INTO maintenance_log
        (partnership_id, created_by, entry_date, category, title, description, cost_amount, tach_at_service, performed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING
        id, TO_CHAR(entry_date, 'YYYY-MM-DD') AS entry_date,
        category, title, description, cost_amount, tach_at_service, performed_by, created_at
    `, [
      partnershipId, req.session.userId, entry_date, category, title.trim(),
      description ?? null,
      cost_amount != null ? parseFloat(cost_amount) : null,
      tach_at_service != null ? parseFloat(tach_at_service) : null,
      performed_by ?? null,
    ]);

    const { rows: [{ name }] } = await pool.query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
    res.status(201).json({ ...entry, created_by_name: name });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /maintenance error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { id } = req.params;

    const { rows: [existing] } = await pool.query(
      'SELECT id FROM maintenance_log WHERE id = $1 AND partnership_id = $2',
      [id, partnershipId]
    );
    if (!existing) return res.status(404).json({ error: 'Entry not found' });

    const { entry_date, category, title, description, cost_amount, tach_at_service, performed_by } = req.body;

    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const sets = [];
    const params = [];

    if (entry_date      !== undefined) { params.push(entry_date);   sets.push(`entry_date = $${params.length}`); }
    if (category        !== undefined) { params.push(category);     sets.push(`category = $${params.length}`); }
    if (title           !== undefined) { params.push(title.trim()); sets.push(`title = $${params.length}`); }
    if (description     !== undefined) { params.push(description);  sets.push(`description = $${params.length}`); }
    if (cost_amount     !== undefined) { params.push(cost_amount != null ? parseFloat(cost_amount) : null); sets.push(`cost_amount = $${params.length}`); }
    if (tach_at_service !== undefined) { params.push(tach_at_service != null ? parseFloat(tach_at_service) : null); sets.push(`tach_at_service = $${params.length}`); }
    if (performed_by    !== undefined) { params.push(performed_by); sets.push(`performed_by = $${params.length}`); }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    const { rows: [entry] } = await pool.query(`
      UPDATE maintenance_log SET ${sets.join(', ')} WHERE id = $${params.length}
      RETURNING
        id, TO_CHAR(entry_date, 'YYYY-MM-DD') AS entry_date,
        category, title, description, cost_amount, tach_at_service, performed_by, created_at
    `, params);

    const { rows: [{ name }] } = await pool.query(
      'SELECT u.name FROM users u JOIN maintenance_log m ON m.created_by = u.id WHERE m.id = $1', [id]
    );
    res.json({ ...entry, created_by_name: name });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /maintenance/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [existing] } = await pool.query(
      'SELECT id FROM maintenance_log WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!existing) return res.status(404).json({ error: 'Entry not found' });

    await deleteAttachmentsFor('log', req.params.id);

    const { rowCount } = await pool.query(
      'DELETE FROM maintenance_log WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Entry not found' });
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /maintenance/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
