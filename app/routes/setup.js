const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');

// First-run setup: while the database has no users, anyone who can reach the app can create
// the aircraft record and the first (administrator) account. Once a user exists these
// endpoints refuse, so put the app behind HTTPS and finish setup right after installing.
const router = express.Router();

// Date-based items most US-registered aircraft track; dates are filled in later from the logbooks.
const DEFAULT_INSPECTIONS = [
  ['Annual inspection', 'Due by the end of the 12th calendar month after the last annual.', 12],
  ['ELT inspection (91.207)', 'Due by the end of the 12th calendar month.', 12],
  ['Altimeter / static / transponder (91.411, 91.413)', 'Required for IFR; due by the end of the 24th calendar month.', 24],
  ['ELT battery replacement', 'Use the expiration date marked on the battery.', null],
  ['Aircraft registration', 'Registrations expire every 7 years.', 84],
];

async function needsSetup() {
  const { rows: [r] } = await pool.query('SELECT NOT EXISTS (SELECT 1 FROM users) AS needs');
  return r.needs;
}

// GET /api/setup/status — public
router.get('/status', async (req, res) => {
  try {
    res.json({ needs_setup: await needsSetup() });
  } catch (err) {
    console.error('GET /setup/status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/setup — aircraft + first administrator; signs them in
router.post('/', async (req, res) => {
  const b = req.body || {};
  const tail = (b.aircraft_tail || '').trim().toUpperCase();
  const email = (b.email || '').trim().toLowerCase();
  const name = (b.name || '').trim();
  const role = b.role === 'owner' ? 'owner' : 'lessee';
  if (!tail) return res.status(400).json({ error: 'Tail number is required' });
  if (!name || !email) return res.status(400).json({ error: 'Your name and email are required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!b.password || b.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent attempts so only one can create the first account.
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const { rows: [{ count }] } = await client.query('SELECT COUNT(*)::int AS count FROM users');
    if (count > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Setup has already been completed' });
    }
    const { rows: [p] } = await client.query(
      `INSERT INTO partnerships (name, aircraft_tail, aircraft_make_model, aircraft_serial)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [(b.partnership_name || '').trim() || `${tail} partnership`, tail, (b.aircraft_make_model || '').trim() || null,
       (b.aircraft_serial || '').trim() || null]);
    const { rows: [u] } = await client.query(
      `INSERT INTO users (email, name, password_hash, is_admin) VALUES ($1, $2, $3, true) RETURNING id`,
      [email, name, await bcrypt.hash(b.password, 12)]);
    await client.query(
      'INSERT INTO partnership_members (partnership_id, user_id, role) VALUES ($1, $2, $3)', [p.id, u.id, role]);
    for (const [title, notes, months] of DEFAULT_INSPECTIONS) {
      await client.query(
        'INSERT INTO inspection_items (partnership_id, title, notes, interval_months) VALUES ($1, $2, $3, $4)',
        [p.id, title, notes, months]);
    }
    await client.query('COMMIT');

    req.session.userId = u.id;
    res.status(201).json({ id: u.id, email, name, role, is_admin: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /setup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
