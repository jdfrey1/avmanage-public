const { google } = require('googleapis');
const googleAuth = require('./googleAuth');

// Calendar-specific event operations on the shared Google account's calendar. OAuth plumbing
// (connect/disconnect/token refresh) lives in googleAuth.js — this module only builds the
// typed Calendar client from it and manages events.

async function getCalendarClient() {
  const config = await googleAuth.getConfig();
  if (!config?.calendar_id) throw Object.assign(new Error('Google Calendar is not configured'), { status: 503 });
  const client = await googleAuth.getAuthorizedOAuth2Client();
  return { calendar: google.calendar({ version: 'v3', auth: client }), calendarId: config.calendar_id };
}

// event: { summary, description, start: {dateTime|date, timeZone}, end: {dateTime|date, timeZone} }
async function createEvent(event) {
  const { calendar, calendarId } = await getCalendarClient();
  const { data } = await calendar.events.insert({ calendarId, requestBody: event });
  return data.id;
}

async function updateEvent(googleEventId, event) {
  const { calendar, calendarId } = await getCalendarClient();
  const { data } = await calendar.events.update({ calendarId, eventId: googleEventId, requestBody: event });
  return data.id;
}

async function deleteEvent(googleEventId) {
  const { calendar, calendarId } = await getCalendarClient();
  try {
    await calendar.events.delete({ calendarId, eventId: googleEventId });
  } catch (err) {
    // Already gone (e.g. deleted manually in Google Calendar) — nothing left to clean up.
    if (err.code !== 404 && err.code !== 410) throw err;
  }
}

module.exports = {
  isConnected: googleAuth.isConnected,
  createEvent, updateEvent, deleteEvent,
};
