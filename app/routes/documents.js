const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const { extractDocumentText } = require('../services/documentText');
const googleDrive = require('../services/googleDrive');
const googleAuth = require('../services/googleAuth');

const router = express.Router();
router.use(requireAuth);

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const DOCS_DIR = path.join(UPLOADS_DIR, 'documents');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const VALID_DOC_TYPES = [
  'airworthiness_certificate', 'registration', 'radio_station_license',
  'operating_limitations', 'weight_and_balance', 'lease', 'insurance', 'receipt', 'other', 'miscellaneous',
];

async function getPartnershipId(userId) {
  const { rows } = await pool.query(
    'SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return rows[0].partnership_id;
}

// GET /api/documents?doc_type=registration
router.get('/', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { doc_type } = req.query;

    const conditions = ['d.partnership_id = $1'];
    const params = [partnershipId];
    if (doc_type) {
      params.push(doc_type);
      conditions.push(`d.doc_type = $${params.length}`);
    }

    const { rows } = await pool.query(`
      SELECT d.id, d.doc_type, d.title, d.file_key, d.uploaded_at, d.text_status, d.text_error,
             u.name AS uploaded_by_name
      FROM documents d
      JOIN users u ON u.id = d.uploaded_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.doc_type, d.uploaded_at DESC
    `, params);

    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /documents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/documents/upload
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const { doc_type, title } = req.body;
    if (!VALID_DOC_TYPES.includes(doc_type)) {
      return res.status(400).json({ error: `doc_type must be one of: ${VALID_DOC_TYPES.join(', ')}` });
    }

    const mime = req.file.mimetype;
    if (!mime.startsWith('image/') && mime !== 'application/pdf') {
      return res.status(400).json({ error: 'File must be an image or PDF' });
    }

    const ext = mime === 'application/pdf' ? 'pdf' : (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const fileKey = path.join('documents', `${crypto.randomUUID()}.${ext}`);
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, fileKey), req.file.buffer);

    // Text extraction is NOT run automatically here — it costs Anthropic API tokens.
    // The document sits as 'pending' until someone explicitly triggers processing via
    // POST /:id/process (button in the UI) or has it transcribed manually.
    const { rows: [doc] } = await pool.query(`
      INSERT INTO documents (partnership_id, uploaded_by, doc_type, title, file_key)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, doc_type, title, file_key, uploaded_at, text_status, text_error
    `, [partnershipId, req.session.userId, doc_type, title?.trim() || req.file.originalname || 'Untitled', fileKey]);

    // Archive a copy to the shared Google Drive, if connected. Best-effort — a Drive/Google
    // outage must never block an aircraft document upload.
    if (await googleAuth.isConnected()) {
      try {
        // Some titles are entered with the extension already included (e.g. "Plate.JPG") —
        // don't double it up into "Plate.JPG.jpg".
        const driveName = doc.title.toLowerCase().endsWith(`.${ext}`) ? doc.title : `${doc.title}.${ext}`;
        const driveFileId = await googleDrive.uploadFile('documents', {
          name: driveName, mimeType: mime, buffer: req.file.buffer,
        });
        await pool.query('UPDATE documents SET drive_file_id = $1 WHERE id = $2', [driveFileId, doc.id]);
        doc.drive_file_id = driveFileId;
      } catch (err) {
        console.error(`Drive sync failed for document ${doc.id}:`, err.message);
      }
    }

    const { rows: [{ name }] } = await pool.query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
    res.status(201).json({ ...doc, uploaded_by_name: name });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /documents/upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/documents/:id/process — explicitly triggers Anthropic-powered text extraction
// for a pending document. This is a deliberate, user-initiated action (not automatic on
// upload) since it spends API tokens.
router.post('/:id/process', async (req, res) => {
  try {
    if (!anthropic) return res.status(503).json({ error: 'Document processing is not configured' });
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [doc] } = await pool.query(
      'SELECT file_key FROM documents WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const filepath = path.join(UPLOADS_DIR, doc.file_key);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File missing' });
    const buffer = fs.readFileSync(filepath);
    const isPdf = doc.file_key.toLowerCase().endsWith('.pdf');
    const mediaType = isPdf ? 'application/pdf' : `image/${path.extname(doc.file_key).slice(1) || 'jpeg'}`;

    const extraction = await extractDocumentText({ buffer, mediaType, isPdf });
    const { rows: [updated] } = await pool.query(
      `UPDATE documents SET extracted_text = $2, text_status = $3, text_error = $4
       WHERE id = $1 RETURNING id, doc_type, title, file_key, uploaded_at, text_status, text_error`,
      [req.params.id, extraction.text, extraction.status, extraction.error]
    );

    const { rows: [{ name }] } = await pool.query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
    res.json({ ...updated, uploaded_by_name: name });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /documents/:id/process error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/documents/:id/file — view/download
router.get('/:id/file', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [doc] } = await pool.query(
      'SELECT file_key, title FROM documents WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const filepath = path.join(UPLOADS_DIR, doc.file_key);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File missing' });
    res.sendFile(filepath);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /documents/:id/file error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Turns free-text into an OR-of-words tsquery so a question doesn't have to match every
// term on a page to surface it — better recall for a manual with terse, table-heavy pages.
function buildOrTsQuery(text) {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 1);
  if (words.length === 0) return null;
  return [...new Set(words)].join(' | ');
}

