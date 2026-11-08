const { google } = require('googleapis');
const { Readable } = require('stream');
const pool = require('../db');
const googleAuth = require('./googleAuth');

// Archives app-uploaded files into a folder structure on the shared Google account's Drive,
// using the narrow drive.file scope (the app can only see/touch files & folders it creates
// itself). Folder IDs are created once at connect-time and persisted — see docs/DEVELOPMENT.md
// for why this isn't a find-or-create-per-upload lookup.

const FOLDER_NAMES = {
  documents: 'Aircraft Documents',
  logbooks: 'Logbooks',
  maintenance: 'Maintenance',
  invoices: 'Invoices',
  flightPhotos: 'Flight Photos',
  foreflight: 'ForeFlight Imports',
  garminLogs: 'Garmin Data Logs',
  backups: 'Database Backups',
};

async function getDriveClient() {
  const client = await googleAuth.getAuthorizedOAuth2Client();
  return google.drive({ version: 'v3', auth: client });
}

async function createFolder(drive, name, parentId) {
  const { data } = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    },
    fields: 'id',
  });
  return data.id;
}

// Creates the root "<tail>" folder plus the fixed set of subfolders, once, right after a
// successful connect. Idempotent: it only ever creates subfolders whose key isn't recorded yet
// (re-creating existing ones would duplicate them, since Drive doesn't enforce name uniqueness
// and drive.file scope has no reliable way to "adopt" folders it didn't itself just create).
async function ensureFolderStructure() {
  const config = await googleAuth.getConfig();
  if (!config) throw Object.assign(new Error('Google integration is not configured'), { status: 503 });
  if (config.drive_root_folder_id && config.drive_folder_ids) {
    // Add any subfolder introduced after the original connect (e.g. Invoices).
    const missing = Object.entries(FOLDER_NAMES).filter(([key]) => !config.drive_folder_ids[key]);
    if (missing.length === 0) return config.drive_folder_ids;
    const drive = await getDriveClient();
    const folderIds = { ...config.drive_folder_ids };
    for (const [key, name] of missing) folderIds[key] = await createFolder(drive, name, config.drive_root_folder_id);
    await pool.query('UPDATE google_calendar_config SET drive_folder_ids = $1 WHERE id = 1', [JSON.stringify(folderIds)]);
    return folderIds;
  }

  const { rows: [partnership] } = await pool.query('SELECT aircraft_tail FROM partnerships LIMIT 1');
  const rootName = partnership?.aircraft_tail || 'avManage';

  const drive = await getDriveClient();
  const rootId = await createFolder(drive, rootName, null);

  const folderIds = {};
  for (const [key, name] of Object.entries(FOLDER_NAMES)) {
    folderIds[key] = await createFolder(drive, name, rootId);
  }

  await pool.query(
    `UPDATE google_calendar_config SET drive_root_folder_id = $1, drive_folder_ids = $2 WHERE id = 1`,
    [rootId, JSON.stringify(folderIds)]
  );
  return folderIds;
}

// Uploads a buffer into one of the fixed subfolders. folderKey must be one of FOLDER_NAMES'
// keys. Returns the new Drive file id.
async function uploadFile(folderKey, { name, mimeType, buffer }) {
  const config = await googleAuth.getConfig();
  const folderId = config?.drive_folder_ids?.[folderKey];
  if (!folderId) throw new Error(`Drive folder "${folderKey}" not set up yet — connect Google in Settings first`);

  const drive = await getDriveClient();
  const { data } = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id',
  });
  return data.id;
}

// Names of the (non-trashed) files already in one of the fixed subfolders — lets the backfill
// script skip things that were uploaded before. drive.file scope only lists files this app made.
async function listFileNames(folderKey) {
  const config = await googleAuth.getConfig();
  const folderId = config?.drive_folder_ids?.[folderKey];
  if (!folderId) throw new Error(`Drive folder "${folderKey}" not set up yet`);
  const drive = await getDriveClient();
  const names = new Set();
  let pageToken;
  do {
    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(name)', pageSize: 200, pageToken,
    });
    data.files.forEach(f => names.add(f.name));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return names;
}

async function renameFile(fileId, name) {
  const drive = await getDriveClient();
  await drive.files.update({ fileId, requestBody: { name } });
}

module.exports = { ensureFolderStructure, uploadFile, renameFile, listFileNames, FOLDER_NAMES };
