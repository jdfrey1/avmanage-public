const crypto = require('crypto');
const cron = require('node-cron');
const pool = require('../db');
const reports = require('./reports');
const googleMail = require('./googleMail');
const googleAuth = require('./googleAuth');
const { loadAnalysis } = require('./engineAnalysis');
const reportCron = require('./reportCron');

// Per-member email updates. Each member picks how often (daily, weekly, or only when something
// changed), the time, and which sections to include. A check runs every 5 minutes; a member is
// due once their local time passes send_time on a day they haven't been checked yet.
//
// Every item in an email has a stable key (e.g. a reservation's id + times, a squawk's id +
// status). The keys from the last email are stored, so items can be marked NEW, items that went
// away can be listed as cleared, and "only when something changes" compares the two sets.

const TZ = process.env.APP_TIMEZONE || 'America/New_York';
const SECTIONS = ['schedule', 'squawks', 'insights', 'maintenance', 'currency', 'hours', 'flights'];
const SECTION_LABELS = {
  schedule: 'Schedule', squawks: 'Open squawks', insights: 'Data Log Insights', maintenance: 'Maintenance due',
  currency: 'My currency', hours: 'My hours', flights: 'Recently logged flights',
};
const DEFAULTS = {
  enabled: false, frequency: 'daily', send_time: '06:00', weekday: 1,
  sections: ['schedule', 'squawks', 'insights', 'maintenance', 'currency'],
  lookahead_days: 7, my_schedule_only: false, skip_empty: true,
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Local wall-clock parts in the app time zone.
function localNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hhmm: `${p.hour}:${p.minute}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}
const fmtDay = (d) => new Date(d).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = (d) => new Date(d).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtDate = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

async function getPrefs(userId) {
  const { rows: [r] } = await pool.query('SELECT * FROM notification_prefs WHERE user_id = $1', [userId]);
  return r ? { ...DEFAULTS, ...r } : { ...DEFAULTS, user_id: userId, last_items: {} };
}

// ── Content ────────────────────────────────────────────────────────────────────────────────
// Each section returns { items: [{ key, label, html, notable }], note? }. `notable` items count
// toward "is there anything to report"; e.g. a currency line that's fine is shown but isn't news.

async function scheduleSection(ctx, prefs) {
  const { rows } = await pool.query(
    `SELECT s.id, s.block_type, s.title, s.notes, s.start_dt, s.end_dt, s.is_all_day, s.pilot_id,
            COALESCE(s.pilot_name, pu.name) AS pilot_name
     FROM schedule_blocks s LEFT JOIN users pu ON pu.id = s.pilot_id
     WHERE s.partnership_id = $1 AND s.end_dt > NOW()
       AND ($2::boolean = false OR s.block_type <> 'reservation' OR s.pilot_id = $3)
     ORDER BY s.start_dt`,
    [ctx.partnershipId, prefs.my_schedule_only, ctx.userId]);
  const horizon = Date.now() + prefs.lookahead_days * 86400000;
  const items = [];
  for (const b of rows) {
    const key = `sched:${b.id}:${new Date(b.start_dt).toISOString()}:${new Date(b.end_dt).toISOString()}`;
    const inWindow = new Date(b.start_dt).getTime() < horizon;
    // Beyond the look-ahead window only new or changed bookings are shown.
    if (!inWindow && ctx.lastItems[key] !== undefined) { ctx.hidden.push(key, b.end_dt); continue; }
    if (!inWindow && !ctx.hasHistory) { ctx.hidden.push(key, b.end_dt); continue; }
    const when = b.is_all_day
      ? `${fmtDay(b.start_dt)} (all day)`
      : fmtDay(b.start_dt) === fmtDay(b.end_dt)
        ? `${fmtDay(b.start_dt)} · ${fmtTime(b.start_dt)}–${fmtTime(b.end_dt)}`
        : `${fmtDay(b.start_dt)} ${fmtTime(b.start_dt)} – ${fmtDay(b.end_dt)} ${fmtTime(b.end_dt)}`;
    const type = b.block_type === 'reservation' ? (b.pilot_name || 'Reservation')
      : b.block_type === 'maintenance' ? 'Maintenance' : 'Unavailable';
    const title = b.title && b.title.toLowerCase() !== b.block_type ? ` — ${esc(b.title)}` : '';
    const label = `${when}: ${type}`;
    items.push({ key, label, notable: true, endsAt: b.end_dt,
      html: `<strong>${esc(when)}</strong> · ${esc(type)}${title}${b.notes ? `<br><span style="color:#666">${esc(b.notes)}</span>` : ''}` });
  }
  return { items, empty: `Nothing scheduled in the next ${prefs.lookahead_days} day${prefs.lookahead_days === 1 ? '' : 's'}.` };
}

async function squawksSection(ctx) {
  const rows = await reports.getOpenSquawks(ctx.partnershipId);
  const sev = { major: 'MAJOR', minor: 'Minor', note: 'Note' };
  return {
    items: rows.map(s => ({
      key: `sq:${s.id}:${s.status}:${s.severity}`, label: `Squawk: ${s.description}`, notable: true,
      html: `<strong style="color:${s.severity === 'major' ? '#b91c1c' : 'inherit'}">${sev[s.severity] || s.severity}</strong> · ${esc(s.description)}
        <span style="color:#666">(${s.status.replace('_', ' ')}, ${esc(s.reported_by_name)} ${fmtDay(s.reported_at)})</span>`,
    })),
    empty: 'No open squawks.',
  };
}

async function insightsSection(ctx) {
  const { runs, findings } = await loadAnalysis(ctx.partnershipId, 200);
  const byId = new Map(runs.map(r => [r.id, r]));
  return {
    items: findings.map(f => {
      const r = byId.get(f.log_id);
      const flight = r ? `${fmtDay(r.started_at)}${r.origin ? ` · ${r.origin}${r.destination ? `→${r.destination}` : ''}` : ''}${r.pilot_name ? ` · ${r.pilot_name}` : ''}` : '';
      return {
        key: `ins:${f.key}`, label: `Insight: ${f.title}`, notable: true,
        html: `<strong style="color:${f.severity === 'warning' ? '#b91c1c' : '#b45309'}">${f.severity === 'warning' ? 'Warning' : 'Caution'}</strong> · ${esc(f.title)}
          ${flight ? `<br><span style="color:#666">${esc(flight)}${f.detail ? ` — ${esc(f.detail)}` : ''}</span>` : ''}`,
      };
    }),
    empty: 'No open insights.',
  };
}

async function maintenanceSection(ctx) {
  const [inspections, intervals] = await Promise.all([reports.getInspections(ctx.partnershipId), reports.getHourIntervals(ctx.partnershipId)]);
  const items = [];
  for (const i of inspections.filter(i => i.status === 'overdue' || i.status === 'due_soon')) {
    const when = i.status === 'overdue' ? `overdue since ${fmtDate(i.due_date)}` : `due ${fmtDate(i.due_date)} (${i.days_until} day${i.days_until === 1 ? '' : 's'})`;
    items.push({ key: `insp:${i.id}:${i.status}:${i.due_date}`, label: `${i.title} ${i.status === 'overdue' ? 'overdue' : 'due soon'}`, notable: true,
      html: `<strong style="color:${i.status === 'overdue' ? '#b91c1c' : '#b45309'}">${esc(i.title)}</strong> · ${esc(when)}` });
  }
  for (const i of intervals.items.filter(i => i.status === 'overdue' || i.status === 'due_soon')) {
    const when = i.status === 'overdue' ? `overdue by ${Math.abs(i.hours_remaining).toFixed(1)} hrs` : `due in ${i.hours_remaining.toFixed(1)} hrs (at ${i.next_due_hours.toFixed(1)})`;
    items.push({ key: `int:${i.id}:${i.status}:${i.next_due_hours}`, label: `${i.title} ${i.status === 'overdue' ? 'overdue' : 'due soon'}`, notable: true,
      html: `<strong style="color:${i.status === 'overdue' ? '#b91c1c' : '#b45309'}">${esc(i.title)}</strong> · ${esc(when)}` });
  }
  return { items, empty: 'Nothing overdue or coming due.' };
}

async function currencySection(ctx) {
  const s = await reports.getCurrencyStatus(ctx.userId);
  const rows = [['IFR', s.ifr], ['Day landings', s.dayLanding], ['Night landings', s.nightLanding], ['Medical', s.medical], ['Flight review', s.bfr]];
  const items = [];
  for (const [label, st] of rows) {
    const days = st.expiresInDays ?? st.daysUntilExpiry;
    const never = (label === 'Medical' && !st.expiresDate) || (label === 'Flight review' && !st.accomplishedDate);
    if (never) continue;
    const state = !st.current ? 'lapsed' : days <= 30 ? 'soon' : 'ok';
    const text = !st.current ? 'Not current' : `Current · ${days} day${days === 1 ? '' : 's'} left`;
    items.push({ key: `cur:${label}:${state}`, label: `${label}: ${text}`, notable: state === 'soon', // lapsing soon is news; already lapsed is a standing state
      html: `<strong>${label}</strong> · <span style="color:${state === 'lapsed' ? '#b91c1c' : state === 'soon' ? '#b45309' : 'inherit'}">${text}</span>` });
  }
  return { items, empty: 'No currency on record.' };
}

async function hoursSection(ctx) {
  const h = await reports.getHoursSummary(ctx.userId, ctx.partnershipId);
  const items = [];
  if (h.no_allotment) {
    items.push({ key: `hours:${h.hours_flown.toFixed(1)}`, label: 'Hours this year', notable: false,
      html: `<strong>${h.hours_flown.toFixed(1)} hrs</strong> flown this year` });
  } else if (!h.not_started) {
    const left = h.annual_allotment - h.hours_flown;
    items.push({ key: `hours:${h.hours_flown.toFixed(1)}`, label: 'Hours this lease period', notable: left < 0,
      html: `<strong>${h.hours_flown.toFixed(1)} of ${h.annual_allotment} hrs</strong> used this ${h.period === 'monthly' ? 'month' : 'lease year'}
        · ${left >= 0 ? `${left.toFixed(1)} remaining` : `<span style="color:#b91c1c">${(-left).toFixed(1)} over</span>`}` });
    const bal = await reports.getLedgerBalance(ctx.partnershipId, ctx.userId);
    items.push({ key: `bal:${bal.toFixed(2)}`, label: 'Account balance', notable: bal < 0,
      html: `<strong>Account balance</strong> · ${bal < 0 ? `<span style="color:#b91c1c">$${(-bal).toFixed(2)} owed</span>` : bal > 0 ? `$${bal.toFixed(2)} credit` : '$0.00'}` });
  }
  return { items, empty: 'No allotment information.' };
}

async function flightsSection(ctx) {
  const since = ctx.lastSentAt || new Date(Date.now() - 7 * 86400000);
  const { rows } = await pool.query(
    `SELECT f.id, TO_CHAR(f.flight_date, 'YYYY-MM-DD') AS flight_date, f.route, f.flight_time::float, f.notes,
            COALESCE(f.pilot_name, u.name) AS pilot
     FROM flights f JOIN users u ON u.id = f.pilot_id
     WHERE f.partnership_id = $1 AND f.created_at > $2
     ORDER BY f.flight_date, f.created_at`, [ctx.partnershipId, since]);
  return {
    items: rows.map(f => ({ key: `fl:${f.id}`, label: `Flight ${f.flight_date} ${f.route || ''}`, notable: true,
      html: `<strong>${fmtDate(f.flight_date)}</strong> · ${esc(f.pilot)} · ${esc(f.route || '')} · ${f.flight_time != null ? f.flight_time.toFixed(1) + ' hrs' : ''}
        ${f.notes ? `<br><span style="color:#666">${esc(f.notes)}</span>` : ''}` })),
    empty: ctx.lastSentAt ? 'No flights logged since the last update.' : 'No flights logged in the last 7 days.',
  };
}

const BUILDERS = { schedule: scheduleSection, squawks: squawksSection, insights: insightsSection, maintenance: maintenanceSection,
  currency: currencySection, hours: hoursSection, flights: flightsSection };

// Builds one member's email. Returns { subject, html, keys, hash, notableCount, newCount, cleared }.
async function buildDigest(userId, prefs = null) {
  prefs = prefs || await getPrefs(userId);
  const { rows: [u] } = await pool.query(
    `SELECT u.name, u.email, pm.partnership_id, p.aircraft_tail FROM users u
     JOIN partnership_members pm ON pm.user_id = u.id JOIN partnerships p ON p.id = pm.partnership_id
     WHERE u.id = $1 LIMIT 1`, [userId]);
  if (!u) throw new Error('No partnership for user');
  const lastItems = prefs.last_items || {};
  const ctx = { userId, partnershipId: u.partnership_id, lastItems, hasHistory: !!prefs.last_sent_at,
    lastSentAt: prefs.last_sent_at, hidden: [] };
  const tail = u.aircraft_tail || 'Aircraft';

  const sections = [];
  for (const id of SECTIONS.filter(s => prefs.sections.includes(s))) {
    try { sections.push({ id, ...(await BUILDERS[id](ctx, prefs)) }); }
    catch (err) { console.error(`[notifications] ${id} section failed:`, err.message); }
  }

  // Everything tracked (incl. bookings beyond the window that weren't shown).
  const keys = {};
  for (const s of sections) for (const i of s.items) keys[i.key] = i.label;
  for (let i = 0; i < ctx.hidden.length; i += 2) keys[ctx.hidden[i]] = '';
  // Running totals (hours, balance) change constantly; they're shown but never "new".
  const isNew = (k) => ctx.hasHistory && lastItems[k] === undefined && !/^(hours|bal):/.test(k);

  // Items that went away since the last email. Bookings that simply ended, and currency/hours
  // lines (which only change state), aren't "cleared".
  const ended = (k) => { const m = k.match(/^sched:[^:]+:.+:(\d{4}-\d\d-\d\dT[\d:.]+Z)$/); return m && new Date(m[1]) <= new Date(); };
  const cleared = ctx.hasHistory
    ? Object.entries(lastItems).filter(([k, label]) => keys[k] === undefined && label && !ended(k) && !/^(cur|hours|bal|fl):/.test(k))
        .map(([k, label]) => ({ key: k, label }))
    : [];
  // A booking that was moved shows up as new + cleared; only the new one is worth listing.
  const movedIds = new Set(Object.keys(keys).filter(k => k.startsWith('sched:')).map(k => k.split(':')[1]));
  const clearedShown = cleared.filter(c => !(c.key.startsWith('sched:') && movedIds.has(c.key.split(':')[1])))
    .map(c => ({ ...c, label: c.key.startsWith('sched:') ? `Cancelled — ${c.label}` : c.key.startsWith('sq:') ? `${c.label} (resolved)` : c.label }));

  const notableCount = sections.reduce((n, s) => n + s.items.filter(i => i.notable).length, 0);
  const newKeys = Object.keys(keys).filter(k => isNew(k) && keys[k]);
  const hash = crypto.createHash('sha1').update(Object.keys(keys).sort().join('\n')).digest('hex');

  const today = localNow();
  const dateLabel = fmtDay(new Date());
  const appUrl = (prefs.app_url || process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const link = (path, text) => appUrl ? `<a href="${esc(appUrl + path)}" style="color:#2563eb;text-decoration:none">${text}</a>` : '';
  const sectionPath = { schedule: '/schedule', squawks: '/maintenance', insights: '/maintenance?tab=engine', maintenance: '/maintenance',
    currency: '/settings?open=account', hours: '/', flights: '/flights' };
  const newBadge = '<span style="display:inline-block;background:#2563eb;color:#fff;font-size:10px;font-weight:600;padding:1px 5px;border-radius:3px;margin-right:4px;vertical-align:1px">NEW</span>';

  const body = sections.map(s => `
    <tr><td style="padding:16px 0 4px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#444">${SECTION_LABELS[s.id]}</td>
        <td align="right" style="font-size:12px">${link(sectionPath[s.id], 'Open ›')}</td>
      </tr></table>
    </td></tr>
    ${s.items.length
      ? s.items.map(i => `<tr><td style="padding:6px 0;border-top:1px solid #eee;font-size:14px;line-height:1.45">${isNew(i.key) ? newBadge : ''}${i.html}</td></tr>`).join('')
      : `<tr><td style="padding:6px 0;border-top:1px solid #eee;font-size:14px;color:#888">${esc(s.empty)}</td></tr>`}`).join('');
  const clearedHtml = clearedShown.length ? `
    <tr><td style="padding:16px 0 4px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#444">Cleared since last update</td></tr>
    ${clearedShown.map(c => `<tr><td style="padding:6px 0;border-top:1px solid #eee;font-size:14px;color:#666;text-decoration:none">✓ ${esc(c.label)}</td></tr>`).join('')}` : '';

  const freqText = prefs.frequency === 'weekly' ? 'weekly' : prefs.frequency === 'changes' ? 'when something changes' : 'daily';
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5"><tr><td align="center" style="padding:16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:8px;padding:20px 24px">
    <tr><td style="font-size:20px;font-weight:700">${esc(tail)} update</td></tr>
    <tr><td style="font-size:13px;color:#666;padding-top:2px">${esc(dateLabel)} · for ${esc(u.name)}${newKeys.length ? ` · ${newKeys.length} new` : ''}</td></tr>
    ${body}${clearedHtml}
    <tr><td style="padding-top:20px;font-size:12px;color:#888;border-top:1px solid #eee">
      You get this ${freqText}. ${link('/settings?open=email', 'Change what’s included or when it’s sent')}
    </td></tr>
  </table></td></tr></table></body></html>`;

  const counts = [];
  const sched = sections.find(s => s.id === 'schedule');
  if (sched?.items.length) counts.push(`${sched.items.length} scheduled`);
  const sq = sections.find(s => s.id === 'squawks');
  if (sq?.items.length) counts.push(`${sq.items.length} squawk${sq.items.length === 1 ? '' : 's'}`);
  const ins = sections.find(s => s.id === 'insights');
  if (ins?.items.length) counts.push(`${ins.items.length} insight${ins.items.length === 1 ? '' : 's'}`);
  const subject = prefs.frequency === 'changes' && ctx.hasHistory
    ? `${tail}: ${[newKeys.length && `${newKeys.length} new`, clearedShown.length && `${clearedShown.length} cleared`].filter(Boolean).join(', ') || 'update'} — ${dateLabel}`
    : `${tail} ${{ weekly: 'weekly ', daily: 'daily ' }[prefs.frequency] || ''}update — ${dateLabel}${counts.length ? ` (${counts.join(', ')})` : ''}`;

  return { subject, html, to: u.email, keys, hash, notableCount, newCount: newKeys.length, clearedCount: clearedShown.length, today };
}

