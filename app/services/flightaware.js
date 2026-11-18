const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const cron = require('node-cron');
const pool = require('../db');
const googleAuth = require('./googleAuth');

// Reads FlightAware alert emails ("N12345 departed KABC at 02:16PM EDT" / "... arrived at ...")
// from the shared Gmail account (gmail.readonly), pairs each departure with its arrival into
// one flightaware_flights row, matches it to a logged flight where possible, and — if an
// AeroAPI key is configured — saves the flight track. Plain regex parsing; no AI, no API cost
// except the optional per-flight AeroAPI fetch (~$0.017, well inside the free monthly credit).

// Kept on the uploads volume so the key survives the container being recreated.
const SETTINGS_FILE = process.env.FLIGHTAWARE_SETTINGS_FILE || path.join(process.env.UPLOADS_DIR || '/data/uploads', '.flightaware-settings.json');
const LEGACY_SETTINGS_FILE = '/data/.flightaware-settings.json';
const LOCAL_TZ = process.env.APP_TIMEZONE || 'America/New_York';
const TZ_OFFSETS = { EDT: -4, EST: -5, CDT: -5, CST: -6, MDT: -6, MST: -7, PDT: -7, PST: -8, UTC: 0, GMT: 0, Z: 0 };
const TRACK_WINDOW_MS = 9 * 86400000; // AeroAPI Personal tier has no historical data (~10 days)
const MAX_TRACK_TRIES = 5;

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* fall through */ }
  // Older versions kept the file outside any volume; carry it over once.
  try {
    const legacy = fs.readFileSync(LEGACY_SETTINGS_FILE, 'utf8');
    fs.writeFileSync(SETTINGS_FILE, legacy, { mode: 0o600 });
    return JSON.parse(legacy);
  } catch { return {}; }
}
function getApiKey() { return process.env.FLIGHTAWARE_API_KEY || readSettings().apiKey || null; }
function saveApiKey(key) {
  const s = readSettings();
  if (key) s.apiKey = key; else delete s.apiKey;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s), { mode: 0o600 });
}

// "02:16PM" + "EDT" on the day nearest to `refMs` -> epoch ms. The email only has a local clock
// time, so pick whichever calendar day puts it closest to when the email was sent.
function resolveTime(clock, tzAbbr, refMs) {
  const m = /^(\d{1,2}):(\d{2})([AP])M$/i.exec(clock);
  if (!m || !(tzAbbr in TZ_OFFSETS)) return null;
  let h = parseInt(m[1]) % 12; if (m[3].toUpperCase() === 'P') h += 12;
  const ref = new Date(refMs);
  let best = null;
  for (const dayShift of [-1, 0, 1]) {
    const t = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate() + dayShift, h - TZ_OFFSETS[tzAbbr], parseInt(m[2]));
    if (best === null || Math.abs(t - refMs) < Math.abs(best - refMs)) best = t;
  }
  return best;
}

// Returns { kind: 'dep'|'arr', tail, airport, from?, clock/time..., enRouteMin?, url } or null.
function parseAlert(text, internalMs) {
  const first = text.split('\n')[0].trim();
  const url = (/https:\/\/www\.flightaware\.com\/live\/flight\/\S+/.exec(text) || [])[0] || null;
  let m = /^(N\w+)(?: \([^)]*\))? departed (.+?) \((\w+)\) at (\d{1,2}:\d{2}[AP]M) ([A-Z]{1,4})\b/.exec(first);
  if (m) {
    let off = null;
    const u = url && /\/history\/(\d{4})(\d{2})(\d{2})\/(\d{2})(\d{2})Z/.exec(url);
    if (u) off = Date.UTC(+u[1], +u[2] - 1, +u[3], +u[4], +u[5]); // exact, from the link
    if (off === null) off = resolveTime(m[4], m[5], internalMs);
    return off === null ? null : { kind: 'dep', tail: m[1], airport: m[3], time: off, url };
  }
  m = /^(N\w+)(?: \([^)]*\))? arrived at (.+?) \((\w+)\) at (\d{1,2}:\d{2}[AP]M) ([A-Z]{1,4})\b(?: from (.+?) \((\w+)\))?(?: after (\d+):(\d{2}) en route)?/.exec(first);
  if (m) {
    const on = resolveTime(m[4], m[5], internalMs);
    return on === null ? null : {
      kind: 'arr', tail: m[1], airport: m[3], from: m[7] || null, time: on, url,
      enRouteMin: m[8] != null ? parseInt(m[8]) * 60 + parseInt(m[9]) : null,
    };
  }
  return null;
}

