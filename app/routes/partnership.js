const path = require('path');
const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const reports = require('../services/reports');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const googleAuth = require('../services/googleAuth');
const googleMail = require('../services/googleMail');
const { createPasswordLink } = require('../services/passwordLinks');
const multer = require('multer');
const branding = require('../services/branding');

const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

const router = express.Router();

// GET /api/partnership/public — tail number only, no auth required. Used to brand the login
// screen and browser tab before any session exists. Not sensitive: it's already painted on
// the aircraft and part of the public FAA registration.
router.get('/public', async (req, res) => {
  try {
    const { rows: [p] } = await pool.query('SELECT aircraft_tail FROM partnerships LIMIT 1');
    res.json({ aircraft_tail: p?.aircraft_tail ?? null });
  } catch (err) {
    console.error('GET /partnership/public error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.use(requireAuth);

async function getMembership(userId) {
  const { rows } = await pool.query(
    'SELECT pm.partnership_id, pm.role FROM partnership_members pm WHERE pm.user_id = $1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return { partnershipId: rows[0].partnership_id, role: rows[0].role };
}

// GET /api/partnership — returns aircraft info + all members
router.get('/', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);

    const [{ rows: [p] }, { rows: members }] = await Promise.all([
      pool.query(
        `SELECT id, name, aircraft_tail, aircraft_make_model, aircraft_serial,
                TO_CHAR(insurance_expires_date, 'YYYY-MM-DD') AS insurance_expires_date,
                baseline_hobbs::float, baseline_flight::float, baseline_image_key,
                TO_CHAR(baseline_date, 'YYYY-MM-DD') AS baseline_date FROM partnerships WHERE id = $1`,
        [partnershipId]
      ),
      pool.query(
        `SELECT pm.id, u.id as user_id, u.name, pm.role, pm.annual_hour_allotment, pm.hour_allotment_period
         FROM partnership_members pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.partnership_id = $1
         ORDER BY pm.role DESC, u.name`,
        [partnershipId]
      ),
    ]);

    if (!p) return res.status(404).json({ error: 'Partnership not found' });
    res.json({ ...p, members });
  } catch (err) {
    console.error('GET /partnership error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/partnership/baseline-photo — the photo of the meters the baseline was read from
router.get('/baseline-photo', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);
    const { rows: [p] } = await pool.query('SELECT baseline_image_key FROM partnerships WHERE id = $1', [partnershipId]);
    if (!p?.baseline_image_key) return res.status(404).json({ error: 'No baseline photo' });
    res.sendFile(path.join(UPLOADS_DIR, path.basename(p.baseline_image_key)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PATCH /api/partnership — any member can update aircraft fields
router.patch('/', async (req, res) => {
  try {
    const { partnershipId } = await getMembership(req.session.userId);

    const { aircraft_tail, aircraft_make_model, aircraft_serial, insurance_expires_date } = req.body;
    const num = (v) => (v === null || v === '' || v === undefined ? null : Number(v));
    for (const k of ['baseline_hobbs', 'baseline_flight']) {
      if (k in req.body && num(req.body[k]) !== null && !isFinite(num(req.body[k]))) return res.status(400).json({ error: `${k} must be a number` });
    }
    if (insurance_expires_date && !/^\d{4}-\d{2}-\d{2}$/.test(insurance_expires_date)) {
      return res.status(400).json({ error: 'insurance_expires_date must be YYYY-MM-DD' });
    }
    const { rows: [p] } = await pool.query(
      `UPDATE partnerships
       SET aircraft_tail       = COALESCE($1, aircraft_tail),
           aircraft_make_model = COALESCE($2, aircraft_make_model),
           aircraft_serial     = COALESCE($3, aircraft_serial),
           insurance_expires_date = CASE WHEN $5::boolean THEN $6::date ELSE insurance_expires_date END,
           baseline_hobbs  = CASE WHEN $7::boolean THEN $8::numeric ELSE baseline_hobbs END,
           baseline_flight = CASE WHEN $9::boolean THEN $10::numeric ELSE baseline_flight END
       WHERE id = $4
       RETURNING id, name, aircraft_tail, aircraft_make_model, aircraft_serial,
                 TO_CHAR(insurance_expires_date, 'YYYY-MM-DD') AS insurance_expires_date,
                 baseline_hobbs::float, baseline_flight::float, baseline_image_key,
                 TO_CHAR(baseline_date, 'YYYY-MM-DD') AS baseline_date`,
      [aircraft_tail ?? null, aircraft_make_model ?? null, aircraft_serial ?? null, partnershipId,
       'insurance_expires_date' in req.body, insurance_expires_date || null,
       'baseline_hobbs' in req.body, num(req.body.baseline_hobbs),
       'baseline_flight' in req.body, num(req.body.baseline_flight)]
    );
    res.json(p);
  } catch (err) {
    console.error('PATCH /partnership error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Managers = the aircraft owner, or the app administrator.
async function requireManager(req, res, next) {
  try {
    const { partnershipId, role } = await getMembership(req.session.userId);
    const { rows: [u] } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]);
    if (role !== 'owner' && !u?.is_admin) return res.status(403).json({ error: 'Owner or administrator only' });
    req.partnershipId = partnershipId;
    req.isAdmin = !!u?.is_admin;
    next();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

// GET /api/partnership/members/usage — manager only: allotments + YTD / monthly Flight-hour usage
router.get('/members/usage', requireManager, async (req, res) => {
  try {
    res.json(await reports.getMemberUsage(req.partnershipId));
  } catch (err) {
    console.error('GET /partnership/members/usage error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/partnership/members/:memberId — manager only: allotment, period, and lease terms.
// Only fields present in the body are changed.
router.patch('/members/:memberId', requireManager, async (req, res) => {
  try {
    const b = req.body;
    const sets = [];
    const params = [];
    const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    const num = (v) => (v === null || v === '' ? null : Number(v));

    if ('annual_hour_allotment' in b) add('annual_hour_allotment', b.annual_hour_allotment == null || b.annual_hour_allotment === '' ? null : parseInt(b.annual_hour_allotment));
    if (['annual', 'monthly'].includes(b.hour_allotment_period)) add('hour_allotment_period', b.hour_allotment_period);
    if ('lease_monthly_rate' in b) add('lease_monthly_rate', num(b.lease_monthly_rate));
    if ('overage_rate_per_hr' in b) add('overage_rate_per_hr', num(b.overage_rate_per_hr));
    if ('lease_start_date' in b) {
      if (b.lease_start_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.lease_start_date)) return res.status(400).json({ error: 'lease_start_date must be YYYY-MM-DD' });
      add('lease_start_date', b.lease_start_date || null);
    }
    const { rows: [target] } = await pool.query(
      'SELECT pm.id, pm.user_id, pm.role FROM partnership_members pm WHERE pm.id = $1 AND pm.partnership_id = $2',
      [req.params.memberId, req.partnershipId]);
    if (!target) return res.status(404).json({ error: 'Member not found' });

    // Role: at most one owner (the aircraft's owner/lessor). Making someone the owner turns the
    // previous owner into a lessee.
    if ('role' in b) {
      if (!['owner', 'lessee'].includes(b.role)) return res.status(400).json({ error: 'role must be owner or lessee' });
      if (b.role === 'owner' && target.role !== 'owner') {
        await pool.query(`UPDATE partnership_members SET role = 'lessee' WHERE partnership_id = $1 AND role = 'owner'`, [req.partnershipId]);
      }
      add('role', b.role);
    }
    if ('is_admin' in b) {
      if (!req.isAdmin) return res.status(403).json({ error: 'Only an administrator can change administrators' });
      if (!b.is_admin) {
        const { rows: [{ others }] } = await pool.query(
          'SELECT COUNT(*)::int AS others FROM users WHERE is_admin AND is_active AND id <> $1', [target.user_id]);
        if (others === 0) return res.status(400).json({ error: 'There must be at least one administrator' });
      }
      await pool.query('UPDATE users SET is_admin = $2 WHERE id = $1', [target.user_id, !!b.is_admin]);
    }
    if (sets.length === 0) {
      if ('is_admin' in b) return res.json({ id: target.id });
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(req.params.memberId, req.partnershipId);
    const { rows: [m] } = await pool.query(
      `UPDATE partnership_members
       SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND partnership_id = $${params.length}
       RETURNING id, role, annual_hour_allotment, hour_allotment_period, lease_monthly_rate, overage_rate_per_hr, lease_start_date::text AS lease_start_date`,
      params
    );
    if (!m) return res.status(404).json({ error: 'Member not found' });
    res.json(m);
  } catch (err) {
    console.error('PATCH /partnership/members error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Aircraft image (sign-in screen and dashboard) ─────────────────────────────
router.get('/branding', async (req, res) => {
  res.json({ custom: !!branding.findBrandingMark() });
});

router.post('/branding', requireManager, imageUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    branding.saveBrandingMark(req.file.buffer, req.file.mimetype);
    res.json({ custom: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /partnership/branding error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/branding', requireManager, async (req, res) => {
  branding.clearBrandingMark();
  res.json({ custom: false });
});

// ── Adding and removing members ──────────────────────────────────────────────
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Emails the member a "choose your password" link from the connected Google account when
// possible; the link is also returned so a manager can pass it on another way.
async function inviteMember(req, user) {
  const link = await createPasswordLink(req, user.id, INVITE_TTL_MS);
  let emailed = false;
  if (await googleAuth.isConnected()) {
    try {
      const { rows: [p] } = await pool.query('SELECT aircraft_tail FROM partnerships WHERE id = $1', [req.partnershipId]);
      await googleMail.sendMail({
        to: user.email,
        subject: `You've been added to avManage${p?.aircraft_tail ? ` for ${p.aircraft_tail}` : ''}`,
        html: `<p>Hi ${user.name.split(' ')[0]},</p>
               <p>You now have an avManage account${p?.aircraft_tail ? ` for ${p.aircraft_tail}` : ''}. Choose a password to sign in (this link works for 7 days):</p>
               <p><a href="${link}">Choose your password</a></p>`,
      });
      emailed = true;
    } catch (err) {
      console.error('Invite email failed:', err.message);
    }
  }
  return { link, emailed };
}

// POST /api/partnership/members { name, email, role } — manager only
router.post('/members', requireManager, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const role = req.body.role === 'owner' ? 'owner' : 'lessee';
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Name and a valid email are required' });

    const { rows: [existing] } = await pool.query(
      `SELECT u.id, u.is_active, EXISTS (SELECT 1 FROM partnership_members pm WHERE pm.user_id = u.id) AS is_member
       FROM users u WHERE u.email = $1`, [email]);
    if (existing && (existing.is_active || existing.is_member)) {
      return res.status(409).json({ error: 'Someone with that email already has an account' });
    }

    // A previously removed member is re-activated (keeping their history); otherwise a new
    // account with an unusable random password until they choose one from the invite link.
    const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    const { rows: [user] } = existing
      ? await pool.query('UPDATE users SET is_active = true, name = $2, password_hash = $3 WHERE id = $1 RETURNING id, email, name',
          [existing.id, name, randomHash])
      : await pool.query('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
          [email, name, randomHash]);
    if (role === 'owner') {
      await pool.query(`UPDATE partnership_members SET role = 'lessee' WHERE partnership_id = $1 AND role = 'owner'`, [req.partnershipId]);
    }
    const { rows: [member] } = await pool.query(
      'INSERT INTO partnership_members (partnership_id, user_id, role) VALUES ($1, $2, $3) RETURNING id',
      [req.partnershipId, user.id, role]);
    res.status(201).json({ id: member.id, ...(await inviteMember(req, user)) });
  } catch (err) {
    console.error('POST /partnership/members error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/partnership/members/:memberId/invite — new "choose your password" link
router.post('/members/:memberId/invite', requireManager, async (req, res) => {
  try {
    const { rows: [user] } = await pool.query(
      `SELECT u.id, u.email, u.name FROM partnership_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.id = $1 AND pm.partnership_id = $2`, [req.params.memberId, req.partnershipId]);
    if (!user) return res.status(404).json({ error: 'Member not found' });
    res.json(await inviteMember(req, user));
  } catch (err) {
    console.error('POST /partnership/members/:id/invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/partnership/members/:memberId — removes them from the partnership and disables
// their sign-in. Their flights and ledger history stay.
router.delete('/members/:memberId', requireManager, async (req, res) => {
  try {
    const { rows: [m] } = await pool.query(
      `SELECT pm.user_id, u.is_admin FROM partnership_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.id = $1 AND pm.partnership_id = $2`, [req.params.memberId, req.partnershipId]);
    if (!m) return res.status(404).json({ error: 'Member not found' });
    if (m.user_id === req.session.userId) return res.status(400).json({ error: "You can't remove yourself" });
    if (m.is_admin && !req.isAdmin) return res.status(403).json({ error: 'Only an administrator can remove an administrator' });
    await pool.query('DELETE FROM partnership_members WHERE id = $1', [req.params.memberId]);
    await pool.query('UPDATE users SET is_active = false, is_admin = false WHERE id = $1', [m.user_id]);
    await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [m.user_id]);
    res.sendStatus(204);
  } catch (err) {
    console.error('DELETE /partnership/members error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
