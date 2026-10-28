const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const multer = require('multer');
const requireAuth = require('../middleware/requireAuth');
const backupCron = require('../services/backupCron');
const googleDrive = require('../services/googleDrive');
const googleAuth = require('../services/googleAuth');

const router = express.Router();
router.use(requireAuth);

const BACKUP_DIR = '/data/backups';
const SETTINGS_FILE = path.join(BACKUP_DIR, '.backup-settings.json');
const VALID_FILENAME = /^sr22_(manual_|scheduled_|auto_)?\d{4}-\d{2}-\d{2}_\d{6}\.sql\.gz$/;

function getDbConn() {
  const url = new URL(process.env.DATABASE_URL);
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: url.username,
    password: url.password,
    database: url.pathname.slice(1),
  };
}

const upload = multer({ dest: '/tmp/sr22-restore/' });

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function listBackupFiles() {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR);
  return files
    .filter(f => VALID_FILENAME.test(f))
    .map(f => {
      const filepath = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(filepath);
      const protected_ = fs.existsSync(filepath + '.protected');
      const type = f.includes('_scheduled_') ? 'scheduled'
               : f.includes('_manual_') ? 'manual'
               : f.includes('_auto_') ? 'auto'
               : 'scheduled';
      return {
        filename: f,
        size_bytes: stat.size,
        size_label: formatBytes(stat.size),
        created_at: stat.mtime.toISOString(),
        protected: protected_,
        type,
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { enabled: false, cron: '0 3 * * 0', maxBackups: 5 };
  }
}

async function runBackup(type = 'manual', maxBackups = null) {
  ensureBackupDir();

  const settings = readSettings();
  const limit = maxBackups ?? settings.maxBackups ?? 10;

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, (m) => ({ '-': '-', ':': '', 'T': '_' }[m]))
    .replace(/\.\d+Z$/, '');
  const filename = `sr22_${type}_${timestamp}.sql.gz`;
  const filepath = path.join(BACKUP_DIR, filename);
  const tmpPath = filepath + '.tmp';

  const db = getDbConn();
  const env = { ...process.env, PGPASSWORD: db.password };

  await new Promise((resolve, reject) => {
    const pgdump = spawn('pg_dump', [
      '-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database, '-F', 'p',
    ], { env });

    const gzip = require('zlib').createGzip();
    const out = fs.createWriteStream(tmpPath);

    pgdump.stdout.pipe(gzip).pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    pgdump.stderr.on('data', (d) => process.stderr.write(d));
    pgdump.on('error', reject);
    pgdump.on('close', (code) => { if (code !== 0) reject(new Error(`pg_dump exited ${code}`)); });
  });

  fs.renameSync(tmpPath, filepath);

  // Rotate: delete oldest unprotected beyond limit
  applyRotation(limit);

  // Archive a copy to the shared Google Drive, if connected. Fire-and-forget so the manual
  // backup/restore endpoints (and the cron job) don't wait on an extra network round trip
  // after the dump already succeeded and is safely on local disk.
  googleAuth.isConnected().then(async (connected) => {
    if (!connected) return;
    await googleDrive.uploadFile('backups', {
      name: filename, mimeType: 'application/gzip', buffer: fs.readFileSync(filepath),
    });
  }).catch((err) => console.error(`Drive sync failed for backup ${filename}:`, err.message));

  return filename;
}

function applyRotation(limit) {
  const all = listBackupFiles();
  const unprotected = all.filter(f => !f.protected);
  if (unprotected.length > limit) {
    const toDelete = unprotected.slice(limit);
    for (const f of toDelete) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f.filename)); } catch {}
    }
  }
}