function plainText(payload) {
  const parts = [];
  (function walk(p) {
    if (p.body?.data && p.mimeType === 'text/plain') parts.push(Buffer.from(p.body.data, 'base64url').toString('utf8'));
    (p.parts || []).forEach(walk);
  })(payload);
  return parts.join('\n');
}

async function applyAlert(partnershipId, msgId, a) {
  if (a.kind === 'dep') {
    await pool.query(
      `INSERT INTO flightaware_flights (partnership_id, tail, dep_msg_id, origin, off_time, url)
       VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),$6) ON CONFLICT (dep_msg_id) DO NOTHING`,
      [partnershipId, a.tail, msgId, a.airport, a.time, a.url]);
    return;
  }
  // Arrival: pair with the latest unpaired departure from the airport it flew from, within 24h.
  const { rows: [dep] } = await pool.query(
    `SELECT id FROM flightaware_flights
     WHERE partnership_id = $1 AND tail = $2 AND arr_msg_id IS NULL AND off_time IS NOT NULL
       AND ($3::text IS NULL OR origin = $3)
       AND off_time < to_timestamp($4/1000.0) AND off_time > to_timestamp($4/1000.0) - interval '24 hours'
     ORDER BY off_time DESC LIMIT 1`,
    [partnershipId, a.tail, a.from, a.time]);
  if (dep) {
    await pool.query(
      `UPDATE flightaware_flights SET arr_msg_id = $2, destination = $3, on_time = to_timestamp($4/1000.0), en_route_min = $5
       WHERE id = $1`, [dep.id, msgId, a.airport, a.time, a.enRouteMin]);
  } else {
    await pool.query(
      `INSERT INTO flightaware_flights (partnership_id, tail, arr_msg_id, origin, destination, on_time, en_route_min, url)
       VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7,$8) ON CONFLICT (arr_msg_id) DO NOTHING`,
      [partnershipId, a.tail, msgId, a.from, a.airport, a.time, a.enRouteMin, a.url]);
  }
}

// Pull new alert emails for this aircraft. days = how far back to look.
async function pollEmails(days = 3) {
  if (!(await googleAuth.isConnected())) return { skipped: 'google not connected' };
  const { rows: [p] } = await pool.query('SELECT id, aircraft_tail FROM partnerships LIMIT 1');
  if (!p?.aircraft_tail) return { skipped: 'no aircraft tail' };
  const client = await googleAuth.getAuthorizedOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth: client });

  const ids = [];
  let pageToken;
  do {
    const { data } = await gmail.users.messages.list({
      userId: 'me', q: `from:alerts@flightaware.com subject:${p.aircraft_tail} newer_than:${days}d`, maxResults: 100, pageToken,
    });
    ids.push(...(data.messages || []).map(m => m.id));
    pageToken = data.nextPageToken;
  } while (pageToken);

  const { rows: known } = await pool.query(
    'SELECT dep_msg_id, arr_msg_id FROM flightaware_flights WHERE dep_msg_id = ANY($1) OR arr_msg_id = ANY($1)', [ids]);
  const seen = new Set(known.flatMap(r => [r.dep_msg_id, r.arr_msg_id]));
  const fresh = [];
  for (const id of ids.filter(i => !seen.has(i))) {
    const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const a = parseAlert(plainText(data.payload), parseInt(data.internalDate));
    if (a && a.tail.toUpperCase() === p.aircraft_tail.toUpperCase()) fresh.push({ id, a, ms: parseInt(data.internalDate) });
  }
  fresh.sort((x, y) => x.ms - y.ms); // departures before their arrivals
  for (const f of fresh) await applyAlert(p.id, f.id, f.a);
  return { checked: ids.length, added: fresh.length };
}

const stripCode = (c) => (c || '').toUpperCase().replace(/^K(?=[A-Z0-9]{3}$)/, '');
const legHours = (ff) => (ff.en_route_min ?? Math.round((ff.on_time - ff.off_time) / 60000)) / 60;
const TAXI_HRS = 0.1; // meter time per leg beyond wheels-off to wheels-on

