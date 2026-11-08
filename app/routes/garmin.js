const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const googleAuth = require('../services/googleAuth');
const googleDrive = require('../services/googleDrive');
const { parseGarminLog } = require('../services/garminLog');
const { findFlight, matchUnattached } = require('../services/garminMatch');
const engineAnalysis = require('../services/engineAnalysis');

// Garmin avionics data logs ("Original CSV" downloads from flyGarmin), one per engine run.
// Uploaded logs are matched to the logged flight on the same local date (narrowed by
// FlightAware times and route when there are several), or left unmatched for manual attach.

const router = express.Router();
router.use(requireAuth);

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
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

// Summary columns returned everywhere (never the bulky series).
const SUMMARY = `id, flight_id, filename, started_at, ended_at, engine_on_at, engine_off_at, takeoff_at, landing_at,
  engine_hrs::float, air_hrs::float, fuel_used_gal::float, fuel_start_gal::float, fuel_end_gal::float,
  origin, destination, max_cht::float, max_cht_cyl, stats`;

async function archiveToDrive(id, name, buffer) {
  if (!(await googleAuth.isConnected())) return;
  try {
    await googleDrive.ensureFolderStructure(); // adds the Garmin folder on installs connected before it existed
    const fileId = await googleDrive.uploadFile('garminLogs', { name, mimeType: 'text/csv', buffer });
    await pool.query('UPDATE garmin_data_logs SET drive_file_id = $2 WHERE id = $1', [id, fileId]);
  } catch (err) {
    console.error(`Drive sync failed for Garmin log ${name}:`, err.message);
  }
}

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
        const log = parseGarminLog(file.buffer.toString('utf8'), name);
        const { rows: [dup] } = await pool.query(
          `SELECT ${SUMMARY} FROM garmin_data_logs WHERE partnership_id = $1 AND started_at = $2`, [partnership_id, log.started_at]);
        if (dup) { results.push({ filename: name, status: 'duplicate', log: dup }); continue; }

        const flightId = forFlight || (req.body.hold === '1' ? null : await findFlight(partnership_id, log));
        const fileKey = `garmin/${log.started_at.toISOString().replace(/[:.]/g, '-')}_${(log.origin || 'log').replace(/\W/g, '')}.csv.gz`;
        fs.mkdirSync(path.join(UPLOADS_DIR, 'garmin'), { recursive: true });
        fs.writeFileSync(path.join(UPLOADS_DIR, fileKey), zlib.gzipSync(file.buffer));
        const { rows: [row] } = await pool.query(
          `INSERT INTO garmin_data_logs
             (partnership_id, flight_id, filename, file_key, started_at, ended_at, engine_on_at, engine_off_at,
              takeoff_at, landing_at, engine_hrs, air_hrs, fuel_used_gal, fuel_start_gal, fuel_end_gal,
              origin, destination, max_cht, max_cht_cyl, stats, series, meta, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           RETURNING ${SUMMARY}`,
          [partnership_id, flightId, name, fileKey, log.started_at, log.ended_at, log.engine_on_at, log.engine_off_at,
           log.takeoff_at, log.landing_at, log.engine_hrs, log.air_hrs, log.fuel_used_gal, log.fuel_start_gal, log.fuel_end_gal,
           log.origin, log.destination, log.max_cht, log.max_cht_cyl, log.stats, log.series, log.meta, req.session.userId]);
        results.push({ filename: name, status: flightId ? 'attached' : 'unmatched', log: row });
        archiveToDrive(row.id, name, file.buffer); // not awaited: Drive is slow and best-effort
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
async function loadAnalysis(partnershipId, limit) {
  const { rows } = await pool.query(
    `SELECT g.id, g.flight_id, g.filename, g.started_at, g.engine_on_at, g.engine_off_at, g.takeoff_at, g.landing_at,
            g.engine_hrs::float, g.air_hrs::float, g.fuel_used_gal::float, g.origin, g.destination,
            g.max_cht::float, g.max_cht_cyl, g.stats, TO_CHAR(f.flight_date, 'YYYY-MM-DD') AS flight_date,
            COALESCE(f.pilot_name, u.name) AS pilot_name
     FROM garmin_data_logs g
     LEFT JOIN flights f ON f.id = g.flight_id
     LEFT JOIN users u ON u.id = f.pilot_id
     WHERE g.partnership_id = $1
     ORDER BY g.started_at DESC LIMIT $2`,
    [partnershipId, limit]);
  const runs = rows.reverse();
  const { rows: ackRows } = await pool.query(
    `SELECT a.finding_key, a.note, a.acked_at, u.name AS acked_by_name
     FROM engine_finding_acks a LEFT JOIN users u ON u.id = a.acked_by WHERE a.partnership_id = $1`, [partnershipId]);
  const acks = Object.fromEntries(ackRows.map(r => [r.finding_key, { note: r.note, acked_at: r.acked_at, acked_by_name: r.acked_by_name }]));
  return { runs, ...engineAnalysis.analyze(runs, acks) };
}

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
