const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const googleAuth = require('../services/googleAuth');
const googleDrive = require('../services/googleDrive');
const oil = require('../services/oilAnalysis');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = express.Router();
router.use(requireAuth);

async function getPartnershipId(userId) {
  const { rows } = await pool.query('SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1', [userId]);
  if (!rows.length) throw Object.assign(new Error('No partnership found'), { status: 404 });
  return rows[0].partnership_id;
}

const handle = (label, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(`${label} error:`, err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
};

// GET /api/oil-analysis — every sample (newest first), the uploaded files, and trend notes.
router.get('/', handle('GET /oil-analysis', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  const samples = await oil.listSamples(partnershipId);
  const { rows: files } = await pool.query(
    `SELECT f.id, f.filename, f.page_count, f.status, f.error_message, f.uploaded_at, f.processed_at,
            (SELECT COUNT(*)::int FROM oil_analysis_samples s WHERE s.file_id = f.id) AS sample_count
     FROM oil_analysis_files f WHERE f.partnership_id = $1 ORDER BY f.uploaded_at DESC`, [partnershipId]);
  res.json({
    samples, files, trends: oil.computeTrends(samples),
    elements: oil.ELEMENTS.map(([key, symbol, source]) => ({ key, symbol, source })),
  });
}));

// GET /api/oil-analysis/search?q= — full-text search over lab comments and notes.
router.get('/search', handle('GET /oil-analysis/search', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const { rows } = await pool.query(
    `SELECT id, TO_CHAR(sample_date, 'YYYY-MM-DD') AS sample_date, lab_number,
            ts_headline('english', COALESCE(comments, '') || ' ' || COALESCE(notes, ''), websearch_to_tsquery('english', $2)) AS snippet
     FROM oil_analysis_samples WHERE partnership_id = $1 AND search_vector @@ websearch_to_tsquery('english', $2)
     ORDER BY ts_rank(search_vector, websearch_to_tsquery('english', $2)) DESC, sample_date DESC LIMIT 50`,
    [partnershipId, q]);
  res.json(rows);
}));

// POST /api/oil-analysis/upload — store a lab report PDF (Maintenance/Oil Analysis on Drive) and read it.
router.post('/upload', upload.single('file'), handle('POST /oil-analysis/upload', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Upload the lab report as a PDF' });

  const filename = req.file.originalname || 'Oil analysis.pdf';
  const storedName = `${crypto.randomUUID()}.pdf`;
  fs.mkdirSync(oil.OIL_DIR, { recursive: true });
  fs.writeFileSync(path.join(oil.OIL_DIR, storedName), req.file.buffer);
  const { rows: [file] } = await pool.query(
    `INSERT INTO oil_analysis_files (partnership_id, filename, file_key, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [partnershipId, filename, path.join('maintenance', 'oil-analysis', storedName), req.session.userId]);

  googleAuth.isConnected().then(async (connected) => {
    if (!connected) return;
    await googleDrive.ensureFolderStructure(); // adds Maintenance/Oil Analysis on installs connected before it existed
    const driveFileId = await googleDrive.uploadFile('oilAnalysis', { name: filename, mimeType: 'application/pdf', buffer: req.file.buffer });
    await pool.query('UPDATE oil_analysis_files SET drive_file_id = $1 WHERE id = $2', [driveFileId, file.id]);
  }).catch(err => console.error(`Drive sync failed for oil analysis file ${file.id}:`, err.message));

  try {
    const result = await oil.processFile(file.id);
    res.status(201).json({ file_id: file.id, ...result });
  } catch (err) {
    // The file is kept (status 'error') so it can be reprocessed.
    res.status(err.status || 502).json({ file_id: file.id, error: `Saved the file, but couldn't read it: ${err.message}` });
  }
}));

// POST /api/oil-analysis/files/:id/process — re-read a stored report.
router.post('/files/:id/process', handle('POST /oil-analysis/files/:id/process', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  const { rows: [f] } = await pool.query('SELECT id FROM oil_analysis_files WHERE id = $1 AND partnership_id = $2', [req.params.id, partnershipId]);
  if (!f) return res.status(404).json({ error: 'File not found' });
  res.json(await oil.processFile(f.id));
}));

// GET /api/oil-analysis/files/:id/file — the original PDF.
router.get('/files/:id/file', handle('GET /oil-analysis/files/:id/file', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  const { rows: [f] } = await pool.query('SELECT filename, file_key FROM oil_analysis_files WHERE id = $1 AND partnership_id = $2', [req.params.id, partnershipId]);
  if (!f) return res.status(404).json({ error: 'File not found' });
  const full = path.join(UPLOADS_DIR, f.file_key);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File missing on disk' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${f.filename.replace(/"/g, '')}"`);
  fs.createReadStream(full).pipe(res);
}));

// DELETE /api/oil-analysis/files/:id — remove an upload and the samples whose own report it was.
router.delete('/files/:id', handle('DELETE /oil-analysis/files/:id', async (req, res) => {
  const partnershipId = await getPartnershipId(req.session.userId);
  const { rows: [f] } = await pool.query('SELECT id, file_key FROM oil_analysis_files WHERE id = $1 AND partnership_id = $2', [req.params.id, partnershipId]);
  if (!f) return res.status(404).json({ error: 'File not found' });
  await pool.query('DELETE FROM oil_analysis_samples WHERE file_id = $1', [f.id]);
  await pool.query('DELETE FROM oil_analysis_files WHERE id = $1', [f.id]);
  fs.rmSync(path.join(UPLOADS_DIR, f.file_key), { force: true });
  res.json({ ok: true });
}));

module.exports = router;
