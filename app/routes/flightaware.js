const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const flightaware = require('../services/flightaware');

const router = express.Router();
router.use(requireAuth);

async function getMembership(userId) {
  const { rows: [m] } = await pool.query(
    `SELECT pm.partnership_id, pm.role, u.is_admin FROM partnership_members pm
     JOIN users u ON u.id = pm.user_id WHERE pm.user_id = $1 LIMIT 1`, [userId]);
  if (!m) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return m;
}
const fail = (res, err, tag) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${tag} error:`, err);
  res.status(500).json({ error: 'Internal server error' });
};

// GET /api/flightaware/unmatched — FlightAware flights not attached to a logged flight
router.get('/unmatched', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    const { rows } = await pool.query(
      `SELECT id, tail, origin, destination, off_time, on_time, en_route_min, url, (track IS NOT NULL) AS has_track
       FROM flightaware_flights WHERE partnership_id = $1 AND flight_id IS NULL AND off_time IS NOT NULL
         AND ignored = $2
       ORDER BY off_time DESC LIMIT 20`, [partnership_id, req.query.ignored === '1']);
    res.json(rows);
  } catch (err) { fail(res, err, 'GET /flightaware/unmatched'); }
});

// GET /api/flightaware/:id/track
router.get('/:id/track', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    const { rows: [r] } = await pool.query(
      'SELECT track, track_status FROM flightaware_flights WHERE id = $1 AND partnership_id = $2', [req.params.id, partnership_id]);
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json({ track: r.track || [], status: r.track_status });
  } catch (err) { fail(res, err, 'GET /flightaware/:id/track'); }
});

// POST /api/flightaware/:id/attach { flight_id } — attach by hand (a flight can have several)
router.post('/:id/attach', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    const { rows: [f] } = await pool.query('SELECT id FROM flights WHERE id = $1 AND partnership_id = $2', [req.body.flight_id, partnership_id]);
    if (!f) return res.status(404).json({ error: 'Flight not found' });
    // Adds to any tracks the flight already has (one per leg).
    const { rowCount } = await pool.query('UPDATE flightaware_flights SET flight_id = $3, ignored = false WHERE id = $1 AND partnership_id = $2', [req.params.id, partnership_id, f.id]);
    if (!rowCount) return res.status(404).json({ error: 'FlightAware flight not found' });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'POST /flightaware/:id/attach'); }
});

// POST /api/flightaware/:id/ignore | /unignore — dismiss (or restore) an unmatched flight
for (const [action, value] of [['ignore', true], ['unignore', false]]) {
  router.post(`/:id/${action}`, async (req, res) => {
    try {
      const { partnership_id } = await getMembership(req.session.userId);
      const { rowCount } = await pool.query(
        'UPDATE flightaware_flights SET ignored = $3 WHERE id = $1 AND partnership_id = $2 AND flight_id IS NULL',
        [req.params.id, partnership_id, value]);
      if (!rowCount) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { fail(res, err, `POST /flightaware/:id/${action}`); }
  });
}

// POST /api/flightaware/:id/detach — unhook from its logged flight; it goes back to the unmatched
// list and won't be matched to that flight automatically again.
router.post('/:id/detach', async (req, res) => {
  try {
    const { partnership_id } = await getMembership(req.session.userId);
    await pool.query(
      'UPDATE flightaware_flights SET detached_flight_id = flight_id, flight_id = NULL WHERE id = $1 AND partnership_id = $2 AND flight_id IS NOT NULL',
      [req.params.id, partnership_id]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'POST /flightaware/:id/detach'); }
});

// GET /api/flightaware/status, POST /api/flightaware/api-key — AeroAPI key (never returned)
router.get('/status', async (req, res) => {
  try {
    await getMembership(req.session.userId);
    res.json({ hasApiKey: !!flightaware.getApiKey() });
  } catch (err) { fail(res, err, 'GET /flightaware/status'); }
});

router.post('/api-key', async (req, res) => {
  try {
    const m = await getMembership(req.session.userId);
    if (m.role !== 'owner' && !m.is_admin) return res.status(403).json({ error: 'Owner or administrator only' });
    const key = (req.body.api_key || '').trim();
    flightaware.saveApiKey(key || null);
    res.json({ hasApiKey: !!key });
  } catch (err) { fail(res, err, 'POST /flightaware/api-key'); }
});

// POST /api/flightaware/sync?days=60 — check the mailbox now
router.post('/sync', async (req, res) => {
  try {
    await getMembership(req.session.userId);
    res.json(await flightaware.sync(Math.min(parseInt(req.query.days) || 3, 90)));
  } catch (err) { fail(res, err, 'POST /flightaware/sync'); }
});

module.exports = router;
