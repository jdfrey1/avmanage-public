const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const googleCalendar = require('../services/googleCalendar');
const googleDrive = require('../services/googleDrive');
const googleAuth = require('../services/googleAuth');
const reports = require('../services/reports');
const leaseBilling = require('../services/leaseBilling');

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage() });
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

async function getPartnershipId(userId) {
  const { rows } = await pool.query(
    'SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return rows[0].partnership_id;
}

// Pushes a logged flight to the shared Google Calendar as an all-day event (create on first
// sync, update thereafter). Never throws — a Google outage shouldn't break flight logging.
async function syncFlightToGoogle(flightId) {
  try {
    if (!(await googleCalendar.isConnected())) return;
    const { rows: [f] } = await pool.query(
      `SELECT f.id, TO_CHAR(f.flight_date, 'YYYY-MM-DD') AS flight_date, f.route, f.flight_time,
              f.notes, f.google_event_id, u.name AS pilot_name
       FROM flights f JOIN users u ON u.id = f.pilot_id
       WHERE f.id = $1`,
      [flightId]
    );
    if (!f) return;
    const summary = [f.pilot_name, f.route ? `Flight ${f.route}` : 'Flight'].filter(Boolean).join(' — ');
    const description = [f.pilot_name, f.route, f.flight_time ? `${parseFloat(f.flight_time).toFixed(1)} flight hrs` : null, f.notes]
      .filter(Boolean).join('\n') || undefined;
    const event = { summary, description, start: { date: f.flight_date }, end: { date: f.flight_date } };

    if (f.google_event_id) {
      await googleCalendar.updateEvent(f.google_event_id, event);
    } else {
      const googleEventId = await googleCalendar.createEvent(event);
      await pool.query('UPDATE flights SET google_event_id = $1 WHERE id = $2', [googleEventId, flightId]);
    }
  } catch (err) {
    console.error(`Google Calendar sync failed for flight ${flightId}:`, err.message);
  }
}

// The exclusion checkbox only applies to lessees — the owner has no hour allotment.
async function resolveExclusion(pilotId, partnershipId, requested) {
  if (!requested) return false;
  const { rows: [m] } = await pool.query(
    'SELECT role FROM partnership_members WHERE user_id = $1 AND partnership_id = $2', [pilotId, partnershipId]);
  return m?.role !== 'owner';
}

router.get('/annual-summary', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    let userId = req.session.userId;
    if (req.query.user_id && req.query.user_id !== userId) {
      const { rows: [m] } = await pool.query(
        'SELECT 1 FROM partnership_members WHERE user_id = $1 AND partnership_id = $2', [req.query.user_id, partnershipId]);
      if (!m) return res.status(404).json({ error: 'Member not found' });
      userId = req.query.user_id;
    }
    const summary = await reports.getHoursSummary(userId, partnershipId);
    res.json(summary);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /flights/annual-summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { pilot_id, limit = 50, offset = 0, sort_by = 'date', order = 'desc' } = req.query;

    const conditions = ['f.partnership_id = $1'];
    const params = [partnershipId];

    if (pilot_id) {
      params.push(pilot_id);
      conditions.push(`f.pilot_id = $${params.length}`);
    }

    const sortMap = { date: 'f.flight_date', pilot: 'u.name', route: 'f.route', notes: 'f.notes' };
    const sortCol = sortMap[sort_by] || 'f.flight_date';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';

    const { rows } = await pool.query(`
      SELECT
        f.id, TO_CHAR(f.flight_date, 'YYYY-MM-DD') AS flight_date,
        f.tach_start, f.tach_end, f.tach_time,
        f.hobbs_start, f.hobbs_end, f.flight_time, f.exclude_from_allotment, f.fuel_gallons, f.tks_gallons, f.oil_added_quarts, f.fuel_added_gallons,
        f.fuel_standard_met, f.notes, f.route, f.created_at,
        f.pilot_id, u.name AS pilot_name, f.ocr_source_image_key,
        ff.id AS fa_id, ff.off_time AS fa_off_time, ff.on_time AS fa_on_time, ff.en_route_min AS fa_en_route_min,
        ff.origin AS fa_origin, ff.destination AS fa_destination, ff.url AS fa_url, (ff.track IS NOT NULL) AS fa_has_track
      FROM flights f
      JOIN users u ON u.id = f.pilot_id
      LEFT JOIN flightaware_flights ff ON ff.flight_id = f.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${sortCol} ${sortDir} NULLS LAST, f.tach_start DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, Math.min(parseInt(limit) || 50, 200), parseInt(offset) || 0]);

    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /flights error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/flights/ocr-photo — read Hobbs/Flight meter from a gauge photo via Claude Vision, store the photo
router.post('/ocr-photo', upload.single('photo'), async (req, res) => {
  try {
    if (!anthropic) return res.status(503).json({ error: 'OCR is not configured' });
    if (!req.file) return res.status(400).json({ error: 'photo is required' });
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'File must be an image' });
    }

    const base64 = req.file.buffer.toString('base64');
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: base64 } },
          {
            type: 'text',
            text: 'This is a photo of a Cirrus SR22 instrument panel showing the Hobbs meter (HOBBS) ' +
                  'and flight timer (FLIGHT) readings. Read both values precisely, including one decimal ' +
                  'place if shown. Respond with ONLY a JSON object, no other text: ' +
                  '{"hobbs": <number or null>, "flight": <number or null>}',
          },
        ],
      }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    let hobbs = null, flight = null;
    try {
      const parsed = JSON.parse(textBlock?.text?.trim() ?? '{}');
      hobbs  = typeof parsed.hobbs  === 'number' ? parsed.hobbs  : null;
      flight = typeof parsed.flight === 'number' ? parsed.flight : null;
    } catch {
      // model didn't return clean JSON — leave both null, frontend shows a "couldn't read" state
    }

    const ext = (req.file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const imageKey = `${crypto.randomUUID()}.${ext}`;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, imageKey), req.file.buffer);

    res.json({ hobbs, flight, image_key: imageKey });

    // Archive a copy to the shared Google Drive, if connected. Fire-and-forget: the Claude
    // Vision call above already made this request slow, so don't stack an awaited Drive
    // upload on top of it — the response has already gone out. The flight record this photo
    // belongs to (matched by ocr_source_image_key) may not exist yet, since the user still
    // has to review/submit the form — best-effort link, not guaranteed.
    googleAuth.isConnected().then(async (connected) => {
      if (!connected) return;
      const driveFileId = await googleDrive.uploadFile('flightPhotos', {
        name: imageKey, mimeType: req.file.mimetype, buffer: req.file.buffer,
      });
      await pool.query(
        'UPDATE flights SET drive_file_id = $1 WHERE ocr_source_image_key = $2 AND drive_file_id IS NULL',
        [driveFileId, imageKey]
      );
    }).catch((err) => console.error(`Drive sync failed for gauge photo ${imageKey}:`, err.message));
  } catch (err) {
    console.error('POST /flights/ocr-photo error:', err);
    res.status(500).json({ error: 'Failed to process photo' });
  }
});

router.post('/', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const {
      flight_date, tach_start, tach_end,
      hobbs_start, hobbs_end,
      fuel_gallons, tks_gallons, fuel_standard_met,
      oil_added_quarts, fuel_added_gallons,
      notes, route,
      pilot_id, ocr_source_image_key, exclude_from_allotment,
    } = req.body;

    if (!flight_date || tach_start == null || tach_end == null) {
      return res.status(400).json({ error: 'flight_date, tach_start, and tach_end are required' });
    }
    if (parseFloat(tach_end) < parseFloat(tach_start)) {
      return res.status(400).json({ error: 'tach_end must be >= tach_start' });
    }

    const effectivePilotId = pilot_id || req.session.userId;
    const exclude = await resolveExclusion(effectivePilotId, partnershipId, exclude_from_allotment);

    const { rows: [flight] } = await pool.query(`
      INSERT INTO flights (
        partnership_id, pilot_id, flight_date,
        tach_start, tach_end,
        hobbs_start, hobbs_end,
        fuel_gallons, tks_gallons, fuel_standard_met,
        notes, route, ocr_source_image_key, exclude_from_allotment,
        oil_added_quarts, fuel_added_gallons
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING
        id, TO_CHAR(flight_date, 'YYYY-MM-DD') AS flight_date,
        tach_start, tach_end, tach_time,
        hobbs_start, hobbs_end, flight_time, exclude_from_allotment, fuel_gallons, tks_gallons, oil_added_quarts, fuel_added_gallons,
        fuel_standard_met, notes, route, pilot_id, created_at, ocr_source_image_key
    `, [
      partnershipId, effectivePilotId, flight_date,
      tach_start, tach_end,
      hobbs_start || null, hobbs_end || null,
      fuel_gallons || null, tks_gallons || 0, fuel_standard_met ?? null,
      notes || null, route || null, ocr_source_image_key || null, exclude,
      oil_added_quarts || null, fuel_added_gallons || null,
    ]);

    await syncFlightToGoogle(flight.id);
    leaseBilling.syncExcessHoursSoon(partnershipId);
    require('../services/flightaware').matchFlights().catch(() => {});

    res.status(201).json(flight);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /flights error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/flights/:id/photo — stream the stored gauge photo for a flight
router.get('/:id/photo', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [flight] } = await pool.query(
      'SELECT ocr_source_image_key FROM flights WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!flight || !flight.ocr_source_image_key) {
      return res.status(404).json({ error: 'No photo for this flight' });
    }

    const filepath = path.join(UPLOADS_DIR, flight.ocr_source_image_key);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Photo file missing' });
    res.sendFile(filepath);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /flights/:id/photo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);

    const { rows: [flight] } = await pool.query(`
      SELECT
        f.id, TO_CHAR(f.flight_date, 'YYYY-MM-DD') AS flight_date,
        f.tach_start, f.tach_end, f.tach_time,
        f.hobbs_start, f.hobbs_end, f.flight_time, f.exclude_from_allotment, f.fuel_gallons, f.tks_gallons, f.oil_added_quarts, f.fuel_added_gallons,
        f.fuel_standard_met, f.notes, f.route, f.created_at,
        f.pilot_id, u.name AS pilot_name, f.ocr_source_image_key
      FROM flights f
      JOIN users u ON u.id = f.pilot_id
      WHERE f.id = $1 AND f.partnership_id = $2
    `, [req.params.id, partnershipId]);

    if (!flight) return res.status(404).json({ error: 'Flight not found' });
    res.json(flight);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /flights/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);

    const { rows: [existing] } = await pool.query(
      'SELECT id, pilot_id FROM flights WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!existing) return res.status(404).json({ error: 'Flight not found' });

    if ('exclude_from_allotment' in req.body) {
      req.body.exclude_from_allotment = await resolveExclusion(
        req.body.pilot_id || existing.pilot_id, partnershipId, req.body.exclude_from_allotment);
    }

    const allowed = [
      'flight_date', 'tach_start', 'tach_end',
      'hobbs_start', 'hobbs_end',
      'fuel_gallons', 'tks_gallons', 'fuel_standard_met',
      'notes', 'route', 'pilot_id', 'ocr_source_image_key', 'exclude_from_allotment',
      'oil_added_quarts', 'fuel_added_gallons',
    ];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    if ('tach_start' in req.body || 'tach_end' in req.body) {
      const newStart = req.body.tach_start ?? existing.tach_start;
      const newEnd   = req.body.tach_end   ?? existing.tach_end;
      if (parseFloat(newEnd) < parseFloat(newStart)) {
        return res.status(400).json({ error: 'tach_end must be >= tach_start' });
      }
    }

    const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const values = updates.map(([, v]) => v);

    const { rows: [flight] } = await pool.query(`
      UPDATE flights SET ${setClauses}
      WHERE id = $1
      RETURNING
        id, TO_CHAR(flight_date, 'YYYY-MM-DD') AS flight_date,
        tach_start, tach_end, tach_time,
        hobbs_start, hobbs_end, flight_time, exclude_from_allotment, fuel_gallons, tks_gallons, oil_added_quarts, fuel_added_gallons,
        fuel_standard_met, notes, route, pilot_id, created_at, ocr_source_image_key
    `, [req.params.id, ...values]);

    await syncFlightToGoogle(req.params.id);
    leaseBilling.syncExcessHoursSoon(partnershipId);

    res.json(flight);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /flights/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);

    const { rows: [deleted] } = await pool.query(
      'DELETE FROM flights WHERE id = $1 AND partnership_id = $2 RETURNING google_event_id',
      [req.params.id, partnershipId]
    );
    if (!deleted) return res.status(404).json({ error: 'Flight not found' });
    if (deleted.google_event_id) {
      try { await googleCalendar.deleteEvent(deleted.google_event_id); }
      catch (err) { console.error(`Google Calendar delete failed for flight ${req.params.id}:`, err.message); }
    }
    leaseBilling.syncExcessHoursSoon(partnershipId);
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /flights/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
