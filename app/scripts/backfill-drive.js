const fs = require('fs');
const path = require('path');
const pool = require('../db');
const googleAuth = require('../services/googleAuth');
const googleDrive = require('../services/googleDrive');

// One-time backfill for files that were uploaded before the Google Drive integration existed
// (or before this account was connected) — ongoing uploads sync on write via the app's routes,
// but nothing retroactively syncs pre-existing files. Safe to re-run: skips anything that
// already has a drive_file_id, and CSVs are timestamped so re-running just adds another
// dated copy rather than duplicating today's.

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const BACKUP_DIR = '/data/backups';

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.csv': 'text/csv',
  '.gz': 'application/gzip',
};
function mimeFor(filename) {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

async function backfillDocuments() {
  const { rows } = await pool.query(`SELECT id, title, file_key FROM documents WHERE drive_file_id IS NULL`);
  let count = 0;
  for (const doc of rows) {
    const filepath = path.join(UPLOADS_DIR, doc.file_key);
    if (!fs.existsSync(filepath)) { console.warn(`[documents] missing on disk, skipping: ${filepath}`); continue; }
    // file_key on disk is a random UUID (documents.js generates it to avoid collisions) — use
    // the human-entered title for Drive instead, matching what the live upload route does.
    // Some titles already include the extension (e.g. "Plate.JPG") — don't double it up.
    const ext = path.extname(doc.file_key);
    const name = doc.title.toLowerCase().endsWith(ext.toLowerCase()) ? doc.title : `${doc.title}${ext}`;
    const driveFileId = await googleDrive.uploadFile('documents', { name, mimeType: mimeFor(name), buffer: fs.readFileSync(filepath) });
    await pool.query('UPDATE documents SET drive_file_id = $1 WHERE id = $2', [driveFileId, doc.id]);
    console.log(`[documents] synced: ${doc.title}`);
    count++;
  }
  return count;
}

async function backfillLogbookDocuments() {
  const { rows } = await pool.query(`SELECT id, source_filename, file_key FROM logbook_documents WHERE drive_file_id IS NULL`);
  let count = 0;
  for (const doc of rows) {
    const filepath = path.join(UPLOADS_DIR, doc.file_key);
    if (!fs.existsSync(filepath)) { console.warn(`[logbook_documents] missing on disk, skipping: ${filepath}`); continue; }
    const name = doc.source_filename || path.basename(doc.file_key);
    const driveFileId = await googleDrive.uploadFile('logbooks', { name, mimeType: mimeFor(name), buffer: fs.readFileSync(filepath) });
    await pool.query('UPDATE logbook_documents SET drive_file_id = $1 WHERE id = $2', [driveFileId, doc.id]);
    console.log(`[logbook_documents] synced: ${name}`);
    count++;
  }
  return count;
}

async function backfillMaintenanceAttachments() {
  const { rows } = await pool.query(`SELECT id, original_name, file_key, mime_type FROM maintenance_attachments WHERE drive_file_id IS NULL`);
  let count = 0;
  for (const att of rows) {
    const filepath = path.join(UPLOADS_DIR, att.file_key);
    if (!fs.existsSync(filepath)) { console.warn(`[maintenance_attachments] missing on disk, skipping: ${filepath}`); continue; }
    const name = att.original_name || path.basename(att.file_key);
    const driveFileId = await googleDrive.uploadFile('maintenance', { name, mimeType: att.mime_type || mimeFor(name), buffer: fs.readFileSync(filepath) });
    await pool.query('UPDATE maintenance_attachments SET drive_file_id = $1 WHERE id = $2', [driveFileId, att.id]);
    console.log(`[maintenance_attachments] synced: ${name}`);
    count++;
  }
  return count;
}

async function backfillFlightPhotos() {
  const { rows } = await pool.query(`SELECT id, ocr_source_image_key FROM flights WHERE ocr_source_image_key IS NOT NULL AND drive_file_id IS NULL`);
  let count = 0;
  for (const f of rows) {
    const filepath = path.join(UPLOADS_DIR, f.ocr_source_image_key);
    if (!fs.existsSync(filepath)) { console.warn(`[flights] missing on disk, skipping: ${filepath}`); continue; }
    const name = f.ocr_source_image_key;
    const driveFileId = await googleDrive.uploadFile('flightPhotos', { name, mimeType: mimeFor(name), buffer: fs.readFileSync(filepath) });
    await pool.query('UPDATE flights SET drive_file_id = $1 WHERE id = $2', [driveFileId, f.id]);
    console.log(`[flights] synced photo for flight ${f.id}`);
    count++;
  }
  return count;
}

async function backfillForeflightCsvs() {
  const dir = path.join(UPLOADS_DIR, 'foreflight');
  if (!fs.existsSync(dir)) return 0;
  const existing = await googleDrive.listFileNames('foreflight');
  let count = 0;
  for (const filename of fs.readdirSync(dir)) {
    if (!filename.endsWith('_latest.csv')) continue;
    const userId = filename.replace('_latest.csv', '');
    const { rows: [u] } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    const stamp = new Date().toISOString().slice(0, 10);
    const driveName = `${u?.name || userId} - ForeFlight Import - ${stamp}.csv`;
    if (existing.has(driveName)) { console.log(`[foreflight] already in Drive, skipping: ${driveName}`); continue; }
    const driveFileId = await googleDrive.uploadFile('foreflight', {
      name: driveName, mimeType: 'text/csv', buffer: fs.readFileSync(path.join(dir, filename)),
    });
    console.log(`[foreflight] synced: ${driveName} -> ${driveFileId}`);
    count++;
  }
  return count;
}

async function backfillBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return 0;
  const existing = await googleDrive.listFileNames('backups');
  let count = 0;
  for (const filename of fs.readdirSync(BACKUP_DIR)) {
    if (!filename.endsWith('.sql.gz')) continue;
    if (existing.has(filename)) { console.log(`[backups] already in Drive, skipping: ${filename}`); continue; }
    const driveFileId = await googleDrive.uploadFile('backups', {
      name: filename, mimeType: 'application/gzip', buffer: fs.readFileSync(path.join(BACKUP_DIR, filename)),
    });
    console.log(`[backups] synced: ${filename} -> ${driveFileId}`);
    count++;
  }
  return count;
}

async function main() {
  if (!(await googleAuth.isConnected())) {
    console.error('Google is not connected — nothing to backfill.');
    process.exitCode = 1;
    return;
  }
  const results = {
    documents: await backfillDocuments(),
    logbook_documents: await backfillLogbookDocuments(),
    maintenance_attachments: await backfillMaintenanceAttachments(),
    flight_photos: await backfillFlightPhotos(),
    foreflight_csvs: await backfillForeflightCsvs(),
    backups: await backfillBackups(),
  };
  console.log('Backfill complete:', results);
}

if (require.main === module) {
  main().finally(() => pool.end());
}

module.exports = { backfillDocuments, backfillLogbookDocuments, backfillMaintenanceAttachments, backfillFlightPhotos, backfillForeflightCsvs, backfillBackups };
