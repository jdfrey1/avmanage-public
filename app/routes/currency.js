const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const googleDrive = require('../services/googleDrive');
const googleAuth = require('../services/googleAuth');
const reports = require('../services/reports');

const router = express.Router();
router.use(requireAuth);

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

const ffStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, 'foreflight');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${req.session.userId}_latest.csv`),
});
const upload = multer({ storage: ffStorage });

async function getMembership(userId) {
  const { rows } = await pool.query(
    'SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return rows[0];
}

// Quote-aware CSV parser. Tokenizes the whole text as one stream rather than pre-splitting
// on '\n' — ForeFlight export fields (e.g. approach remarks) can contain an embedded newline
// inside quotes, which a naive line-split tears into two rows and silently corrupts.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

// Sum approach counts from Approach1-Approach6 fields (format: "count;type;runway;airport;notes;suffix")
function countApproaches(row, colMap) {
  let total = 0;
  for (let i = 1; i <= 6; i++) {
    const val = (row[colMap[`Approach${i}`]] || '').trim();
    if (val) {
      const n = parseInt(val.split(';')[0], 10);
      if (!isNaN(n)) total += n;
    }
  }
  return total;
}

// Parses a ForeFlight logbook CSV export and (re)populates currency_events for a user.
// Pulled out of the /import route so a stored CSV can also be reprocessed without a fresh
// upload (see app/scripts/reimport-foreflight.js) — e.g. after a parsing bug fix like this one.
async function importForeflightCsv({ userId, partnershipId, text }) {
  const rows = parseCSV(text);

  // Build AircraftID → aircraftClass lookup from Aircraft Table section
  const aircraftClassMap = {};
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0]?.trim() === 'Aircraft Table') {
      const hdrIdx = i + 1;
      const hdrs = rows[hdrIdx];
      const acColMap = {};
      hdrs.forEach((h, j) => { acColMap[h.trim()] = j; });
      for (const acRow of rows.slice(hdrIdx + 1)) {
        const id = (acRow[acColMap['AircraftID']] || '').trim();
        // ForeFlight sometimes leaves a blank row inside the Aircraft Table (not just at its
        // end) — skip it rather than treating it as the end of the section, or every aircraft
        // listed after that blank row silently loses its class and its landings stop counting
        // toward currency.
        if (!id) continue;
        if (id === 'Flights Table') break;
        aircraftClassMap[id] = (acRow[acColMap['aircraftClass (FAA)']] || '').trim() || null;
      }
      break;
    }
  }

  // Find "Flights Table" section
  let headerRowIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] && rows[i][0].trim() === 'Flights Table') {
      headerRowIdx = i + 1;
      break;
    }
  }
  if (headerRowIdx === -1 || headerRowIdx >= rows.length) {
    throw Object.assign(new Error('Could not find Flights Table section in CSV'), { status: 400 });
  }

  // Build column index map from header row
  const headers = rows[headerRowIdx];
  const colMap = {};
  headers.forEach((h, i) => { colMap[h.trim()] = i; });

  const get = (row, col) => (row[colMap[col]] ?? '').trim();
  const getInt = (row, col) => { const v = parseInt(get(row, col), 10); return isNaN(v) ? 0 : v; };

  // Delete all existing foreflight imports for this user before re-inserting
  await pool.query(
    `DELETE FROM currency_events WHERE user_id = $1 AND source = 'foreflight_import'`,
    [userId]
  );

  let imported = 0;
  let skipped = 0;

  for (const row of rows.slice(headerRowIdx + 1)) {
    const dateVal = get(row, 'Date');
    if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) { skipped++; continue; }

    // Use the FullStop-specific totals rather than "Landing Full-Stop Day/Night" — some
    // ForeFlight export variants (e.g. simpler logbook configs) omit those two columns
    // entirely, which silently zeroed every landing (day AND night) for those users.
    // DayLandingsFullStop / NightLandingsFullStop are present in every export we've seen.
    const landingsDay   = getInt(row, 'DayLandingsFullStop');
    const landingsNight = getInt(row, 'NightLandingsFullStop');
    const holds         = getInt(row, 'Holds');
    const approaches    = countApproaches(row, colMap);
    const isBfr         = !!get(row, 'Flight Review (FAA)');
    const isIpc         = !!get(row, 'IPC (FAA)');
    const aircraftType  = get(row, 'AircraftID') || null;
    const aircraftClass = aircraftClassMap[aircraftType] || null;

    // Landings count toward currency only in ASEL/ASELT (airplane_single_engine_land) —
    // note ForeFlight's own "aircraftClass (FAA)" field doesn't distinguish tailwheel from
    // tricycle gear at all (both report as airplane_single_engine_land), so ASELT landings
    // already count as ASEL here as long as the class lookup above actually found the aircraft.
    const isASEL = aircraftClass === 'airplane_single_engine_land';
    const effectiveDayLandings   = isASEL ? landingsDay   : 0;
    const effectiveNightLandings = isASEL ? landingsNight : 0;

    if (!effectiveDayLandings && !effectiveNightLandings && !approaches && !holds && !isBfr && !isIpc) {
      skipped++;
      continue;
    }

    // Primary event_type: bfr > ipc > ifr_session > night_landing > day_landing
    let eventType;
    if (isBfr)                       eventType = 'bfr';
    else if (isIpc)                  eventType = 'ipc';
    else if (approaches > 0)         eventType = 'ifr_session';
    else if (effectiveNightLandings > 0) eventType = 'night_landing';
    else                             eventType = 'day_landing';

    await pool.query(`
      INSERT INTO currency_events
        (user_id, partnership_id, event_date, event_type,
         landings_day, landings_night, approaches, holds_accomplished,
         source, aircraft_type, aircraft_class)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'foreflight_import', $9, $10)
    `, [userId, partnershipId, dateVal, eventType,
        effectiveDayLandings, effectiveNightLandings, approaches, holds > 0, aircraftType, aircraftClass]);

    imported++;
  }

  return { imported, skipped };
}

// POST /api/currency/import
router.post('/import', upload.single('logbook'), async (req, res) => {
  try {
    const userId = req.session.userId;
    const { partnership_id: partnershipId } = await getMembership(userId);

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const text = fs.readFileSync(req.file.path, 'utf-8');
    const { imported, skipped } = await importForeflightCsv({ userId, partnershipId, text });

    const importFile = `foreflight/${userId}_latest.csv`;
    await pool.query(
      `UPDATE users SET last_foreflight_import_at = NOW(), last_foreflight_import_file = $1 WHERE id = $2`,
      [importFile, userId]
    );

    const { rows: [u] } = await pool.query(
      `SELECT name, last_foreflight_import_at, last_foreflight_import_file FROM users WHERE id = $1`,
      [userId]
    );

    // Archive a copy to the shared Google Drive, if connected. Local storage only ever keeps
    // the latest CSV per user (overwritten each import); upload under a timestamped name so
    // Drive preserves import history instead of also overwriting.
    if (await googleAuth.isConnected()) {
      try {
        const stamp = new Date().toISOString().slice(0, 10);
        await googleDrive.uploadFile('foreflight', {
          name: `${u.name} - ForeFlight Import - ${stamp}.csv`, mimeType: 'text/csv', buffer: fs.readFileSync(req.file.path),
        });
      } catch (err) {
        console.error(`Drive sync failed for ForeFlight import (user ${userId}):`, err.message);
      }
    }

    res.json({ imported, skipped, last_import_at: u.last_foreflight_import_at, last_import_file: u.last_foreflight_import_file });
  } catch (err) {
    console.error('ForeFlight import error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/currency
router.get('/', async (req, res) => {
  try {
    let userId = req.session.userId;
    if (req.query.user_id && req.query.user_id !== userId) {
      const { partnership_id: partnershipId } = await getMembership(userId);
      const { rows: [m] } = await pool.query(
        'SELECT 1 FROM partnership_members WHERE user_id = $1 AND partnership_id = $2', [req.query.user_id, partnershipId]);
      if (!m) return res.status(404).json({ error: 'Member not found' });
      userId = req.query.user_id;
    }
    const status = await reports.getCurrencyStatus(userId);
    res.json(status);
  } catch (err) {
    console.error('Currency GET error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/currency/import/download — download most recent imported ForeFlight CSV
router.get('/import/download', async (req, res) => {
  try {
    const { rows: [u] } = await pool.query(
      'SELECT last_foreflight_import_file FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!u?.last_foreflight_import_file) return res.status(404).json({ error: 'No import file found' });
    const filepath = path.join(UPLOADS_DIR, u.last_foreflight_import_file);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Import file not found on disk' });
    res.download(filepath, 'foreflight_logbook.csv');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/currency/medical — save medical expiry date
router.patch('/medical', async (req, res) => {
  try {
    const { medical_expires_date } = req.body;
    await pool.query(
      'UPDATE users SET medical_expires_date = $1 WHERE id = $2',
      [medical_expires_date || null, req.session.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /currency/medical error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/currency/bfr — save BFR accomplishment date
router.patch('/bfr', async (req, res) => {
  try {
    const { bfr_date } = req.body;
    await pool.query(
      'UPDATE users SET bfr_date = $1 WHERE id = $2',
      [bfr_date || null, req.session.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /currency/bfr error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.importForeflightCsv = importForeflightCsv;
module.exports = router;
