const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const googleAuth = require('../services/googleAuth');
const notifications = require('../services/notifications');

const router = express.Router();
router.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (res, err, tag) => {
  console.error(`[notifications] ${tag} failed:`, err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
};
const publicPrefs = (p, email, connected) => ({
  enabled: p.enabled, frequency: p.frequency, send_time: p.send_time, weekday: p.weekday,
  sections: p.sections, lookahead_days: p.lookahead_days, my_schedule_only: p.my_schedule_only, skip_empty: p.skip_empty,
  last_sent_at: p.last_sent_at || null, email, google_connected: connected,
  available_sections: notifications.SECTIONS.map(id => ({ id, label: notifications.SECTION_LABELS[id] })),
});

// GET /api/notifications — the requesting member's email update settings
router.get('/', async (req, res) => {
  try {
    const [p, { rows: [u] }, connected] = await Promise.all([
      notifications.getPrefs(req.session.userId),
      pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]),
      googleAuth.isConnected().catch(() => false),
    ]);
    res.json(publicPrefs(p, u?.email, connected));
  } catch (err) { fail(res, err, 'GET /'); }
});

// POST /api/notifications — save settings
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const frequency = ['daily', 'weekly', 'changes'].includes(b.frequency) ? b.frequency : 'daily';
    const send_time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.send_time) ? b.send_time : '06:00';
    const weekday = Number.isInteger(b.weekday) && b.weekday >= 0 && b.weekday <= 6 ? b.weekday : 1;
    const sections = (Array.isArray(b.sections) ? b.sections : []).filter(s => notifications.SECTIONS.includes(s));
    const lookahead = Math.min(60, Math.max(1, parseInt(b.lookahead_days, 10) || 7));
    const enabled = !!b.enabled;
    if (enabled && !sections.length) return res.status(400).json({ error: 'Pick at least one thing to include' });
    const appUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;

    // Turning it on (or moving the time) after today's send time has passed starts tomorrow,
    // instead of sending one within the next few minutes.
    const before = await notifications.getPrefs(req.session.userId);
    const now = notifications.localNow();
    const startTomorrow = enabled && now.hhmm >= send_time && (!before.enabled || before.send_time !== send_time || before.frequency !== frequency);

    await pool.query(
      `INSERT INTO notification_prefs (user_id, enabled, frequency, send_time, weekday, sections, lookahead_days, my_schedule_only, skip_empty, app_url, last_run_date, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $11 THEN $12::date END, NOW())
       ON CONFLICT (user_id) DO UPDATE SET enabled=$2, frequency=$3, send_time=$4, weekday=$5, sections=$6, lookahead_days=$7,
         my_schedule_only=$8, skip_empty=$9, app_url=$10,
         last_run_date = CASE WHEN $11 THEN $12::date ELSE notification_prefs.last_run_date END, updated_at=NOW()`,
      [req.session.userId, enabled, frequency, send_time, weekday, sections, lookahead, !!b.my_schedule_only, b.skip_empty !== false, appUrl,
       startTomorrow, now.date]);
    const [p, { rows: [u] }, connected] = await Promise.all([
      notifications.getPrefs(req.session.userId),
      pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]),
      googleAuth.isConnected().catch(() => false),
    ]);
    res.json(publicPrefs(p, u?.email, connected));
  } catch (err) { fail(res, err, 'POST /'); }
});

// Settings from the request body (unsaved form state) layered over the saved ones, so the
// preview and test reflect what's on screen.
async function draftPrefs(req) {
  const saved = await notifications.getPrefs(req.session.userId);
  const b = req.body || {};
  return {
    ...saved,
    frequency: ['daily', 'weekly', 'changes'].includes(b.frequency) ? b.frequency : saved.frequency,
    sections: Array.isArray(b.sections) ? b.sections.filter(s => notifications.SECTIONS.includes(s)) : saved.sections,
    lookahead_days: b.lookahead_days ? Math.min(60, Math.max(1, parseInt(b.lookahead_days, 10) || 7)) : saved.lookahead_days,
    my_schedule_only: b.my_schedule_only != null ? !!b.my_schedule_only : saved.my_schedule_only,
    app_url: saved.app_url || req.get('origin') || `${req.protocol}://${req.get('host')}`,
  };
}

// POST /api/notifications/preview — the email as it would look right now
router.post('/preview', async (req, res) => {
  try {
    const d = await notifications.buildDigest(req.session.userId, await draftPrefs(req));
    res.json({ subject: d.subject, html: d.html });
  } catch (err) { fail(res, err, 'POST /preview'); }
});

// POST /api/notifications/test — send it now (doesn't affect what counts as "new")
router.post('/test', async (req, res) => {
  try {
    if (!(await googleAuth.isConnected())) return res.status(400).json({ error: 'Google isn’t connected, so email can’t be sent' });
    const to = req.body?.to;
    if (to && !EMAIL_RE.test(to)) return res.status(400).json({ error: 'Not a valid email address' });
    await notifications.runFor(await draftPrefs(req), { force: true, to });
    res.json({ success: true });
  } catch (err) { fail(res, err, 'POST /test'); }
});

module.exports = router;