// How badly a run of legs fits a logged flight: meter-time mismatch, plus a penalty when the
// route names airports and none of the legs touch them. Infinity if the leg was detached from it.
function groupCost(flight, legs) {
  if (legs.some(l => l.detached_flight_id === flight.id)) return Infinity;
  const hrs = legs.reduce((t, l) => t + legHours(l) + TAXI_HRS, 0);
  const diff = flight.flight_time == null ? 0.5 : Math.abs(flight.flight_time - hrs);
  const tokens = (flight.route || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).map(stripCode);
  const codes = legs.flatMap(l => [stripCode(l.origin), stripCode(l.destination)]).filter(Boolean);
  const named = tokens.filter(t => /^[A-Z0-9]{3,4}$/.test(t) && /\d|^[A-Z]{3}$/.test(t));
  const routeHit = codes.some(c => tokens.includes(c));
  return { diff, routeHit, cost: diff + (named.length && !routeHit ? 0.3 : 0) };
}

// Split one day's legs (in time order) into consecutive runs, one per flight (in meter order),
// minimising the total mismatch. A flight may get no legs (cost = its whole flight time).
function assignDay(flights, legs) {
  const F = flights.length, L = legs.length;
  const best = Array.from({ length: F + 1 }, () => Array(L + 1).fill(Infinity));
  const from = Array.from({ length: F + 1 }, () => Array(L + 1).fill(-1));
  best[0][0] = 0;
  for (let j = 1; j <= F; j++) {
    for (let i = 0; i <= L; i++) {
      for (let k = 0; k <= i; k++) {
        if (best[j - 1][k] === Infinity) continue;
        const g = k === i ? { cost: flights[j - 1].flight_time ?? 1 } : groupCost(flights[j - 1], legs.slice(k, i));
        const c = g === Infinity ? Infinity : best[j - 1][k] + g.cost;
        if (c < best[j][i]) { best[j][i] = c; from[j][i] = k; }
      }
    }
  }
  // Legs that fit no flight are left at the end; take the best i with a leftover penalty.
  let end = L, score = Infinity;
  for (let i = 0; i <= L; i++) {
    const s = best[F][i] + (L - i) * 0.6;
    if (s < score) { score = s; end = i; }
  }
  const out = [];
  for (let j = F, i = end; j > 0; j--) {
    const k = from[j][i];
    if (k < i) out.push({ flight: flights[j - 1], legs: legs.slice(k, i) });
    i = k;
  }
  return out;
}

// Attach complete, unattached FlightAware legs to the logged flights they describe. Each local
// day is matched as a whole: that day's legs (by takeoff time) are split across the day's flights
// without legs yet (by meter start), so each flight gets the run of legs whose airborne time best
// fits its meter time. A leftover leg can still join an earlier leg's flight as a later leg of the
// same outing (departs where that leg landed, within 4 hours).
async function matchFlights() {
  const { rows: pending } = await pool.query(
    `SELECT id, partnership_id, origin, destination, off_time, on_time, en_route_min, detached_flight_id,
            (off_time AT TIME ZONE '${LOCAL_TZ}')::date::text AS local_date
     FROM flightaware_flights WHERE flight_id IS NULL AND NOT ignored AND off_time IS NOT NULL AND on_time IS NOT NULL
     ORDER BY off_time`);
  const days = new Map();
  for (const ff of pending) {
    const k = `${ff.partnership_id}|${ff.local_date}`;
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(ff);
  }
  let matched = 0;
  const attach = async (legId, flightId) => {
    const r = await pool.query('UPDATE flightaware_flights SET flight_id = $2 WHERE id = $1 AND flight_id IS NULL', [legId, flightId]);
    matched += r.rowCount;
  };
  for (const legs of days.values()) {
    const { partnership_id, local_date } = legs[0];
    const { rows: flights } = await pool.query(
      `SELECT f.id, f.route, f.flight_time::float AS flight_time FROM flights f
       WHERE f.partnership_id = $1 AND f.flight_date = $2
         AND NOT EXISTS (SELECT 1 FROM flightaware_flights x WHERE x.flight_id = f.id)
       ORDER BY COALESCE(f.hobbs_start, f.tach_start), f.created_at`,
      [partnership_id, local_date]);
    const used = new Set();
    for (const { flight, legs: group } of assignDay(flights, legs)) {
      const g = groupCost(flight, group);
      // Accept a plausible fit; a lone flight that day takes whatever is left.
      if (g !== Infinity && (g.routeHit || g.diff <= 0.5 || flights.length === 1)) {
        for (const l of group) { await attach(l.id, flight.id); used.add(l.id); }
      }
    }
    for (const ff of legs.filter(l => !used.has(l.id))) {
      const { rows: [cont] } = await pool.query(
        `SELECT x.flight_id FROM flightaware_flights x
         WHERE x.partnership_id = $1 AND x.flight_id IS NOT NULL AND x.flight_id IS DISTINCT FROM $2 AND x.id <> $3
           AND upper(x.destination) = upper($4) AND x.on_time <= $5 AND x.on_time > $5::timestamptz - interval '4 hours'
         ORDER BY x.on_time DESC LIMIT 1`,
        [partnership_id, ff.detached_flight_id, ff.id, ff.origin || '', ff.off_time]);
      if (cont) await attach(ff.id, cont.flight_id);
    }
  }
  return matched;
}

