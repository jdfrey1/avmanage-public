const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const googleAuth = require('../services/googleAuth');
const googleMail = require('../services/googleMail');
const reports = require('../services/reports');
const { importForeflightCsv, recordForeflightImport } = require('../services/foreflightImport');

const router = express.Router();
router.use(requireAuth);

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

async function getMembership(userId) {
  const { rows } = await pool.query(
    'SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return rows[0];
}

// POST /api/currency/import
router.post('/import', upload.single('logbook'), async (req, res) => {
  try {
    const userId = req.session.userId;
    const { partnership_id: partnershipId } = await getMembership(userId);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const r = await recordForeflightImport({ userId, partnershipId, buffer: req.file.buffer });
    res.json(r);
  } catch (err) {
    console.error('ForeFlight import error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Manual currency entries: landings/approaches flown since the last ForeFlight import. They count
// toward currency until an import covers their date (see importForeflightCsv).
const MANUAL_COLS = `id, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, landings_day, landings_night, approaches, holds_accomplished, notes`;

// GET /api/currency/manual — your manual entries, plus the address to forward ForeFlight emails to
router.get('/manual', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${MANUAL_COLS} FROM currency_events WHERE user_id = $1 AND source = 'manual' ORDER BY event_date DESC, created_at DESC`,
      [req.session.userId]);
    const importEmail = (await googleAuth.isConnected()) ? await googleMail.getAccountEmail() : null;
    res.json({ entries: rows, import_email: importEmail });
  } catch (err) {
    console.error('GET /currency/manual error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/currency/manual { event_date, landings_day, landings_night, approaches, holds, notes }
router.post('/manual', async (req, res) => {
  try {
    const userId = req.session.userId;
    const { partnership_id: partnershipId } = await getMembership(userId);
    const { event_date, notes } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event_date || '')) return res.status(400).json({ error: 'A date is required' });
    const n = (v) => Math.max(0, parseInt(v, 10) || 0);
    const day = n(req.body.landings_day), night = n(req.body.landings_night), appr = n(req.body.approaches);
    const holds = !!req.body.holds;
    if (!day && !night && !appr && !holds) return res.status(400).json({ error: 'Enter landings, approaches or a hold' });
    const eventType = appr > 0 || holds ? 'ifr_session' : night > 0 ? 'night_landing' : 'day_landing';
    const { rows: [row] } = await pool.query(
      `INSERT INTO currency_events
         (user_id, partnership_id, event_date, event_type, landings_day, landings_night, approaches,
          holds_accomplished, source, aircraft_class, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', 'airplane_single_engine_land', $9)
       RETURNING ${MANUAL_COLS}`,
      [userId, partnershipId, event_date, eventType, day, night, appr, holds, (notes || '').trim() || null]);
    res.status(201).json(row);
  } catch (err) {
    console.error('POST /currency/manual error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/currency/manual/:id
router.delete('/manual/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM currency_events WHERE id = $1 AND user_id = $2 AND source = 'manual'`,
      [req.params.id, req.session.userId]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /currency/manual error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/currency
router.get('/', async (req, res) => {
  try {
    let userId = req.session.userId;
    if (req.query.user_id && req.query.user_id !== userId) {
      const { partnership_id: partnershipId } = await getMembership(userId);
      const { rows: [m] } = await pool.query(
        'SELECT 1 FROM partnership_members WHERE user_id = $1 AND partnership_id = $2', [req.query.user_id, partnershipId]);
      if (!m) return res.status(404).json({ error: 'Member not found' });
      userId = req.query.user_id;
    }
    const status = await reports.getCurrencyStatus(userId);
    res.json(status);
  } catch (err) {
    console.error('Currency GET error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/currency/import/download — download most recent imported ForeFlight CSV
router.get('/import/download', async (req, res) => {
  try {
    const { rows: [u] } = await pool.query(
      'SELECT last_foreflight_import_file FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!u?.last_foreflight_import_file) return res.status(404).json({ error: 'No import file found' });
    const filepath = path.join(UPLOADS_DIR, u.last_foreflight_import_file);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Import file not found on disk' });
    res.download(filepath, 'foreflight_logbook.csv');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/currency/medical — save medical expiry date
router.patch('/medical', async (req, res) => {
  try {
    const { medical_expires_date } = req.body;
    await pool.query(
      'UPDATE users SET medical_expires_date = $1 WHERE id = $2',
      [medical_expires_date || null, req.session.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /currency/medical error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/currency/bfr — save BFR accomplishment date
router.patch('/bfr', async (req, res) => {
  try {
    const { bfr_date } = req.body;
    await pool.query(
      'UPDATE users SET bfr_date = $1 WHERE id = $2',
      [bfr_date || null, req.session.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /currency/bfr error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.importForeflightCsv = importForeflightCsv;
module.exports = router;
