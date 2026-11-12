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

// Folders nested inside one of the top-level folders above: key -> [name, parent key].
// Their ids live in the same drive_folder_ids map, so uploadFile() takes their keys too.
const SUBFOLDERS = {
  oilAnalysis: ['Oil Analysis', 'maintenance'],
  databases: ['Databases', 'maintenance'],
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
    const missingSub = Object.entries(SUBFOLDERS).filter(([key]) => !config.drive_folder_ids[key]);
    if (missing.length === 0 && missingSub.length === 0) return config.drive_folder_ids;
    const drive = await getDriveClient();
    const folderIds = { ...config.drive_folder_ids };
    for (const [key, name] of missing) folderIds[key] = await createFolder(drive, name, config.drive_root_folder_id);
    for (const [key, [name, parent]] of missingSub) folderIds[key] = await createFolder(drive, name, folderIds[parent]);
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
  for (const [key, [name, parent]] of Object.entries(SUBFOLDERS)) {
    folderIds[key] = await createFolder(drive, name, folderIds[parent]);
  }

  await pool.query(
    `UPDATE google_calendar_config SET drive_root_folder_id = $1, drive_folder_ids = $2 WHERE id = 1`,
    [rootId, JSON.stringify(folderIds)]
  );
  return folderIds;
}

// Uploads a buffer into one of the fixed folders. folderKey must be a FOLDER_NAMES or SUBFOLDERS
// key. Returns the new Drive file id.
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

// Id of a (non-trashed) file with this exact name in one of the fixed folders, or null.
async function findFileId(folderKey, name) {
  const config = await googleAuth.getConfig();
  const folderId = config?.drive_folder_ids?.[folderKey];
  if (!folderId) throw new Error(`Drive folder "${folderKey}" not set up yet`);
  const drive = await getDriveClient();
  const quoted = name.replace(/['\\]/g, '\\$&');
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and name = '${quoted}'`,
    fields: 'files(id)', pageSize: 1,
  });
  return data.files[0]?.id ?? null;
}

async function renameFile(fileId, name) {
  const drive = await getDriveClient();
  await drive.files.update({ fileId, requestBody: { name } });
}

// Moves a file the app created into one of the fixed folders (out of whatever folder holds it now).
async function moveFile(fileId, folderKey) {
  const config = await googleAuth.getConfig();
  const folderId = config?.drive_folder_ids?.[folderKey];
  if (!folderId) throw new Error(`Drive folder "${folderKey}" not set up yet`);
  const drive = await getDriveClient();
  const { data } = await drive.files.get({ fileId, fields: 'parents' });
  const from = (data.parents || []).filter(id => id !== folderId).join(',');
  await drive.files.update({ fileId, addParents: folderId, removeParents: from || undefined, fields: 'id, parents' });
}

module.exports = { ensureFolderStructure, uploadFile, findFileId, renameFile, moveFile, listFileNames, FOLDER_NAMES, SUBFOLDERS };
