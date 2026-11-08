const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { importForeflightCsv } = require('../services/foreflightImport');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

// Reprocesses a user's already-uploaded ForeFlight CSV against the current import logic,
// without requiring them to re-export/re-upload from ForeFlight. Useful after fixing a
// parsing bug in importForeflightCsv (app/services/foreflightImport.js).
async function reimport(userId) {
  const filepath = path.join(UPLOADS_DIR, 'foreflight', `${userId}_latest.csv`);
  if (!fs.existsSync(filepath)) throw new Error(`No stored ForeFlight CSV found for user ${userId}: ${filepath}`);

  const { rows: [member] } = await pool.query(
    'SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (!member) throw new Error(`No partnership found for user ${userId}`);

  const text = fs.readFileSync(filepath, 'utf-8');
  const result = await importForeflightCsv({ userId, partnershipId: member.partnership_id, text });
  console.log(`[${userId}] imported ${result.imported}, skipped ${result.skipped}`);
  return result;
}

async function main() {
  const [, , userId] = process.argv;
  if (!userId) {
    console.error('Usage: node reimport-foreflight.js <userId>');
    process.exit(1);
  }
  try {
    await reimport(userId);
  } catch (err) {
    console.error('Reimport failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();
module.exports = { reimport };