// POST /api/documents/ask — chat Q&A over extracted text of the reference documents.
// Small documents (Registration, W&B, etc.) are included in full. Large paginated documents
// (e.g. the POH, stored in document_pages) are searched first, and only the best-matching
// pages are included, so a 300+ page manual doesn't have to be stuffed into every question.
router.post('/ask', async (req, res) => {
  try {
    if (!anthropic) return res.status(503).json({ error: 'Document chat is not configured' });
    const partnershipId = await getPartnershipId(req.session.userId);
    const { question, history } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'question is required' });

    const { rows: wholeDocs } = await pool.query(`
      SELECT id, doc_type, title, extracted_text
      FROM documents
      WHERE partnership_id = $1 AND text_status IN ('ready', 'partial') AND extracted_text IS NOT NULL
    `, [partnershipId]);

    const tsQuery = buildOrTsQuery(question);
    let pageMatches = [];
    if (tsQuery) {
      const { rows } = await pool.query(`
        SELECT dp.document_id, dp.page_number, dp.text, d.doc_type, d.title,
               ts_rank(dp.search_vector, to_tsquery('english', $2)) AS rank
        FROM document_pages dp
        JOIN documents d ON d.id = dp.document_id
        WHERE dp.partnership_id = $1 AND dp.search_vector @@ to_tsquery('english', $2)
        ORDER BY rank DESC
        LIMIT 15
      `, [partnershipId, tsQuery]);
      pageMatches = rows;
    }

    if (wholeDocs.length === 0 && pageMatches.length === 0) {
      return res.json({
        answer: "None of the uploaded aircraft documents have searchable text yet, so I can't answer questions about them.",
        citations: [],
      });
    }

    const corpusParts = [
      ...wholeDocs.map(d => `DOCUMENT ID:${d.id} | TYPE:${d.doc_type} | TITLE:${d.title}\n${d.extracted_text}`),
      ...pageMatches.map(p => `DOCUMENT ID:${p.document_id} | TYPE:${p.doc_type} | TITLE:${p.title} | PAGE:${p.page_number}\n${p.text}`),
    ];
    const corpus = corpusParts.join('\n\n=====\n\n');

    const historyMessages = Array.isArray(history)
      ? history.slice(-6).flatMap(h => [
          { role: 'user', content: h.question },
          { role: 'assistant', content: h.answer },
        ])
      : [];

    const systemPrompt =
      'You are answering questions about an aircraft using ONLY the reference documents ' +
      'provided below (things like the Weight & Balance data, Pilot Operating Handbook, ' +
      'Registration, Airworthiness Certificate). Some entries are whole documents; others ' +
      'are individual pages from a larger manual and include a PAGE number — when you use ' +
      'one of those, include that page number in your citation. If the documents don\'t ' +
      'contain the answer, say so plainly rather than guessing or using outside knowledge. ' +
      'Respond with ONLY a JSON object, no other text: {"answer": "<your answer in plain ' +
      'English>", "citations": [{"document_id": "<DOCUMENT ID>", "page_number": <int or null>}, ...]}';

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `REFERENCE DOCUMENTS:\n\n${corpus}`, cache_control: { type: 'ephemeral' } }],
        },
        ...historyMessages,
        { role: 'user', content: question.trim() },
      ],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const rawText = (textBlock?.text ?? '').trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Model sometimes prefaces the JSON with a sentence of prose or wraps it in a
      // code fence; pull out the outermost {...} object rather than giving up entirely.
      const match = rawText.match(/\{[\s\S]*\}/);
      parsed = match ? (() => { try { return JSON.parse(match[0]); } catch { return null; } })() : null;
      if (!parsed) parsed = { answer: rawText || 'Sorry, something went wrong answering that.', citations: [] };
    }

    const titleById = new Map([
      ...wholeDocs.map(d => [d.id, { doc_type: d.doc_type, title: d.title }]),
      ...pageMatches.map(p => [p.document_id, { doc_type: p.doc_type, title: p.title }]),
    ]);
    const rawCitations = Array.isArray(parsed.citations) ? parsed.citations : [];
    const citations = rawCitations
      .filter(c => titleById.has(c.document_id))
      .map(c => ({
        id: c.document_id,
        doc_type: titleById.get(c.document_id).doc_type,
        title: titleById.get(c.document_id).title,
        page_number: typeof c.page_number === 'number' ? c.page_number : null,
      }));

    res.json({ answer: parsed.answer, citations });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /documents/ask error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/documents/:id
router.delete('/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [doc] } = await pool.query(
      'SELECT file_key FROM documents WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    fs.unlink(path.join(UPLOADS_DIR, doc.file_key), () => {});
    await pool.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
    res.sendStatus(204);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /documents/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
