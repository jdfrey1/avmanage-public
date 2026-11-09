const cron = require('node-cron');
const pool = require('../db');
const reports = require('./reports');
const googleMail = require('./googleMail');
const googleAuth = require('./googleAuth');

// Days-before-expiry to alert at — fixed milestones rather than "alert every day it's within
// N days," so a pilot gets exactly two heads-ups (a week out, then the day before) instead of
// a repeat email every day currency is lapsing. No DB state needed to dedupe.
const ALERT_THRESHOLDS = [7, 1];

let monthlyTask = null;

// Settings are set by reports.js route after it loads (avoids circular require, same pattern
// as backupCron's setRunBackup).
let _readSettings = null;
function setSettingsReader(fn) { _readSettings = fn; }

function initCron() {
  if (!_readSettings) return;
  _applySettings(_readSettings());
}

function restartCron(settings) {
  _applySettings(settings);
}

function _applySettings(settings) {
  if (monthlyTask) { monthlyTask.stop(); monthlyTask = null; }

  if (settings.monthlyEnabled && settings.monthlyCron) {
    if (!cron.validate(settings.monthlyCron)) {
      console.warn(`[report-cron] Invalid monthly cron expression: ${settings.monthlyCron}`);
    } else {
      monthlyTask = cron.schedule(settings.monthlyCron, async () => {
        console.log('[report-cron] Monthly report starting');
        try { await runMonthlyReport(); console.log('[report-cron] Monthly report sent'); }
        catch (err) { console.error('[report-cron] Monthly report failed:', err.message); }
      });
      console.log(`[report-cron] Monthly report scheduled: ${settings.monthlyCron}`);
    }
  }
}

async function getPartnershipId() {
  const { rows: [p] } = await pool.query('SELECT id FROM partnerships LIMIT 1');
  return p?.id || null;
}

async function getRecipients(partnershipId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.currency_alerts_enabled FROM users u
     JOIN partnership_members pm ON pm.user_id = u.id
     WHERE pm.partnership_id = $1`,
    [partnershipId]
  );
  return rows;
}

// items: [{ label, days }, ...] — everything expiring soon for one pilot, combined into a
// single email rather than one email per currency type (so a day where e.g. both IFR and BFR
// cross a threshold doesn't send two separate messages).
function currencyAlertEmail(pilotName, items) {
  const dayStr = (n) => `${n} day${n === 1 ? '' : 's'}`;
  if (items.length === 1) {
    const { label, days } = items[0];
    return {
      subject: `${pilotName}'s ${label} expires in ${dayStr(days)}`,
      html: `<p><strong>${pilotName}'s ${label}</strong> will expire in ${dayStr(days)}.</p>`,
    };
  }
  const subject = `${pilotName}'s currency is expiring soon (${items.length} items)`;
  const listItems = items.map(i => `<li><strong>${i.label}</strong> — expires in ${dayStr(i.days)}</li>`).join('');
  const html = `<p><strong>${pilotName}'s</strong> currency is expiring soon:</p><ul>${listItems}</ul>`;
  return { subject, html };
}

// overrideRecipients: optional array of email addresses to send to instead of the full
// partnership — used by the "Send Test Report Now" button so a report can be previewed by
// one person (e.g. while it's still being tuned) without emailing the whole partnership.
async function runMonthlyReport(overrideRecipients = null) {
  if (!(await googleAuth.isConnected())) {
    console.warn('[report-cron] Google not connected — skipping monthly report');
    return;
  }
  const partnershipId = await getPartnershipId();
  if (!partnershipId) return;

  const toEmails = overrideRecipients && overrideRecipients.length
    ? overrideRecipients
    // The real (non-test) report also goes to the connected Google account itself, so a copy
    // lands in the shared inbox as a standing record separate from the members' copies.
    : [...new Set([...(await getRecipients(partnershipId)).map(r => r.email), await googleMail.getAccountEmail()].filter(Boolean))];
  if (toEmails.length === 0) return;

  const { rows: [p] } = await pool.query('SELECT aircraft_tail FROM partnerships WHERE id = $1', [partnershipId]);
  const { month_label: monthLabel } = await reports.getReportPeriod();
  const html = await reports.buildMonthlyReportHtml(partnershipId);
  await googleMail.sendMail({
    to: toEmails,
    subject: `${p?.aircraft_tail || 'Aircraft'} — Monthly Report (${monthLabel})${overrideRecipients ? ' [TEST]' : ''}`,
    html,
  });
}

