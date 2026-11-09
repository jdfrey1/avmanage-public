const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const reportCron = require('../services/reportCron');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = express.Router();
router.use(requireAuth);

const SETTINGS_FILE = path.join('/data', '.report-settings.json');
const DEFAULT_SETTINGS = {
  monthlyEnabled: false,
  monthlyCron: '0 8 1 * *',
  currencyCheckEnabled: false,
  currencyCheckCron: '0 8 * * *',
};

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Wire settings into cron service (avoids circular require, same pattern as backupCron)
reportCron.setSettingsReader(readSettings);

// Partnership-wide report settings and test sends are for the owner or an administrator.
async function requireOwnerOrAdmin(req, res, next) {
  try {
    const { rows: [m] } = await pool.query(
      `SELECT pm.role, u.is_admin FROM users u LEFT JOIN partnership_members pm ON pm.user_id = u.id WHERE u.id = $1 LIMIT 1`,
      [req.session.userId]);
    if (m?.role !== 'owner' && !m?.is_admin) return res.status(403).json({ error: 'Owner or administrator only' });
    next();
  } catch (err) { next(err); }
}

// GET /api/reports/settings
router.get('/settings', (req, res) => {
  res.json(readSettings());
});

// POST /api/reports/settings
router.post('/settings', requireOwnerOrAdmin, (req, res) => {
  const { monthlyEnabled, monthlyCron, currencyCheckEnabled, currencyCheckCron } = req.body;
  const settings = {
    monthlyEnabled: !!monthlyEnabled,
    monthlyCron: monthlyCron || DEFAULT_SETTINGS.monthlyCron,
    currencyCheckEnabled: !!currencyCheckEnabled,
    currencyCheckCron: currencyCheckCron || DEFAULT_SETTINGS.currencyCheckCron,
  };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  reportCron.restartCron(settings);
  res.json(settings);
});

// POST /api/reports/test — send the monthly report immediately, regardless of schedule.
// Optional { to } overrides recipients (e.g. send a preview to just yourself instead of the
// whole partnership while the report is still being tuned).
router.post('/test', requireOwnerOrAdmin, async (req, res) => {
  try {
    const { to } = req.body || {};
    let overrideRecipients = null;
    if (to) {
      const list = Array.isArray(to) ? to : [to];
      if (list.some(e => typeof e !== 'string' || !EMAIL_RE.test(e))) {
        return res.status(400).json({ error: 'to must contain valid email addresses' });
      }
      overrideRecipients = list;
    }
    await reportCron.runMonthlyReport(overrideRecipients);
    res.json({ success: true });
  } catch (err) {
    console.error('[reports] Test report failed:', err);
    res.status(500).json({ error: 'Failed to send report: ' + err.message });
  }
});

// GET /api/reports/currency-alert-pref — the requesting user's own opt-in for currency alerts
router.get('/currency-alert-pref', async (req, res) => {
  try {
    const { rows: [u] } = await pool.query(
      'SELECT currency_alerts_enabled, currency_alert_time FROM users WHERE id = $1',
      [req.session.userId]
    );
    res.json({ enabled: u.currency_alerts_enabled, time: u.currency_alert_time });
  } catch (err) {
    console.error('[reports] GET currency-alert-pref failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/reports/currency-alert-pref
router.post('/currency-alert-pref', async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(req.body?.time || '') ? req.body.time : null;
    const { rows: [u] } = await pool.query(
      'UPDATE users SET currency_alerts_enabled = $1, currency_alert_time = COALESCE($3, currency_alert_time) WHERE id = $2 RETURNING currency_alert_time',
      [enabled, req.session.userId, time]);
    res.json({ enabled, time: u.currency_alert_time });
  } catch (err) {
    console.error('[reports] POST currency-alert-pref failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/reports/currency-test — send a preview of the requesting user's own currency
// alert (whichever item is soonest to expire), regardless of whether it's actually within an
// alert threshold right now. Optional { to } overrides the recipient (defaults to self).
router.post('/currency-test', async (req, res) => {
  try {
    const { to } = req.body || {};
    if (to && !EMAIL_RE.test(to)) return res.status(400).json({ error: 'to must be a valid email address' });
    const { rows: [u] } = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    await reportCron.sendTestCurrencyAlert(req.session.userId, to || u.email);
    res.json({ success: true });
  } catch (err) {
    console.error('[reports] Currency test failed:', err);
    res.status(500).json({ error: 'Failed to send test alert: ' + err.message });
  }
});

module.exports = router;
