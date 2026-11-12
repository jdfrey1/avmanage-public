const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const { matchUnattached } = require('../services/garminMatch');
const { storeGarminLog, SUMMARY, UPLOADS_DIR } = require('../services/garminImport');
const engineAnalysis = require('../services/engineAnalysis');

// Garmin avionics data logs ("Original CSV" downloads from flyGarmin), one per engine run.
// Uploaded logs are matched to the logged flight on the same local date (narrowed by
// FlightAware times and route when there are several), or left unmatched for manual attach.

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 30 } });

async function getMembership(userId) {
  const { rows: [m] } = await pool.query(
    'SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1', [userId]);
  if (!m) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return m;
}
const fail = (res, err, tag) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${tag} error:`, err);
  res.status(500).json({ error: 'Internal server error' });
};

// POST /api/garmin/upload  (multipart "logs", one or more; optional flight_id to attach all to,
// or hold=1 to leave them unattached — Log Flight attaches them once the new flight is saved)
router.post('/upload', upload.array('logs', 30), async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
    let forFlight = null;
    if (req.body.flight_id) {
      const { rows: [f] } = await pool.query('SELECT id FROM flights WHERE id = $1 AND partnership_id = $2', [req.body.flight_id, partnership_id]);
      if (!f) return res.status(404).json({ error: 'Flight not found' });
      forFlight = f.id;
    }

    const results = [];
    for (const file of req.files) {
      const name = file.originalname.replace(/(\.csv)+$/i, '.csv');
      try {
        const r = await storeGarminLog({
          partnershipId: partnership_id, userId: req.session.userId, name, buffer: file.buffer,
          flightId: forFlight || (req.body.hold === '1' ? null : undefined),
        });
        results.push({ filename: name, ...r });
      } catch (err) {
        if (!err.status) console.error(`Garmin log ${name} failed:`, err);
        results.push({ filename: name, status: 'error', error: err.status ? err.message : 'Could not read this file' });
      }
    }
    res.json({ results });
  } catch (err) { fail(res, err, 'POST /garmin/upload'); }
});

// GET /api/garmin/unmatched — logs not attached to a flight
router.get('/unmatched', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    const { rows } = await pool.query(
      `SELECT ${SUMMARY} FROM garmin_data_logs WHERE partnership_id = $1 AND flight_id IS NULL ORDER BY started_at DESC LIMIT 30`,
      [partnership_id]);
    res.json(rows);
  } catch (err) { fail(res, err, 'GET /garmin/unmatched'); }
});

// GET /api/garmin/trends — per-engine-run stats (oldest first) plus engine findings: limit
// exceedances and in-flight events, outliers against this engine's history, and trend shifts.
const { loadAnalysis } = engineAnalysis;

router.get('/trends', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    res.json(await loadAnalysis(partnership_id, Math.min(parseInt(req.query.limit, 10) || 100, 500)));
  } catch (err) { fail(res, err, 'GET /garmin/trends'); }
});

// GET /api/garmin/findings — open engine findings only, with their flight (for the Dashboard)
router.get('/findings', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    const { runs, findings } = await loadAnalysis(partnership_id, 200);
    const byId = new Map(runs.map(r => [r.id, r]));
    res.json(findings.map(f => {
      const r = byId.get(f.log_id);
      return { ...f, run: r ? { started_at: r.started_at, origin: r.origin, destination: r.destination, pilot_name: r.pilot_name } : null };
    }));
  } catch (err) { fail(res, err, 'GET /garmin/findings'); }
});

// POST /api/garmin/findings/ack { key, note } — mark an engine finding addressed
router.post('/findings/ack', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    const key = String(req.body.key || '').slice(0, 300);
    if (!key) return res.status(400).json({ error: 'key is required' });
    await pool.query(
      `INSERT INTO engine_finding_acks (partnership_id, finding_key, note, acked_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (partnership_id, finding_key) DO UPDATE SET note = EXCLUDED.note, acked_by = EXCLUDED.acked_by, acked_at = NOW()`,
      [partnership_id, key, (req.body.note || '').trim().slice(0, 500) || null, req.session.userId]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'POST /garmin/findings/ack'); }
});

// POST /api/garmin/findings/unack { key } — put a finding back on the list
router.post('/findings/unack', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    await pool.query('DELETE FROM engine_finding_acks WHERE partnership_id = $1 AND finding_key = $2', [partnership_id, String(req.body.key || '')]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'POST /garmin/findings/unack'); }
});

// GET /api/garmin/:id/series — chart data for one log
router.get('/:id/series', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    const { rows: [r] } = await pool.query(
      'SELECT series FROM garmin_data_logs WHERE id = $1 AND partnership_id = $2', [req.params.id, partnership_id]);
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json(r.series || {});
  } catch (err) { fail(res, err, 'GET /garmin/:id/series'); }
});

// GET /api/garmin/:id/download — the original CSV
router.get('/:id/download', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    const { rows: [r] } = await pool.query(
      'SELECT file_key, filename FROM garmin_data_logs WHERE id = $1 AND partnership_id = $2', [req.params.id, partnership_id]);
    if (!r) return res.status(404).json({ error: 'Not found' });
    const p = path.join(UPLOADS_DIR, r.file_key);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'File not found on disk' });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${(r.filename || 'garmin_log.csv').replace(/"/g, '')}"`);
    fs.createReadStream(p).pipe(zlib.createGunzip()).pipe(res);
  } catch (err) { fail(res, err, 'GET /garmin/:id/download'); }
});

// POST /api/garmin/:id/attach { flight_id }
router.post('/:id/attach', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    const { rows: [f] } = await pool.query('SELECT id FROM flights WHERE id = $1 AND partnership_id = $2', [req.body.flight_id, partnership_id]);
    if (!f) return res.status(404).json({ error: 'Flight not found' });
    const { rowCount } = await pool.query(
      'UPDATE garmin_data_logs SET flight_id = $3 WHERE id = $1 AND partnership_id = $2', [req.params.id, partnership_id, f.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'POST /garmin/:id/attach'); }
});

// POST /api/garmin/:id/detach — back to the unmatched list
router.post('/:id/detach', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    await pool.query(
      'UPDATE garmin_data_logs SET detached_flight_id = flight_id, flight_id = NULL WHERE id = $1 AND partnership_id = $2 AND flight_id IS NOT NULL',
      [req.params.id, partnership_id]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'POST /garmin/:id/detach'); }
});

// DELETE /api/garmin/:id — remove the log (the Drive copy is kept)
router.delete('/:id', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    const { rows: [r] } = await pool.query(
      'DELETE FROM garmin_data_logs WHERE id = $1 AND partnership_id = $2 RETURNING file_key', [req.params.id, partnership_id]);
    if (!r) return res.status(404).json({ error: 'Not found' });
    fs.rm(path.join(UPLOADS_DIR, r.file_key), { force: true }, () => {});
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'DELETE /garmin/:id'); }
});

// POST /api/garmin/match — try to match unmatched logs again
router.post('/match', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    res.json({ matched: await matchUnattached(partnership_id) });
  } catch (err) { fail(res, err, 'POST /garmin/match'); }
});

module.exports = router;