// ── Scheduling ─────────────────────────────────────────────────────────────────────────────

// Decide and send for one member. force: send now regardless (test button) without touching
// the change-tracking state.
async function runFor(prefs, { force = false, to = null } = {}) {
  const d = await buildDigest(prefs.user_id, prefs);
  if (force) {
    await googleMail.sendMail({ to: to || d.to, subject: `${d.subject} [TEST]`, html: d.html });
    return { sent: true };
  }
  let send;
  if (prefs.frequency === 'changes') {
    send = prefs.last_hash ? d.newCount + d.clearedCount > 0 : d.notableCount > 0;
  } else {
    send = !prefs.skip_empty || d.notableCount > 0;
  }
  if (send) await googleMail.sendMail({ to: d.to, subject: d.subject, html: d.html });
  await pool.query(
    `UPDATE notification_prefs SET last_run_date = $2${send ? ', last_sent_at = NOW(), last_hash = $3, last_items = $4' : ''} WHERE user_id = $1`,
    send ? [prefs.user_id, d.today.date, d.hash, JSON.stringify(d.keys)] : [prefs.user_id, d.today.date]);
  return { sent: send };
}

function isDue(prefs, now = localNow()) {
  if (!prefs.enabled) return false;
  if (prefs.last_run_date && toYmd(prefs.last_run_date) === now.date) return false;
  if (now.hhmm < prefs.send_time) return false;
  if (prefs.frequency === 'weekly' && now.weekday !== prefs.weekday) return false;
  return true;
}
const toYmd = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    if (!(await googleAuth.isConnected())) return;
    const { rows } = await pool.query(
      `SELECT n.* FROM notification_prefs n JOIN users u ON u.id = n.user_id
       WHERE n.enabled AND EXISTS (SELECT 1 FROM partnership_members pm WHERE pm.user_id = n.user_id)`);
    const now = localNow();
    await reportCron.runDueCurrencyChecks(now).catch(err => console.error('[currency-alerts] failed:', err.message));
    for (const p of rows) {
      const prefs = { ...DEFAULTS, ...p };
      if (!isDue(prefs, now)) continue;
      try {
        const r = await runFor(prefs);
        console.log(`[notifications] ${p.user_id}: ${r.sent ? 'sent' : 'nothing to send'}`);
      } catch (err) {
        console.error(`[notifications] update for ${p.user_id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[notifications] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function initCron() {
  cron.schedule('*/5 * * * *', tick);
  setTimeout(tick, 60 * 1000);
}

module.exports = { SECTIONS, SECTION_LABELS, DEFAULTS, getPrefs, buildDigest, runFor, isDue, localNow, initCron };
