const { google } = require('googleapis');
const cron = require('node-cron');
const pool = require('../db');
const googleAuth = require('./googleAuth');
const { recordForeflightImport } = require('./foreflightImport');

// Imports ForeFlight logbook exports that members forward to the shared Gmail account. The
// member is identified by the forwarding address (From:), or failing that by the address the
// original ForeFlight email went to (the "To:" line in the forwarded header). Only addresses of
// partnership members are accepted. Each message is processed once (foreflight_email_imports).

const QUERY = 'has:attachment filename:csv (foreflight OR "logbook auto-export")';

const headerOf = (payload, name) =>
  (payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const emailsIn = (s) => (s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(e => e.toLowerCase());

function walk(payload, fn) {
  (function rec(p) { fn(p); (p.parts || []).forEach(rec); })(payload);
}

function bodyText(payload) {
  const out = [];
  walk(payload, p => {
    if (p.body?.data && (p.mimeType === 'text/plain' || p.mimeType === 'text/html')) {
      out.push(Buffer.from(p.body.data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    }
  });
  return out.join('\n');
}

// "export as of 2026-10-12" in ForeFlight's email body → Date; null if not found.
function exportDate(text) {
  const m = text.match(/export as of (\d{4})-(\d{1,2})-(\d{1,2})/i);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : null;
}

async function findMember(partnershipId, payload, text) {
  const { rows: members } = await pool.query(
    `SELECT u.id, u.name, lower(u.email) AS email, u.last_foreflight_import_at FROM users u
     JOIN partnership_members pm ON pm.user_id = u.id WHERE pm.partnership_id = $1`, [partnershipId]);
  const byEmail = new Map(members.map(m => [m.email, m]));
  const from = emailsIn(headerOf(payload, 'From'))[0];
  if (from && byEmail.has(from)) return byEmail.get(from);
  // Forwarded header: "To: <pilot@example.com>" after "Forwarded message" / "From: ForeFlight".
  const fwd = text.split(/forwarded message|original message/i).slice(1).join('\n');
  for (const line of fwd.split('\n')) {
    if (/^\s*\**to:?\**/i.test(line)) {
      const hit = emailsIn(line).find(e => byEmail.has(e));
      if (hit) return byEmail.get(hit);
    }
  }
  return null;
}

async function logResult(msgId, userId, status, detail) {
  await pool.query(
    `INSERT INTO foreflight_email_imports (msg_id, user_id, status, detail) VALUES ($1, $2, $3, $4)
     ON CONFLICT (msg_id) DO UPDATE SET user_id = EXCLUDED.user_id, status = EXCLUDED.status, detail = EXCLUDED.detail, created_at = NOW()`,
    [msgId, userId, status, detail]);
  console.log(`[foreflight-email] ${msgId}: ${status}${detail ? ` — ${detail}` : ''}`);
}

// force: message ids to (re)process even if seen before or older than the last import.
async function pollEmails(days = 14, { force = [] } = {}) {
  if (!(await googleAuth.isConnected())) return { skipped: 'google not connected' };
  const { rows: [p] } = await pool.query('SELECT id FROM partnerships LIMIT 1');
  if (!p) return { skipped: 'no partnership' };
  const gmail = google.gmail({ version: 'v1', auth: await googleAuth.getAuthorizedOAuth2Client() });

  const { data } = await gmail.users.messages.list({ userId: 'me', q: `${QUERY} newer_than:${days}d`, maxResults: 50 });
  const ids = (data.messages || []).map(m => m.id);
  if (!ids.length) return { imported: 0 };
  const { rows: done } = await pool.query('SELECT msg_id FROM foreflight_email_imports WHERE msg_id = ANY($1)', [ids]);
  const seen = new Set(done.map(r => r.msg_id).filter(i => !force.includes(i)));

  let imported = 0;
  // Oldest first, so if several exports arrive together the newest one wins.
  for (const id of ids.filter(i => !seen.has(i)).reverse()) {
    try {
      const { data: msg } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const text = bodyText(msg.payload);
      let csvPart = null;
      walk(msg.payload, part => {
        if (!csvPart && part.filename && /\.csv$/i.test(part.filename) && (part.body?.attachmentId || part.body?.data)) csvPart = part;
      });
      if (!csvPart) { await logResult(id, null, 'skipped', 'no CSV attachment'); continue; }

      const member = await findMember(p.id, msg.payload, text);
      if (!member) { await logResult(id, null, 'skipped', `sender not a member: ${headerOf(msg.payload, 'From')}`); continue; }

      const asOf = exportDate(text) || new Date(parseInt(msg.internalDate, 10));
      if (!force.includes(id) && member.last_foreflight_import_at && asOf < new Date(member.last_foreflight_import_at) - 86400000) {
        await logResult(id, member.id, 'skipped', `export dated ${asOf.toISOString().slice(0, 10)} is older than the last import`);
        continue;
      }

      let buffer;
      if (csvPart.body.attachmentId) {
        const { data: att } = await gmail.users.messages.attachments.get({ userId: 'me', messageId: id, id: csvPart.body.attachmentId });
        buffer = Buffer.from(att.data, 'base64url');
      } else {
        buffer = Buffer.from(csvPart.body.data, 'base64url');
      }
      if (!buffer.toString('utf8').includes('Flights Table')) {
        await logResult(id, member.id, 'skipped', `${csvPart.filename} is not a ForeFlight logbook export`);
        continue;
      }

      const r = await recordForeflightImport({ userId: member.id, partnershipId: p.id, buffer });
      await logResult(id, member.id, 'imported',
        `${member.name}: ${r.imported} flights through ${r.lastFlightDate}${r.manualCleared ? `, ${r.manualCleared} manual entries cleared` : ''}`);
      imported++;
    } catch (err) {
      await logResult(id, null, 'error', err.message).catch(() => {});
    }
  }
  return { imported };
}

function initCron() {
  const run = () => pollEmails().catch(err => console.error('[foreflight-email] poll failed:', err.message));
  setTimeout(run, 45000);
  cron.schedule('20 * * * *', run); // hourly
}

module.exports = { initCron, pollEmails, findMember, walk };