// ── AeroAPI track fetch ──────────────────────────────────────────────────────
const AERO = 'https://aeroapi.flightaware.com/aeroapi';
async function aero(path, key) {
  const res = await fetch(AERO + path, { headers: { 'x-apikey': key, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`AeroAPI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function fetchTrack(ff, key) {
  const start = new Date(+ff.off_time - 3600000).toISOString();
  const end = new Date(+(ff.on_time || ff.off_time) + 3600000).toISOString();
  const list = await aero(`/flights/${encodeURIComponent(ff.tail)}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, key);
  const offMs = +ff.off_time;
  const flight = (list.flights || [])
    .filter(f => f.actual_off)
    .sort((a, b) => Math.abs(Date.parse(a.actual_off) - offMs) - Math.abs(Date.parse(b.actual_off) - offMs))[0];
  if (!flight || Math.abs(Date.parse(flight.actual_off) - offMs) > 20 * 60000) return { status: 'unavailable' };
  const t = await aero(`/flights/${encodeURIComponent(flight.fa_flight_id)}/track`, key);
  // AeroAPI reports altitude in hundreds of feet, groundspeed in knots.
  const track = (t.positions || []).map(p => ({
    t: Math.floor(Date.parse(p.timestamp) / 1000), lat: p.latitude, lon: p.longitude,
    alt: p.altitude != null ? p.altitude * 100 : null, gs: p.groundspeed ?? null,
  }));
  return { status: track.length ? 'ok' : 'unavailable', faFlightId: flight.fa_flight_id, track };
}

async function fetchPendingTracks() {
  const key = getApiKey();
  if (!key) return 0;
  const { rows } = await pool.query(
    `SELECT id, tail, off_time, on_time FROM flightaware_flights
     WHERE on_time IS NOT NULL AND off_time IS NOT NULL AND track IS NULL
       AND COALESCE(track_status, '') <> 'unavailable' AND track_tries < $1
       AND off_time > now() - ($2 || ' milliseconds')::interval`, [MAX_TRACK_TRIES, String(TRACK_WINDOW_MS)]);
  let n = 0;
  for (const ff of rows) {
    try {
      const r = await fetchTrack(ff, key);
      await pool.query(
        `UPDATE flightaware_flights SET track = $2, track_status = $3, fa_flight_id = $4, track_tries = track_tries + 1, track_fetched_at = now() WHERE id = $1`,
        [ff.id, r.track ? JSON.stringify(r.track) : null, r.status, r.faFlightId || null]);
      if (r.status === 'ok') n++;
    } catch (err) {
      console.error('[flightaware] track fetch failed:', err.message);
      await pool.query(`UPDATE flightaware_flights SET track_status = $2, track_tries = track_tries + 1 WHERE id = $1`, [ff.id, 'error: ' + err.message.slice(0, 120)]);
    }
  }
  return n;
}

async function sync(days = 3) {
  const polled = await pollEmails(days);
  const matched = await matchFlights();
  const tracks = await fetchPendingTracks();
  return { ...polled, matched, tracks };
}

function initCron() {
  // Garmin Pilot data logs emailed to the same inbox are picked up on the same schedule.
  const garminEmail = require('./garminEmail');
  const run = async () => {
    await sync().catch(err => console.error('[flightaware] sync failed:', err.message));
    await garminEmail.pollEmails().catch(err => console.error('[garmin-email] poll failed:', err.message));
  };
  setTimeout(run, 30000);
  cron.schedule('*/15 * * * *', run);
}

module.exports = { initCron, sync, matchFlights, getApiKey, saveApiKey, parseAlert, fetchTrack };