// Each pilot is only alerted about their own currency, and only if they've opted in — a
// partner's expiring medical/BFR/landing currency isn't the rest of the partnership's business
// (see users.currency_alerts_enabled). Each member picks the time (users.currency_alert_time);
// the check runs once per local day after that time (called every few minutes).
async function checkCurrencyFor(pilot) {
  const status = await reports.getCurrencyStatus(pilot.id);
  const checks = [
    ['IFR currency', status.ifr],
    ['Day landing currency', status.dayLanding],
    ['Night landing currency', status.nightLanding],
    ['Medical', status.medical],
    ['BFR', status.bfr],
  ];
  const triggered = checks
    .map(([label, s]) => ({ label, days: s.expiresInDays ?? s.daysUntilExpiry, current: s.current }))
    .filter(c => c.current && ALERT_THRESHOLDS.includes(c.days));
  if (triggered.length === 0) return false;
  const { subject, html } = currencyAlertEmail(pilot.name, triggered);
  await googleMail.sendMail({ to: pilot.email, subject, html });
  return true;
}

// now: { date: 'YYYY-MM-DD', hhmm: 'HH:MM' } in the app time zone.
async function runDueCurrencyChecks(now) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name FROM users u
     WHERE u.currency_alerts_enabled AND u.currency_alert_time <= $2
       AND (u.currency_alert_last_date IS NULL OR u.currency_alert_last_date < $1::date)
       AND EXISTS (SELECT 1 FROM partnership_members pm WHERE pm.user_id = u.id)`,
    [now.date, now.hhmm]);
  for (const pilot of rows) {
    try {
      const sent = await checkCurrencyFor(pilot);
      if (sent) console.log(`[currency-alerts] warning sent to ${pilot.name}`);
    } catch (err) {
      console.error(`[currency-alerts] check for ${pilot.name} failed:`, err.message);
      continue; // try again on the next pass
    }
    await pool.query('UPDATE users SET currency_alert_last_date = $2 WHERE id = $1', [pilot.id, now.date]);
  }
}

// Preview of a currency alert for the requesting user's own current status — used by the
// "Send Test Alert" button so someone can see the format without waiting for a real threshold
// to hit. Shows all of their currently-current items (soonest first), same combined-email
// shape a real multi-item alert would use, rather than filtering to the 7/1-day thresholds —
// falls back to a single IFR entry if nothing is current so the preview always shows something.
async function sendTestCurrencyAlert(userId, to) {
  const { rows: [u] } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
  const status = await reports.getCurrencyStatus(userId);
  const checks = [
    ['IFR currency', status.ifr],
    ['Day landing currency', status.dayLanding],
    ['Night landing currency', status.nightLanding],
    ['Medical', status.medical],
    ['BFR', status.bfr],
  ];
  const current = checks
    .map(([label, s]) => ({ label, days: s.expiresInDays ?? s.daysUntilExpiry, current: s.current }))
    .filter(c => c.current && c.days != null)
    .sort((a, b) => a.days - b.days);
  const items = current.length ? current : [{ label: 'IFR currency', days: status.ifr.expiresInDays ?? 0 }];

  const { subject, html } = currencyAlertEmail(u.name, items);
  await googleMail.sendMail({ to, subject: `${subject} [TEST]`, html });
}

module.exports = {
  initCron, restartCron, setSettingsReader,
  runMonthlyReport, runDueCurrencyChecks, sendTestCurrencyAlert,
};
