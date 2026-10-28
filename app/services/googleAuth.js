const { google } = require('googleapis');
const pool = require('../db');

// Shared OAuth plumbing for the single dedicated Google account (the aircraft's own account,
// not any individual pilot's) used by Calendar push sync, Drive file archiving, and Gmail
// report sending. One grant, one refresh token — see docs/DEVELOPMENT.md.
// Config lives in the google_calendar_config singleton row (kept that name despite covering
// more than Calendar now — renaming raw SQL across services with no migration tooling is
// riskier than the name being slightly stale).

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly', // read FlightAware alert emails
];

// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (and optionally GOOGLE_CALENDAR_ID) from the
// environment fill in the OAuth client; called once at startup. Without them the existing row
// (if any) is left alone, so a database configured by hand keeps working.
async function syncConfigFromEnv() {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, GOOGLE_CALENDAR_ID: calendar } = process.env;
  if (!id || !secret) return;
  await pool.query(
    `INSERT INTO google_calendar_config (id, client_id, client_secret, calendar_id)
     VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret = EXCLUDED.client_secret,
       calendar_id = COALESCE($4, google_calendar_config.calendar_id)`,
    [id, secret, calendar || 'primary', calendar || null]);
}

async function getConfig() {
  const { rows: [config] } = await pool.query('SELECT * FROM google_calendar_config WHERE id = 1');
  return config || null;
}

function buildOAuthClient(config, redirectUri) {
  return new google.auth.OAuth2(config.client_id, config.client_secret, redirectUri);
}

function getRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/calendar/google/callback`;
}

async function getAuthUrl(req) {
  const config = await getConfig();
  if (!config) throw Object.assign(new Error('Google integration is not configured'), { status: 503 });
  const client = buildOAuthClient(config, getRedirectUri(req));
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces Google to return a refresh_token even on re-auth (e.g. adding scopes)
    scope: SCOPES,
  });
}

async function handleCallback(req, code) {
  const config = await getConfig();
  if (!config) throw Object.assign(new Error('Google integration is not configured'), { status: 503 });
  const client = buildOAuthClient(config, getRedirectUri(req));
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token — remove the app from https://myaccount.google.com/permissions on the aircraft account and try connecting again.');
  }
  await pool.query(
    `UPDATE google_calendar_config
     SET refresh_token = $1, connected_at = NOW(), connected_by = $2
     WHERE id = 1`,
    [tokens.refresh_token, req.session.userId]
  );
}

// Returns an authorized (credentials already set) OAuth2 client, for Calendar/Drive/Gmail
// service modules to build their typed API client from. Access-token refresh from the stored
// refresh_token is handled transparently by the googleapis library on each call.
async function getAuthorizedOAuth2Client() {
  const config = await getConfig();
  if (!config) throw Object.assign(new Error('Google integration is not configured'), { status: 503 });
  if (!config.refresh_token) throw Object.assign(new Error('Google integration is not connected yet'), { status: 503 });

  const client = new google.auth.OAuth2(config.client_id, config.client_secret);
  client.setCredentials({ refresh_token: config.refresh_token });
  return client;
}

async function isConnected() {
  const config = await getConfig();
  return !!config?.refresh_token;
}

// Revokes the stored refresh token with Google (best-effort) and clears the local connection
// state. Per-row *_event_id/drive_file_id values are left in place in case of reconnect —
// reconnecting resumes updating the same events/files rather than duplicating them.
async function disconnect() {
  const config = await getConfig();
  if (config?.refresh_token) {
    try {
      const client = new google.auth.OAuth2(config.client_id, config.client_secret);
      await client.revokeToken(config.refresh_token);
    } catch (err) {
      console.error('Google token revoke failed (clearing local connection anyway):', err.message);
    }
  }
  await pool.query(
    `UPDATE google_calendar_config SET refresh_token = NULL, connected_at = NULL, connected_by = NULL WHERE id = 1`
  );
}

// Whether Google still accepts the stored refresh token. isConnected() only checks that a
// token is stored, so a revoked/expired grant (invalid_grant) looks "connected" until
// something actually calls Google. Cached briefly so the Settings page doesn't hit Google
// on every load.
let _health = { at: 0, result: null };
async function checkTokenHealth() {
  if (_health.result && Date.now() - _health.at < 5 * 60 * 1000) return _health.result;
  let result;
  try {
    const client = await getAuthorizedOAuth2Client();
    await client.getAccessToken();
    result = { valid: true };
  } catch (err) {
    result = { valid: false, error: err.message };
  }
  _health = { at: Date.now(), result };
  return result;
}

module.exports = {
  syncConfigFromEnv,
  checkTokenHealth,
  getConfig, getAuthUrl, handleCallback, getAuthorizedOAuth2Client, isConnected, disconnect,
};