async function _restoreFromFile(filepath) {
  const db = getDbConn();
  const env = { ...process.env, PGPASSWORD: db.password };
  const pgArgs = ['-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database];

  await new Promise((resolve, reject) => {
    const psql = spawn('psql', [...pgArgs, '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'], { env });
    psql.on('close', code => code === 0 ? resolve() : reject(new Error(`psql reset exited ${code}`)));
    psql.stderr.on('data', d => process.stderr.write(d));
  });

  await new Promise((resolve, reject) => {
    const gunzip = require('zlib').createGunzip();
    const input = fs.createReadStream(filepath);
    const psql = spawn('psql', pgArgs, { env });
    input.pipe(gunzip).pipe(psql.stdin);
    psql.on('close', code => code === 0 ? resolve() : reject(new Error(`psql restore exited ${code}`)));
    psql.stderr.on('data', d => process.stderr.write(d));
    psql.on('error', reject);
  });
}


// Integrity check: gunzip the file, restore it into a throwaway database (never the live one),
// count what came back, then drop the scratch database. Proves the dump is readable and loads
// cleanly without touching any live data.
async function verifyBackup(filepath) {
  const { Client } = require('pg');
  const zlib = require('zlib');
  const db = getDbConn();
  const env = { ...process.env, PGPASSWORD: db.password };
  const scratch = `avm_verify_${Date.now()}`;
  const admin = new Client({ host: db.host, port: db.port, user: db.user, password: db.password, database: 'postgres' });
  const result = { ok: false, steps: [] };

  // 1. gzip integrity (reads the whole file; throws on a corrupt/truncated archive)
  await new Promise((resolve, reject) => {
    fs.createReadStream(filepath).pipe(zlib.createGunzip()).on('data', () => {}).on('end', resolve).on('error', reject);
  }).then(() => result.steps.push('Archive is a valid gzip file'))
    .catch(e => { throw Object.assign(new Error(`Archive is corrupt: ${e.message}`), { result }); });

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${scratch}"`);
    const errors = [];
    await new Promise((resolve, reject) => {
      const psql = spawn('psql', ['-h', db.host, '-p', db.port, '-U', db.user, '-d', scratch, '-v', 'ON_ERROR_STOP=1', '-q'], { env });
      psql.stdin.on('error', () => {}); // psql may exit early on a bad statement; its stderr is reported below
      // pg_dump 18 writes "SET transaction_timeout" which this (v16) server doesn't know; real
      // restores skip that error and carry on, so drop just that line and stay strict on the rest.
      const sed = spawn('sed', ['/^SET transaction_timeout = 0;$/d']);
      sed.stdin.on('error', () => {});
      sed.stdout.on('error', () => {});
      fs.createReadStream(filepath).pipe(zlib.createGunzip()).pipe(sed.stdin);
      sed.stdout.pipe(psql.stdin);
      psql.stderr.on('data', d => errors.push(d.toString()));
      psql.on('error', reject);
      psql.on('close', code => code === 0 ? resolve() : reject(new Error(errors.join('').trim().split('\n')[0] || `psql exited ${code}`)));
    });
    result.steps.push('Restored cleanly into a scratch database');

    const sc = new Client({ host: db.host, port: db.port, user: db.user, password: db.password, database: scratch });
    await sc.connect();
    try {
      const { rows: tables } = await sc.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`);
      const counts = {};
      for (const { table_name } of tables) {
        if (table_name === 'session') continue;
        const { rows: [r] } = await sc.query(`SELECT count(*)::int AS n FROM "${table_name}"`);
        counts[table_name] = r.n;
      }
      result.tables = tables.length;
      result.rows = counts;
      const { rows: [last] } = await sc.query(`SELECT max(created_at) AS t FROM flights`).catch(() => ({ rows: [{}] }));
      result.latestFlightRecord = last?.t || null;
    } finally { await sc.end(); }
    result.ok = true;
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
  return result;
}

async function ensureRecentBackup() {
  const files = listBackupFiles();
  const ONE_HOUR = 60 * 60 * 1000;
  if (files.length > 0 && Date.now() - new Date(files[0].created_at).getTime() < ONE_HOUR) {
    return files[0].filename;
  }
  return runBackup('auto');
}

// Wire runBackup into cron service
backupCron.setRunBackup(runBackup);

// GET /api/backup — list backups
router.get('/', (req, res) => {
  try {
    res.json(listBackupFiles());
  } catch (err) {
    res.status(500).json({ error: 'Cannot read backup directory' });
  }
});

// GET /api/backup/settings
router.get('/settings', (req, res) => {
  res.json(readSettings());
});

// POST /api/backup/settings
router.post('/settings', (req, res) => {
  const { enabled, cron, maxBackups } = req.body;
  const settings = { enabled: !!enabled, cron: cron || '0 3 * * 0', maxBackups: parseInt(maxBackups) || 5 };
  ensureBackupDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  backupCron.restartCron(settings);
  res.json(settings);
});

// POST /api/backup — manual backup
router.post('/', async (req, res) => {
  try {
    const filename = await runBackup('manual');
    const stat = fs.statSync(path.join(BACKUP_DIR, filename));
    res.json({
      filename,
      size_bytes: stat.size,
      size_label: formatBytes(stat.size),
      created_at: stat.mtime.toISOString(),
      protected: false,
      type: 'manual',
    });
  } catch (err) {
    console.error('[backup] Manual backup failed:', err);
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

// POST /api/backup/:filename/verify — integrity check (see verifyBackup)
router.post('/:filename/verify', async (req, res) => {
  const { filename } = req.params;
  if (!VALID_FILENAME.test(filename)) return res.status(400).json({ error: 'Invalid filename' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup not found' });
  try {
    res.json(await verifyBackup(filepath));
  } catch (err) {
    res.json({ ok: false, error: err.message, steps: err.result?.steps || [] });
  }
});

// GET /api/backup/:filename — download
router.get('/:filename', (req, res) => {
  const { filename } = req.params;
  if (!VALID_FILENAME.test(filename)) return res.status(400).json({ error: 'Invalid filename' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup not found' });
  res.download(filepath, filename);
});

// DELETE /api/backup/:filename
router.delete('/:filename', (req, res) => {
  const { filename } = req.params;
  if (!VALID_FILENAME.test(filename)) return res.status(400).json({ error: 'Invalid filename' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup not found' });
  if (fs.existsSync(filepath + '.protected')) {
    return res.status(409).json({ error: 'Cannot delete a protected backup. Remove protection first.' });
  }
  fs.unlinkSync(filepath);
  res.json({ success: true });
});

// PATCH /api/backup/:filename/protect — toggle protection
router.patch('/:filename/protect', (req, res) => {
  const { filename } = req.params;
  if (!VALID_FILENAME.test(filename)) return res.status(400).json({ error: 'Invalid filename' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup not found' });
  const protectedPath = filepath + '.protected';
  const nowProtected = !fs.existsSync(protectedPath);
  if (nowProtected) {
    fs.writeFileSync(protectedPath, '');
  } else {
    fs.unlinkSync(protectedPath);
  }
  res.json({ filename, protected: nowProtected });
});

// POST /api/backup/restore — upload & restore
router.post('/restore', upload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const tmpFile = req.file.path;
  let preRestoreFilename = null;

  try {
    preRestoreFilename = await ensureRecentBackup();
    await _restoreFromFile(tmpFile);
    res.json({ success: true, preRestoreBackup: preRestoreFilename });
  } catch (err) {
    console.error('[backup] Restore failed:', err);
    res.status(500).json({ error: 'Restore failed: ' + err.message, preRestoreBackup: preRestoreFilename });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// POST /api/backup/restore-file — restore from an existing backup in BACKUP_DIR
router.post('/restore-file', async (req, res) => {
  const { filename } = req.body;
  if (!filename || !VALID_FILENAME.test(filename)) return res.status(400).json({ error: 'Invalid filename' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup not found' });

  let preRestoreFilename = null;
  try {
    preRestoreFilename = await ensureRecentBackup();
    await _restoreFromFile(filepath);
    res.json({ success: true, preRestoreBackup: preRestoreFilename });
  } catch (err) {
    console.error('[backup] Restore-file failed:', err);
    res.status(500).json({ error: 'Restore failed: ' + err.message, preRestoreBackup: preRestoreFilename });
  }
});

router.verifyBackup = verifyBackup;
module.exports = router;
