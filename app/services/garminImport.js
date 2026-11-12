const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pool = require('../db');
const googleAuth = require('./googleAuth');
const googleDrive = require('./googleDrive');
const { parseGarminLog } = require('./garminLog');
const { findFlight } = require('./garminMatch');

// Stores one Garmin avionics data log (from an upload or an emailed Garmin Pilot export):
// the gzipped CSV on disk, the parsed summary and series in garmin_data_logs, and a copy on Drive.

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

// Summary columns returned everywhere (never the bulky series).
const SUMMARY = `id, flight_id, filename, started_at, ended_at, engine_on_at, engine_off_at, takeoff_at, landing_at,
  engine_hrs::float, air_hrs::float, fuel_used_gal::float, fuel_start_gal::float, fuel_end_gal::float,
  origin, destination, max_cht::float, max_cht_cyl, stats`;

async function archiveToDrive(id, name, buffer) {
  if (!(await googleAuth.isConnected())) return;
  try {
    await googleDrive.ensureFolderStructure(); // adds the Garmin folder on installs connected before it existed
    const fileId = await googleDrive.uploadFile('garminLogs', { name, mimeType: 'text/csv', buffer });
    await pool.query('UPDATE garmin_data_logs SET drive_file_id = $2 WHERE id = $1', [id, fileId]);
  } catch (err) {
    console.error(`Drive sync failed for Garmin log ${name}:`, err.message);
  }
}

// An already-stored copy of this engine run: same start of recording, or the same engine start
// (Garmin Pilot can hand over one run as two files a few seconds apart).
async function findDuplicate(partnershipId, log) {
  const { rows: [dup] } = await pool.query(
    `SELECT ${SUMMARY} FROM garmin_data_logs
      WHERE partnership_id = $1 AND (started_at = $2 OR ($3::timestamptz IS NOT NULL AND engine_on_at = $3))
      LIMIT 1`,
    [partnershipId, log.started_at, log.engine_on_at]);
  return dup || null;
}

// log: from parseGarminLog. flightId: attach to this flight; undefined → match by date/route;
// null → leave unattached. Returns { status: 'duplicate' | 'attached' | 'unmatched', log }.
async function storeGarminLog({ partnershipId, userId, name, buffer, log, flightId }) {
  log = log || parseGarminLog(buffer.toString('utf8'), name);
  const dup = await findDuplicate(partnershipId, log);
  if (dup) return { status: 'duplicate', log: dup };

  const fid = flightId === undefined ? await findFlight(partnershipId, log) : flightId;
  const fileKey = `garmin/${log.started_at.toISOString().replace(/[:.]/g, '-')}_${(log.origin || 'log').replace(/\W/g, '')}.csv.gz`;
  fs.mkdirSync(path.join(UPLOADS_DIR, 'garmin'), { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, fileKey), zlib.gzipSync(buffer));
  const { rows: [row] } = await pool.query(
    `INSERT INTO garmin_data_logs
       (partnership_id, flight_id, filename, file_key, started_at, ended_at, engine_on_at, engine_off_at,
        takeoff_at, landing_at, engine_hrs, air_hrs, fuel_used_gal, fuel_start_gal, fuel_end_gal,
        origin, destination, max_cht, max_cht_cyl, stats, series, meta, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING ${SUMMARY}`,
    [partnershipId, fid, name, fileKey, log.started_at, log.ended_at, log.engine_on_at, log.engine_off_at,
     log.takeoff_at, log.landing_at, log.engine_hrs, log.air_hrs, log.fuel_used_gal, log.fuel_start_gal, log.fuel_end_gal,
     log.origin, log.destination, log.max_cht, log.max_cht_cyl, log.stats, log.series, log.meta, userId]);
  archiveToDrive(row.id, name, buffer); // not awaited: Drive is slow and best-effort
  return { status: fid ? 'attached' : 'unmatched', log: row };
}

module.exports = { storeGarminLog, SUMMARY, UPLOADS_DIR };
