const { google } = require('googleapis');
const pool = require('../db');
const googleAuth = require('./googleAuth');
const { parseGarminLog } = require('./garminLog');
const { storeGarminLog } = require('./garminImport');
const { findMember, walk } = require('./foreflightEmail');

// Imports Garmin avionics data logs that members send to the shared Gmail account from Garmin
// Pilot (files named like 2026-11-10-KBIV-8D4.csv). Runs right after each FlightAware sync. The
// sender must be a partnership member; each email is processed once (garmin_email_imports), and
// a log already stored (e.g. uploaded by hand, or the other half of a split export) is skipped.

const QUERY = 'has:attachment filename:csv';
const isGarminCsv = (buf) => buf.subarray(0, 200).toString('utf8').includes('#airframe_info');

async function logResult(msgId, userId, status, detail) {
  await pool.query(
    `INSERT INTO garmin_email_imports (msg_id, user_id, status, detail) VALUES ($1, $2, $3, $4)
     ON CONFLICT (msg_id) DO UPDATE SET user_id = $2, status = $3, detail = $4, created_at = NOW()`,
    [msgId, userId, status, detail]);
  console.log(`[garmin-email] ${msgId}: ${status}${detail ? ` — ${detail}` : ''}`);
}

async function pollEmails(days = 14) {
  if (!(await googleAuth.isConnected())) return { skipped: 'google not connected' };
  const { rows: [p] } = await pool.query('SELECT id FROM partnerships LIMIT 1');
  if (!p) return { skipped: 'no partnership' };
  const gmail = google.gmail({ version: 'v1', auth: await googleAuth.getAuthorizedOAuth2Client() });

  const { data } = await gmail.users.messages.list({ userId: 'me', q: `${QUERY} newer_than:${days}d`, maxResults: 50 });
  const ids = (data.messages || []).map(m => m.id);
  if (!ids.length) return { imported: 0 };
  const [{ rows: done }, { rows: ff }] = await Promise.all([
    pool.query('SELECT msg_id FROM garmin_email_imports WHERE msg_id = ANY($1)', [ids]),
    pool.query("SELECT msg_id FROM foreflight_email_imports WHERE msg_id = ANY($1) AND status = 'imported'", [ids]),
  ]);
  const seen = new Set([...done, ...ff].map(r => r.msg_id));

  let imported = 0;
  for (const id of ids.filter(i => !seen.has(i)).reverse()) {
    try {
      const { data: msg } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const parts = [];
      walk(msg.payload, part => {
        if (part.filename && /\.csv$/i.test(part.filename) && (part.body?.attachmentId || part.body?.data)) parts.push(part);
      });

      // Download and parse every CSV; keep only Garmin data logs.
      const logs = [];
      for (const part of parts) {
        const buffer = part.body.attachmentId
          ? Buffer.from((await gmail.users.messages.attachments.get({ userId: 'me', messageId: id, id: part.body.attachmentId })).data.data, 'base64url')
          : Buffer.from(part.body.data, 'base64url');
        if (!isGarminCsv(buffer)) continue;
        logs.push({ name: part.filename.replace(/(\.csv)+$/i, '.csv'), buffer, log: parseGarminLog(buffer.toString('utf8'), part.filename) });
      }
      if (!logs.length) { await logResult(id, null, 'skipped', 'no Garmin data log attached'); continue; }

      const member = await findMember(p.id, msg.payload, '');
      if (!member) { await logResult(id, null, 'skipped', `sender not a member: ${(msg.payload.headers || []).find(h => h.name === 'From')?.value}`); continue; }

      // A split export (…_1.csv, …_2.csv) is one engine run recorded twice; keep the longest.
      const byRun = new Map();
      for (const l of logs) {
        const key = l.log.engine_on_at?.getTime() ?? l.log.started_at.getTime();
        const prev = byRun.get(key);
        if (!prev || l.log.ended_at - l.log.started_at > prev.log.ended_at - prev.log.started_at) byRun.set(key, l);
      }

      const notes = [];
      for (const l of byRun.values()) {
        const r = await storeGarminLog({ partnershipId: p.id, userId: member.id, name: l.name, buffer: l.buffer, log: l.log });
        notes.push(`${l.name}: ${r.status}`);
        if (r.status !== 'duplicate') imported++;
      }
      await logResult(id, member.id, 'imported', `${member.name}: ${notes.join('; ')}`);
    } catch (err) {
      await logResult(id, null, 'error', err.message).catch(() => {});
    }
  }
  return { imported };
}

module.exports = { pollEmails };
