const crypto = require('crypto');
const pool = require('../db');

// Single-use "choose a password" links, used for both password resets and new-member
// invitations. Only a hash of the token is stored.
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function baseUrl(req) {
  const base = process.env.PUBLIC_URL || req.get('origin') || `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/$/, '');
}

async function createPasswordLink(req, userId, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(token), new Date(Date.now() + ttlMs)]);
  return `${baseUrl(req)}/reset-password?token=${token}`;
}

module.exports = { hashToken, createPasswordLink };
