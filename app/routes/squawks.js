const express = require('express');
const fs   = require('fs');
const path = require('path');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const googleMail = require('../services/googleMail');
const googleAuth = require('../services/googleAuth');


const router = express.Router();
router.use(requireAuth);

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

async function getPartnershipId(userId) {
  const { rows } = await pool.query(
    'SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return rows[0].partnership_id;
}

const VALID_SEVERITIES = ['major', 'minor', 'note'];
const VALID_STATUSES   = ['open', 'in_progress', 'resolved'];

router.get('/', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { status } = req.query;

    const conditions = ['s.partnership_id = $1'];
    const params = [partnershipId];

    // 'unresolved' = open or planned — anything still wrong with the aircraft.
    if (status === 'unresolved') {
      conditions.push(`s.status <> 'resolved'`);
    } else if (status && VALID_STATUSES.includes(status)) {
      params.push(status);
      conditions.push(`s.status = $${params.length}`);
    }

    const { rows } = await pool.query(`
      SELECT
        s.id, s.description, s.severity, s.status,
        s.tach_at_report, s.resolution_notes,
        s.reported_at, s.resolved_at,
        u.name AS reported_by_name
      FROM squawks s
      JOIN users u ON u.id = s.reported_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE s.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
        s.reported_at DESC
    `, params);

    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /squawks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { description, severity, tach_at_report } = req.body;

    if (!description?.trim()) return res.status(400).json({ error: 'description is required' });
    if (!VALID_SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'severity must be major, minor, or note' });
    }

    const { rows: [squawk] } = await pool.query(`
      INSERT INTO squawks (partnership_id, reported_by, description, severity, tach_at_report)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, description, severity, status, tach_at_report, resolution_notes, reported_at, resolved_at
    `, [partnershipId, req.session.userId, description.trim(), severity, tach_at_report ?? null]);

    const { rows: [{ name }] } = await pool.query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
    res.status(201).json({ ...squawk, reported_by_name: name });

    // Email the partnership when a new squawk is reported. Fire-and-forget — a Gmail hiccup
    // shouldn't affect the squawk actually being logged, and the response has already gone out.
    googleAuth.isConnected().then(async (connected) => {
      if (!connected) return;
      const { rows: recipients } = await pool.query(
        `SELECT u.email FROM users u
         JOIN partnership_members pm ON pm.user_id = u.id
         WHERE pm.partnership_id = $1`,
        [partnershipId]
      );
      if (recipients.length === 0) return;
      await googleMail.sendMail({
        to: recipients.map(r => r.email),
        subject: `New squawk reported (${severity}): ${description.trim().slice(0, 60)}`,
        html: `<p><strong>${name}</strong> reported a new <strong>${severity}</strong> squawk:</p>` +
              `<p>${description.trim()}</p>` +
              (tach_at_report ? `<p>Tach at report: ${tach_at_report}</p>` : ''),
      });
    }).catch((err) => console.error(`Squawk alert email failed for squawk ${squawk.id}:`, err.message));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /squawks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { id } = req.params;
    const { description, severity, status, resolution_notes } = req.body;

    const { rows: [existing] } = await pool.query(
      'SELECT id FROM squawks WHERE id = $1 AND partnership_id = $2',
      [id, partnershipId]
    );
    if (!existing) return res.status(404).json({ error: 'Squawk not found' });

    if (severity && !VALID_SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const sets = [];
    const params = [];

    if (description !== undefined) { params.push(description.trim()); sets.push(`description = $${params.length}`); }
    if (severity   !== undefined) { params.push(severity);             sets.push(`severity = $${params.length}`); }
    if (resolution_notes !== undefined) { params.push(resolution_notes); sets.push(`resolution_notes = $${params.length}`); }
    if (status !== undefined) {
      params.push(status); sets.push(`status = $${params.length}`);
      // Keep the original resolved date when a resolved squawk is saved again.
      if (status === 'resolved') sets.push(`resolved_at = CASE WHEN status = 'resolved' THEN resolved_at ELSE NOW() END`);
      else sets.push(`resolved_at = NULL`);
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    const { rows: [squawk] } = await pool.query(`
      UPDATE squawks SET ${sets.join(', ')} WHERE id = $${params.length}
      RETURNING id, description, severity, status, tach_at_report, resolution_notes, reported_at, resolved_at
    `, params);

    const { rows: [{ name }] } = await pool.query(
      'SELECT u.name FROM users u JOIN squawks s ON s.reported_by = u.id WHERE s.id = $1', [id]
    );
    res.json({ ...squawk, reported_by_name: name });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /squawks/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [existing] } = await pool.query(
      'SELECT id FROM squawks WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!existing) return res.status(404).json({ error: 'Squawk not found' });

    // cascade-delete attachment files
    const { rows: attaches } = await pool.query(
      "SELECT file_key FROM maintenance_attachments WHERE parent_type = 'squawk' AND parent_id = $1",
      [req.params.id]
    );
    for (const a of attaches) fs.unlink(path.join(UPLOADS_DIR, a.file_key), () => {});
    await pool.query(
      "DELETE FROM maintenance_attachments WHERE parent_type = 'squawk' AND parent_id = $1",
      [req.params.id]
    );

    await pool.query('DELETE FROM squawks WHERE id = $1', [req.params.id]);
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /squawks/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
