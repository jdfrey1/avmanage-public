const pool = require('../db');

const LOCAL_TZ = process.env.APP_TIMEZONE || 'America/New_York';

// Pick the logged flight for a log: same local date as engine start; with several flights that
// day, prefer one whose FlightAware leg falls inside this engine run, then one whose route names
// the departure or arrival airport. Never re-picks a flight the log was detached from.
async function findFlight(partnershipId, log, excludeFlightId = null) {
  const at = log.engine_on_at || log.started_at;
  const { rows: cands } = await pool.query(
    `SELECT f.id, f.route,
       EXISTS (SELECT 1 FROM flightaware_flights ff WHERE ff.flight_id = f.id) AS has_fa,
       EXISTS (SELECT 1 FROM flightaware_flights ff WHERE ff.flight_id = f.id
               AND ff.off_time BETWEEN $3::timestamptz - interval '15 minutes' AND $4::timestamptz) AS fa_hit
     FROM flights f
     WHERE f.partnership_id = $1 AND f.flight_date = ($2::timestamptz AT TIME ZONE '${LOCAL_TZ}')::date
       AND f.id IS DISTINCT FROM $5`,
    [partnershipId, at, log.started_at, log.ended_at, excludeFlightId]);
  // A lone flight that day still has to fit: if it has FlightAware legs, one must be in this run.
  if (cands.length === 1) return !cands[0].has_fa || cands[0].fa_hit ? cands[0].id : null;
  const fa = cands.filter(c => c.fa_hit);
  if (fa.length === 1) return fa[0].id;
  const strip = (c) => (c || '').toUpperCase().replace(/^K(?=[A-Z0-9]{3}$)/, '');
  const codes = [strip(log.origin), strip(log.destination)].filter(Boolean);
  const byRoute = cands.filter(c => {
    const tokens = (c.route || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).map(strip);
    return codes.some(code => tokens.includes(code));
  });
  return byRoute.length === 1 ? byRoute[0].id : null;
}

// Re-run matching for unmatched logs, e.g. after the flight they belong to is logged.
async function matchUnattached(partnershipId) {
  const { rows } = await pool.query(
    `SELECT id, started_at, ended_at, engine_on_at, origin, destination, detached_flight_id
     FROM garmin_data_logs WHERE partnership_id = $1 AND flight_id IS NULL`, [partnershipId]);
  let n = 0;
  for (const log of rows) {
    const flightId = await findFlight(partnershipId, log, log.detached_flight_id);
    if (flightId) { await pool.query('UPDATE garmin_data_logs SET flight_id = $2 WHERE id = $1 AND flight_id IS NULL', [log.id, flightId]); n++; }
  }
  return n;
}

module.exports = { findFlight, matchUnattached };
