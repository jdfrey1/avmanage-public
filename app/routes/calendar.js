const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const googleAuth = require('../services/googleAuth');
const googleDrive = require('../services/googleDrive');

const router = express.Router();

// GET /api/calendar/google/status — is the shared Google account (Calendar+Drive+Gmail) connected?
router.get('/google/status', requireAuth, async (req, res) => {
  try {
    const config = await googleAuth.getConfig();
    const health = config?.refresh_token ? await googleAuth.checkTokenHealth() : null;
    res.json({
      configured: !!config,
      connected: !!config?.refresh_token,
      tokenValid: health ? health.valid : null,
      connectedAt: config?.connected_at || null,
      // "render?cid=" is Google's standard link for opening/subscribing to a calendar by ID.
      calendarUrl: config?.calendar_id
        ? `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(config.calendar_id)}`
        : null,
      driveUrl: config?.drive_root_folder_id
        ? `https://drive.google.com/drive/folders/${config.drive_root_folder_id}`
        : null,
    });
  } catch (err) {
    console.error('Google status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/calendar/google/disconnect — revoke access and clear the stored connection
router.post('/google/disconnect', requireAuth, async (req, res) => {
  try {
    await googleAuth.disconnect();
    res.json({ ok: true });
  } catch (err) {
    console.error('Google disconnect error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/calendar/google/connect — redirect to Google's consent screen
router.get('/google/connect', requireAuth, async (req, res) => {
  try {
    const url = await googleAuth.getAuthUrl(req);
    res.redirect(url);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Google connect error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/calendar/google/callback — Google redirects here after consent
router.get('/google/callback', requireAuth, async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error) return res.redirect('/settings?google_calendar=error');
    if (!code) return res.status(400).send('Missing authorization code');
    await googleAuth.handleCallback(req, code);
    // Best-effort — Drive folder setup shouldn't block finishing the OAuth flow if it fails.
    try { await googleDrive.ensureFolderStructure(); }
    catch (err) { console.error('Drive folder setup failed after connect:', err.message); }
    res.redirect('/settings?google_calendar=connected');
  } catch (err) {
    console.error('Google callback error:', err);
    res.redirect('/settings?google_calendar=error');
  }
});

function formatDT(iso) {
  // "2025-06-14T14:00:00.000Z" → "20250614T140000Z"
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '').replace(' ', 'T')
}

function formatDate(dateStr) {
  // "2025-06-14" → "20250614"
  return dateStr.replace(/-/g, '')
}

function escapeIcal(str) {
  if (!str) return ''
  return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

// Authenticated: return this user's calendar token + feed URL
router.get('/token', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT calendar_token FROM users WHERE id = $1',
      [req.session.userId]
    )
    if (!rows[0]) return res.status(404).json({ error: 'User not found' })
    const token = rows[0].calendar_token
    const proto = req.headers['x-forwarded-proto'] || req.protocol
    const host  = req.headers['x-forwarded-host'] || req.headers.host
    // Cache-busting query param: Google Calendar aggressively caches subscribed feeds by
    // exact URL and often won't re-fetch on remove/re-add. Bump this if the feed's fixed
    // metadata (name/description/timezone) changes again and subscribers need a fresh pull.
    const url   = `${proto}://${host}/api/calendar/${token}.ics?v=2`
    res.json({ token, url })
  } catch (err) {
    console.error('Calendar token error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Public (token-authenticated): serve iCal feed
router.get('/:token.ics', async (req, res) => {
  try {
    // Look up user + partnership by token
    const { rows: userRows } = await pool.query(
      `SELECT u.id AS user_id, pm.partnership_id
       FROM users u
       JOIN partnership_members pm ON pm.user_id = u.id
       WHERE u.calendar_token = $1
       LIMIT 1`,
      [req.params.token]
    )
    if (!userRows[0]) return res.status(404).send('Not found')

    const { partnership_id } = userRows[0]

    // Fetch aircraft tail (for calendar naming), schedule blocks, and flights in parallel
    const [{ rows: [partnership] }, { rows: blocks }, { rows: flights }] = await Promise.all([
      pool.query('SELECT aircraft_tail FROM partnerships WHERE id = $1', [partnership_id]),
      pool.query(
        `SELECT sb.id, sb.title, sb.start_dt, sb.end_dt, sb.is_all_day,
                sb.notes, sb.block_type,
                COALESCE(sb.pilot_name, u.name) AS pilot_name
         FROM schedule_blocks sb
         LEFT JOIN users u ON u.id = sb.pilot_id
         WHERE sb.partnership_id = $1
         ORDER BY sb.start_dt`,
        [partnership_id]
      ),
      pool.query(
        `SELECT f.id, f.flight_date, f.route, f.flight_time, f.notes,
                COALESCE(f.pilot_name, u.name) AS pilot_name
         FROM flights f
         LEFT JOIN users u ON u.id = f.pilot_id
         WHERE f.partnership_id = $1
         ORDER BY f.flight_date`,
        [partnership_id]
      ),
    ])

    const tail = partnership?.aircraft_tail || 'Aircraft'

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:-//avManage//${tail}//EN`,
      `X-WR-CALNAME:${tail} Schedule`,
      'X-WR-CALDESC:SR22 Dry-Lease Partnership Schedule',
      `X-WR-TIMEZONE:${process.env.APP_TIMEZONE || 'America/New_York'}`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ]

    for (const b of blocks) {
      const summary = escapeIcal(b.title || b.block_type)
      const desc    = [b.pilot_name, b.notes].filter(Boolean).map(escapeIcal).join(' · ')
      lines.push('BEGIN:VEVENT')
      lines.push(`UID:block-${b.id}@sr22`)
      if (b.is_all_day) {
        const d = b.start_dt.toISOString ? b.start_dt.toISOString().slice(0, 10) : String(b.start_dt).slice(0, 10)
        lines.push(`DTSTART;VALUE=DATE:${formatDate(d)}`)
        lines.push(`DTEND;VALUE=DATE:${formatDate(d)}`)
      } else {
        lines.push(`DTSTART:${formatDT(b.start_dt instanceof Date ? b.start_dt.toISOString() : b.start_dt)}`)
        lines.push(`DTEND:${formatDT(b.end_dt instanceof Date ? b.end_dt.toISOString() : b.end_dt)}`)
      }
      lines.push(`SUMMARY:${summary}`)
      if (desc) lines.push(`DESCRIPTION:${desc}`)
      lines.push('END:VEVENT')
    }

    for (const f of flights) {
      const dateStr = typeof f.flight_date === 'string' ? f.flight_date : f.flight_date.toISOString().slice(0, 10)
      const parts   = [f.pilot_name, f.route, f.flight_time ? `${parseFloat(f.flight_time).toFixed(1)} flight hrs` : null, f.notes]
      const desc    = parts.filter(Boolean).map(escapeIcal).join(' · ')
      const summary = escapeIcal([f.pilot_name, f.route ? `Flight ${f.route}` : 'Flight'].filter(Boolean).join(' — '))
      lines.push('BEGIN:VEVENT')
      lines.push(`UID:flight-${f.id}@sr22`)
      lines.push(`DTSTART;VALUE=DATE:${formatDate(dateStr)}`)
      lines.push(`DTEND;VALUE=DATE:${formatDate(dateStr)}`)
      lines.push(`SUMMARY:${summary}`)
      if (desc) lines.push(`DESCRIPTION:${desc}`)
      lines.push('END:VEVENT')
    }

    lines.push('END:VCALENDAR')

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="sr22.ics"')
    res.send(lines.join('\r\n'))
  } catch (err) {
    console.error('Calendar feed error:', err)
    res.status(500).send('Internal server error')
  }
})

module.exports = router
