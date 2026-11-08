const express = require('express');
const pool = require('../db');
const reports = require('../services/reports');
const requireAuth = require('../middleware/requireAuth');
const googleCalendar = require('../services/googleCalendar');

const router = express.Router();
router.use(requireAuth);

const VALID_TYPES = ['reservation', 'maintenance', 'unavailable'];

function blockToGoogleEvent(block) {
  const summary = [block.title || block.block_type, block.pilot_name].filter(Boolean).join(' — ');
  const description = [block.pilot_name, block.notes].filter(Boolean).join('\n') || undefined;
  if (block.is_all_day) {
    const day = (block.start_dt instanceof Date ? block.start_dt : new Date(block.start_dt)).toISOString().slice(0, 10);
    return { summary, description, start: { date: day }, end: { date: day } };
  }
  return {
    summary,
    description,
    start: { dateTime: new Date(block.start_dt).toISOString() },
    end: { dateTime: new Date(block.end_dt).toISOString() },
  };
}

// Pushes a schedule block's current state to the shared Google Calendar (create on first
// sync, update thereafter). Never throws — a Google outage shouldn't break scheduling.
async function syncBlockToGoogle(blockId) {
  try {
    if (!(await googleCalendar.isConnected())) return;
    const { rows: [block] } = await pool.query(
      `SELECT id, title, notes, block_type, start_dt, end_dt, is_all_day,
              COALESCE(pilot_name, (SELECT name FROM users WHERE id = schedule_blocks.pilot_id)) AS pilot_name,
              google_event_id
       FROM schedule_blocks WHERE id = $1`,
      [blockId]
    );
    if (!block) return;
    const event = blockToGoogleEvent(block);
    if (block.google_event_id) {
      await googleCalendar.updateEvent(block.google_event_id, event);
    } else {
      const googleEventId = await googleCalendar.createEvent(event);
      await pool.query('UPDATE schedule_blocks SET google_event_id = $1 WHERE id = $2', [googleEventId, blockId]);
    }
  } catch (err) {
    console.error(`Google Calendar sync failed for schedule block ${blockId}:`, err.message);
  }
}

