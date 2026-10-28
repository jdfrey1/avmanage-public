const { google } = require('googleapis');
const googleAuth = require('./googleAuth');

// Sends report/alert emails from the shared Google account via the Gmail API, reusing the
// same OAuth grant as Calendar/Drive — no separate SMTP credentials. The googleapis library
// has no send(to, subject, html) convenience helper for Gmail; it wants a base64url-encoded
// raw RFC 2822 message, hand-built here since reports are HTML-only with no attachments.

async function getGmailClient() {
  const client = await googleAuth.getAuthorizedOAuth2Client();
  return google.gmail({ version: 'v1', auth: client });
}

// RFC 2047 encoded-word — a raw non-ASCII Subject header (e.g. an em dash) gets mangled by
// mail clients that assume Latin-1 unless it's wrapped like this.
function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}

function buildRawMessage({ to, subject, html }) {
  const toHeader = Array.isArray(to) ? to.join(', ') : to;
  const message = [
    `To: ${toHeader}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ].join('\r\n');

  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// to: a single email address or an array of addresses (all in one message's To: header).
async function sendMail({ to, subject, html }) {
  const gmail = await getGmailClient();
  const raw = buildRawMessage({ to, subject, html });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// Address of the connected Google account itself — copied on the monthly report so the
// shared account keeps its own record. Null if it can't be read (e.g. not connected).
async function getAccountEmail() {
  try {
    const gmail = await getGmailClient();
    const { data } = await gmail.users.getProfile({ userId: 'me' });
    return data.emailAddress || null;
  } catch {
    return null;
  }
}

module.exports = { sendMail, getAccountEmail };
