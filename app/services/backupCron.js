const cron = require('node-cron');

let activeTask = null;

// runBackup is set by backup.js after it loads (avoids circular require)
let _runBackup = null;
function setRunBackup(fn) { _runBackup = fn; }

function initCron() {
  const settings = readSettings();
  _applySettings(settings);
}

function restartCron(settings) {
  _applySettings(settings);
}

function _applySettings(settings) {
  if (activeTask) {
    activeTask.stop();
    activeTask = null;
  }

  if (!settings.enabled || !settings.cron) return;

  if (!cron.validate(settings.cron)) {
    console.warn(`[backup-cron] Invalid cron expression: ${settings.cron}`);
    return;
  }

  activeTask = cron.schedule(settings.cron, async () => {
    console.log('[backup-cron] Scheduled backup starting');
    try {
      if (_runBackup) {
        const filename = await _runBackup('scheduled', settings.maxBackups || 10);
        console.log(`[backup-cron] Scheduled backup complete: ${filename}`);
      }
    } catch (err) {
      console.error('[backup-cron] Scheduled backup failed:', err.message);
    }
  });

  console.log(`[backup-cron] Cron scheduled: ${settings.cron}`);
}

function readSettings() {
  const fs = require('fs');
  const path = require('path');
  const SETTINGS_FILE = path.join('/data/backups', '.backup-settings.json');
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { enabled: false, cron: '0 3 * * 0', maxBackups: 5 };
  }
}

module.exports = { initCron, restartCron, setRunBackup };