async function getPartnershipId(userId) {
  const { rows } = await pool.query(
    'SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return rows[0].partnership_id;
}

// Reservations carry the flights logged on their local day(s), counted per member charged, and whether
// those days are over (so the page can flag reservations nobody logged a flight for).
const TZ = (process.env.APP_TIMEZONE || 'America/New_York').replace(/[^A-Za-z0-9_/+-]/g, '');
const LOCAL_START = `(s.start_dt AT TIME ZONE '${TZ}')::date`;
const LOCAL_END = `((s.end_dt - interval '1 second') AT TIME ZONE '${TZ}')::date`;
const SELECT_BLOCK = `
  SELECT
    s.id, s.block_type, s.start_dt, s.end_dt, s.title, s.notes,
    s.is_all_day, s.pilot_id, s.pilot_name,
    s.delivery_ack_at, s.return_ack_at, s.delivery_tach, s.return_tach,
    s.created_at, s.created_by,
    u.name AS created_by_name,
    ${LOCAL_END} < (NOW() AT TIME ZONE '${TZ}')::date AS day_over,
    CASE WHEN s.block_type = 'reservation' THEN COALESCE((
      SELECT json_agg(json_build_object('pilot', p.pilot, 'count', p.n) ORDER BY p.n DESC, p.pilot)
      FROM (
        SELECT fu.name AS pilot, COUNT(*)::int AS n
        FROM flights f JOIN users fu ON fu.id = f.pilot_id
        WHERE f.partnership_id = s.partnership_id
          AND f.flight_date BETWEEN ${LOCAL_START} AND ${LOCAL_END}
        GROUP BY 1
      ) p
    ), '[]'::json) END AS flights_logged
  FROM schedule_blocks s
  JOIN users u ON u.id = s.created_by
`;

// Check for overlapping reservations, optionally excluding one block (for PATCH)
async function checkConflict(partnershipId, startDt, endDt, excludeId = null) {
  const params = [partnershipId, endDt, startDt];
  const excludeClause = excludeId ? `AND s.id != $4` : '';
  if (excludeId) params.push(excludeId);
  const { rows } = await pool.query(`
    SELECT s.id, s.title, s.start_dt, s.end_dt
    FROM schedule_blocks s
    WHERE s.partnership_id = $1
      AND s.start_dt < $2 AND s.end_dt > $3
      ${excludeClause}
    LIMIT 1
  `, params);
  return rows[0] || null;
}

// GET /api/schedule/members
router.get('/members', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows } = await pool.query(
      `SELECT u.id, u.id AS user_id, u.name, pm.role FROM users u
       JOIN partnership_members pm ON pm.user_id = u.id
       WHERE pm.partnership_id = $1 ORDER BY u.name`,
      [partnershipId]
    );
    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /schedule/members error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/schedule
router.get('/', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { start, end, type } = req.query;

    const conditions = ['s.partnership_id = $1'];
    const params = [partnershipId];

    if (start) {
      params.push(start);
      conditions.push(`s.end_dt > $${params.length}`);
    }
    if (end) {
      params.push(end);
      conditions.push(`s.start_dt < $${params.length}`);
    }
    if (type) {
      if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
      }
      params.push(type);
      conditions.push(`s.block_type = $${params.length}`);
    }

    const { rows } = await pool.query(
      `${SELECT_BLOCK} WHERE ${conditions.join(' AND ')} ORDER BY s.start_dt ASC LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /schedule error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/schedule
router.post('/', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { start_dt, end_dt, title, block_type = 'reservation', notes,
            is_all_day = false, pilot_id, pilot_name } = req.body;

    if (!start_dt || !end_dt || !title) {
      return res.status(400).json({ error: 'start_dt, end_dt, and title are required' });
    }
    if (new Date(end_dt) <= new Date(start_dt)) {
      return res.status(400).json({ error: 'end_dt must be after start_dt' });
    }
    if (!VALID_TYPES.includes(block_type)) {
      return res.status(400).json({ error: `block_type must be one of: ${VALID_TYPES.join(', ')}` });
    }

    // A major open squawk grounds the aircraft: no new reservations until it's resolved.
    // (Maintenance and unavailable blocks are still allowed.)
    if (block_type === 'reservation') {
      const status = await reports.getAircraftStatus(partnershipId);
      if (status.grounded) {
        return res.status(423).json({
          error: `Aircraft is grounded — open major squawk: "${status.major_squawks[0].description.slice(0, 80)}". Resolve it before booking.`,
        });
      }
    }

    const force = req.body.force === true;
    const conflict = force ? null : await checkConflict(partnershipId, start_dt, end_dt);
    if (conflict) {
      return res.status(409).json({
        error: 'Time slot overlaps an existing block',
        conflict: { id: conflict.id, title: conflict.title, start_dt: conflict.start_dt, end_dt: conflict.end_dt },
      });
    }

    const { rows: [block] } = await pool.query(`
      INSERT INTO schedule_blocks
        (partnership_id, created_by, block_type, start_dt, end_dt, title, notes,
         is_all_day, pilot_id, pilot_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
    `, [partnershipId, req.session.userId, block_type, start_dt, end_dt, title, notes || null,
        is_all_day, pilot_id || null, pilot_name || null]);

    await syncBlockToGoogle(block.id);

    const { rows: [created] } = await pool.query(
      `${SELECT_BLOCK} WHERE s.id = $1`, [block.id]
    );
    res.status(201).json(created);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /schedule error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/schedule/:id
router.get('/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [block] } = await pool.query(
      `${SELECT_BLOCK} WHERE s.id = $1 AND s.partnership_id = $2`,
      [req.params.id, partnershipId]
    );
    if (!block) return res.status(404).json({ error: 'Block not found' });
    res.json(block);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /schedule/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/schedule/:id
router.patch('/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);

    const { rows: [existing] } = await pool.query(
      'SELECT id, block_type, start_dt, end_dt FROM schedule_blocks WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!existing) return res.status(404).json({ error: 'Block not found' });

    const allowed = ['start_dt', 'end_dt', 'title', 'notes', 'block_type',
                     'is_all_day', 'pilot_id', 'pilot_name'];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const newType = req.body.block_type ?? existing.block_type;
    if (!VALID_TYPES.includes(newType)) {
      return res.status(400).json({ error: `block_type must be one of: ${VALID_TYPES.join(', ')}` });
    }

    const newStart = req.body.start_dt ?? existing.start_dt;
    const newEnd   = req.body.end_dt   ?? existing.end_dt;
    if (new Date(newEnd) <= new Date(newStart)) {
      return res.status(400).json({ error: 'end_dt must be after start_dt' });
    }

    const force = req.body.force === true;
    const conflict = force ? null : await checkConflict(partnershipId, newStart, newEnd, req.params.id);
    if (conflict) {
      return res.status(409).json({
        error: 'Time slot overlaps an existing block',
        conflict: { id: conflict.id, title: conflict.title, start_dt: conflict.start_dt, end_dt: conflict.end_dt },
      });
    }

    const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    await pool.query(
      `UPDATE schedule_blocks SET ${setClauses} WHERE id = $1`,
      [req.params.id, ...updates.map(([, v]) => v)]
    );

    await syncBlockToGoogle(req.params.id);

    const { rows: [updated] } = await pool.query(
      `${SELECT_BLOCK} WHERE s.id = $1`, [req.params.id]
    );
    res.json(updated);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /schedule/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/schedule/:id
router.delete('/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [deleted] } = await pool.query(
      'DELETE FROM schedule_blocks WHERE id = $1 AND partnership_id = $2 RETURNING google_event_id',
      [req.params.id, partnershipId]
    );
    if (!deleted) return res.status(404).json({ error: 'Block not found' });
    if (deleted.google_event_id) {
      try { await googleCalendar.deleteEvent(deleted.google_event_id); }
      catch (err) { console.error(`Google Calendar delete failed for schedule block ${req.params.id}:`, err.message); }
    }
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /schedule/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/schedule/:id/checkin
router.post('/:id/checkin', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { tach } = req.body;

    const { rowCount } = await pool.query(
      `UPDATE schedule_blocks
       SET delivery_ack_at = NOW(), delivery_tach = $3
       WHERE id = $1 AND partnership_id = $2`,
      [req.params.id, partnershipId, tach || null]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Block not found' });

    const { rows: [block] } = await pool.query(
      `${SELECT_BLOCK} WHERE s.id = $1`, [req.params.id]
    );
    res.json(block);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /schedule/:id/checkin error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/schedule/:id/checkout
router.post('/:id/checkout', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { tach } = req.body;

    const { rowCount } = await pool.query(
      `UPDATE schedule_blocks
       SET return_ack_at = NOW(), return_tach = $3
       WHERE id = $1 AND partnership_id = $2`,
      [req.params.id, partnershipId, tach || null]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Block not found' });

    const { rows: [block] } = await pool.query(
      `${SELECT_BLOCK} WHERE s.id = $1`, [req.params.id]
    );
    res.json(block);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /schedule/:id/checkout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
