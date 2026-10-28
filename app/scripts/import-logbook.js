const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { extractAndStore, VALID_CATEGORIES } = require('../services/logbookImport');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const SOURCE_DIR = path.join(UPLOADS_DIR, 'logbooks', 'source');

function guessMediaType(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  return ext === '.png' ? 'image/png' : 'image/jpeg';
}

async function importFile(category, filename) {
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`category must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }
  const filepath = path.join(SOURCE_DIR, filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`);
  }

  const { rows: [partnership] } = await pool.query('SELECT id FROM partnerships LIMIT 1');
  if (!partnership) throw new Error('No partnership found');

  const isPdf = path.extname(filename).toLowerCase() === '.pdf';
  const buffer = fs.readFileSync(filepath);
  const fileKey = path.join('logbooks', 'source', filename);

  console.log(`[${filename}] calling Claude...`);
  const result = await extractAndStore({
    buffer,
    mediaType: isPdf ? 'application/pdf' : guessMediaType(filepath),
    isPdf,
    category,
    partnershipId: partnership.id,
    sourceFilename: filename,
    fileKey,
  });
  console.log(`[${filename}] inserted ${result.entries.length} entries`);
  return result;
}

async function main() {
  const [, , category, filename] = process.argv;
  if (!category || !filename) {
    console.error('Usage: node import-logbook.js <category> <filename-in-logbooks/source>');
    process.exit(1);
  }
  try {
    await importFile(category, filename);
  } catch (err) {
    console.error('Import failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();
module.exports = { importFile };
