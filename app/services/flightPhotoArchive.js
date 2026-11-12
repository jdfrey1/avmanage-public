// Archives a flight's gauge photo to the shared Google Drive "Flight Photos" folder, named
// "<date> - <pilot> - <route>.<ext>" so it can be found by eye. Runs after a flight is saved
// (the photo is read before the flight exists), and renames the Drive copy when the date,
// pilot or route change later. Best-effort: Drive problems are logged, never surfaced.
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const googleAuth = require('./googleAuth');
const googleDrive = require('./googleDrive');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', gif: 'image/gif' };

function photoName(f) {
  const ext = path.extname(f.ocr_source_image_key) || '.jpg';
  const parts = [f.flight_date, f.pilot, f.route?.trim()].filter(Boolean)
    .map(p => p.replace(/[/\\:*?"<>|]+/g, '-'));
  return `${parts.join(' - ')}${ext}`;
}

async function archiveFlightPhoto(flightId) {
  if (!(await googleAuth.isConnected())) return;
  const { rows: [f] } = await pool.query(`
    SELECT f.id, TO_CHAR(f.flight_date, 'YYYY-MM-DD') AS flight_date, f.route, f.ocr_source_image_key, f.drive_file_id,
           COALESCE(f.pilot_name, u.name) AS pilot
      FROM flights f JOIN users u ON u.id = f.pilot_id WHERE f.id = $1`, [flightId]);
  if (!f?.ocr_source_image_key) return;
  const name = photoName(f);

  let fileId = f.drive_file_id;
  if (!fileId) {
    // Photos uploaded before this change were named by their storage key.
    fileId = await googleDrive.findFileId('flightPhotos', f.ocr_source_image_key);
    if (!fileId) {
      const file = path.join(UPLOADS_DIR, f.ocr_source_image_key);
      if (!fs.existsSync(file)) return;
      const ext = path.extname(file).slice(1).toLowerCase();
      fileId = await googleDrive.uploadFile('flightPhotos', {
        name, mimeType: MIME[ext] || 'application/octet-stream', buffer: fs.readFileSync(file),
      });
    }
    await pool.query('UPDATE flights SET drive_file_id = $1 WHERE id = $2', [fileId, f.id]);
  }
  await googleDrive.renameFile(fileId, name);
}

function archiveFlightPhotoSoon(flightId) {
  archiveFlightPhoto(flightId).catch(err => console.error(`Drive sync failed for flight photo ${flightId}:`, err.message));
}

module.exports = { archiveFlightPhoto, archiveFlightPhotoSoon };
