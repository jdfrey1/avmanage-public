const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const archiver = require('archiver');

const router = express.Router();
router.use(requireAuth);

async function getPartnershipId(userId) {
  const { rows } = await pool.query(
    'SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return rows[0].partnership_id;
}

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
}

async function fetchFlights(partnershipId) {
  const { rows } = await pool.query(`
    SELECT
      f.id, TO_CHAR(f.flight_date, 'YYYY-MM-DD') AS flight_date,
      u.name AS pilot_name,
      f.tach_start, f.tach_end, f.tach_time,
      f.hobbs_start, f.hobbs_end,
      f.fuel_gallons, f.tks_gallons, f.fuel_standard_met,
      f.route, f.notes, f.created_at
    FROM flights f
    JOIN users u ON u.id = f.pilot_id
    WHERE f.partnership_id = $1
    ORDER BY f.flight_date DESC, f.tach_start DESC
  `, [partnershipId]);
  return rows;
}

async function fetchLedger(partnershipId) {
  const { rows } = await pool.query(`
    WITH computed AS (
      SELECT l.id, l.entry_type, l.direction, l.amount, l.lessee_id,
        TO_CHAR(l.effective_date, 'YYYY-MM-DD') AS effective_date,
        l.description, l.related_flight_id, l.created_at,
        u.name AS created_by_name,
        lu.name AS lessee_name,
        SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END)
          OVER (PARTITION BY l.lessee_id ORDER BY l.effective_date ASC, l.created_at ASC)
          AS running_balance
      FROM financial_ledger l
      JOIN users u ON u.id = l.created_by
      LEFT JOIN users lu ON lu.id = l.lessee_id
      WHERE l.partnership_id = $1
    )
    SELECT lessee_name, effective_date, entry_type, direction, amount, running_balance,
           description, related_flight_id, created_by_name, created_at
    FROM computed
    ORDER BY lessee_name, effective_date ASC, created_at ASC
  `, [partnershipId]);
  return rows;
}

async function fetchMaintenance(partnershipId) {
  const { rows } = await pool.query(`
    SELECT
      m.id, TO_CHAR(m.entry_date, 'YYYY-MM-DD') AS entry_date,
      m.category, m.title, m.description,
      m.cost_amount, m.tach_at_service, m.performed_by,
      u.name AS created_by_name, m.created_at
    FROM maintenance_log m
    JOIN users u ON u.id = m.created_by
    WHERE m.partnership_id = $1
    ORDER BY m.entry_date DESC, m.created_at DESC
  `, [partnershipId]);
  return rows;
}

async function fetchSquawks(partnershipId) {
  const { rows } = await pool.query(`
    SELECT
      s.id, s.description, s.severity, s.status,
      s.tach_at_report, s.reported_at,
      u.name AS reported_by_name,
      s.resolution_notes, s.resolved_at
    FROM squawks s
    JOIN users u ON u.id = s.reported_by
    WHERE s.partnership_id = $1
    ORDER BY s.reported_at DESC
  `, [partnershipId]);
  return rows;
}

async function fetchSchedule(partnershipId) {
  const { rows } = await pool.query(`
    SELECT
      s.id, s.block_type, s.title,
      s.start_dt, s.end_dt, s.is_all_day,
      COALESCE(s.pilot_name, u2.name) AS pilot_name,
      s.notes, s.delivery_tach, s.return_tach,
      s.delivery_ack_at, s.return_ack_at,
      u.name AS created_by_name, s.created_at
    FROM schedule_blocks s
    JOIN users u ON u.id = s.created_by
    LEFT JOIN users u2 ON u2.id = s.pilot_id
    WHERE s.partnership_id = $1
    ORDER BY s.start_dt DESC
  `, [partnershipId]);
  return rows;
}

function sendCSV(res, filename, rows) {
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(toCSV(rows));
}

router.get('/flights.csv', async (req, res) => {
  try {
    const pid = await getPartnershipId(req.session.userId);
    sendCSV(res, 'flights.csv', await fetchFlights(pid));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/ledger.csv', async (req, res) => {
  try {
    const pid = await getPartnershipId(req.session.userId);
    sendCSV(res, 'ledger.csv', await fetchLedger(pid));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/maintenance.csv', async (req, res) => {
  try {
    const pid = await getPartnershipId(req.session.userId);
    sendCSV(res, 'maintenance.csv', await fetchMaintenance(pid));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/squawks.csv', async (req, res) => {
  try {
    const pid = await getPartnershipId(req.session.userId);
    sendCSV(res, 'squawks.csv', await fetchSquawks(pid));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/schedule.csv', async (req, res) => {
  try {
    const pid = await getPartnershipId(req.session.userId);
    sendCSV(res, 'schedule.csv', await fetchSchedule(pid));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/all.zip', async (req, res) => {
  try {
    const pid = await getPartnershipId(req.session.userId);
    const [flights, ledger, maintenance, squawks, schedule] = await Promise.all([
      fetchFlights(pid),
      fetchLedger(pid),
      fetchMaintenance(pid),
      fetchSquawks(pid),
      fetchSchedule(pid),
    ]);

    res.setHeader('Content-Disposition', 'attachment; filename="sr22-export.zip"');
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    archive.append(toCSV(flights),     { name: 'flights.csv' });
    archive.append(toCSV(ledger),      { name: 'ledger.csv' });
    archive.append(toCSV(maintenance), { name: 'maintenance.csv' });
    archive.append(toCSV(squawks),     { name: 'squawks.csv' });
    archive.append(toCSV(schedule),    { name: 'schedule.csv' });

    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
