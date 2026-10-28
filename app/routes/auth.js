const express = require('express');
const bcrypt = require('bcryptjs');
const googleAuth = require('../services/googleAuth');
const googleMail = require('../services/googleMail');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const { hashToken, createPasswordLink } = require('../services/passwordLinks');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash, is_active FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'This account is disabled' });
    }

    req.session.userId = user.id;

    const { rows: [profile] } = await pool.query(
      `SELECT u.id, u.email, u.name, u.is_admin, pm.role
       FROM users u
       LEFT JOIN partnership_members pm ON pm.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [req.session.userId]
    );
    res.json(profile);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.clearCookie('connect.sid');
    res.sendStatus(204);
  });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.is_admin, pm.role
       FROM users u
       LEFT JOIN partnership_members pm ON pm.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [req.session.userId]
    );
    if (!rows[0]) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Auth me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/profile', requireAuth, async (req, res) => {
  const { name, email, currentPassword, newPassword } = req.body;
  const userId = req.session.userId;

  try {
    const { rows: [user] } = await pool.query(
      'SELECT id, email, name, password_hash FROM users WHERE id = $1',
      [userId]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updates = {};

    if (name && name.trim()) updates.name = name.trim();

    if (email && email.trim().toLowerCase() !== user.email) {
      const { rows } = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email.trim().toLowerCase(), userId]
      );
      if (rows.length > 0) return res.status(409).json({ error: 'Email already in use' });
      updates.email = email.trim().toLowerCase();
    }

    if (newPassword) {
      if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
      if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
      updates.password_hash = await bcrypt.hash(newPassword, 12);
    }

    if (Object.keys(updates).length === 0) return res.json({ id: user.id, email: user.email, name: user.name });

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = [...Object.values(updates), userId];
    const { rows: [updated] } = await pool.query(
      `UPDATE users SET ${setClauses} WHERE id = $${values.length} RETURNING id, email, name, is_admin`,
      values
    );

    res.json(updated);
  } catch (err) {
    console.error('PATCH /auth/profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Password reset by email ──────────────────────────────────────────────────
const RESET_TTL_MS = 60 * 60 * 1000;

// Always answers the same way whether or not the address exists, so this can't be used to
// find out who has an account. The reset link goes out from the shared Google account.
router.post('/forgot', async (req, res) => {
  const email = (req.body?.email || '').toLowerCase().trim();
  res.json({ ok: true });
  if (!email) return;
  try {
    const { rows: [user] } = await pool.query('SELECT id, name, email, is_active FROM users WHERE email = $1', [email]);
    if (!user || !user.is_active) return;
    const { rows: [recent] } = await pool.query(
      `SELECT 1 FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 minute'`, [user.id]);
    if (recent) return; // simple throttle
    if (!(await googleAuth.isConnected())) { console.warn('[auth] password reset requested but Google is not connected'); return; }

    const link = await createPasswordLink(req, user.id, RESET_TTL_MS);
    await googleMail.sendMail({
      to: user.email,
      subject: 'Reset your avManage password',
      html: `<p>Hi ${user.name.split(' ')[0]},</p>
             <p>Someone asked to reset the password for your avManage account. This link works for 1 hour:</p>
             <p><a href="${link}">Choose a new password</a></p>
             <p>If you didn't ask for this, ignore this email and your password stays the same.</p>`,
    });
  } catch (err) {
    console.error('POST /auth/forgot error:', err.message);
  }
});

router.post('/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const { rows: [r] } = await pool.query(
      `SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token)]);
    if (!r) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });

    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [r.user_id, await bcrypt.hash(password, 12)]);
    await pool.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [r.user_id]);
    // Sign the account out everywhere so an old session can't outlive the reset.
    await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [r.user_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /auth/reset error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
