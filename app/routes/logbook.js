const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const requireAuth = require('../middleware/requireAuth');
const { extractAndStore, VALID_CATEGORIES } = require('../services/logbookImport');
const googleDrive = require('../services/googleDrive');
const googleAuth = require('../services/googleAuth');

const router = express.Router();
router.use(requireAuth);

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const SOURCE_DIR = path.join(UPLOADS_DIR, 'logbooks', 'source');
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

async function getPartnershipId(userId) {
  const { rows } = await pool.query(
    'SELECT partnership_id FROM partnership_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('No partnership found'), { status: 403 });
  return rows[0].partnership_id;
}

// GET /api/logbook/documents
router.get('/documents', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows } = await pool.query(`
      SELECT d.id, d.category, d.source_filename, d.page_count, d.status, d.error_message,
             d.uploaded_at, d.processed_at,
             COUNT(e.id)::int AS entry_count,
             COUNT(e.id) FILTER (WHERE e.needs_review)::int AS needs_review_count
      FROM logbook_documents d
      LEFT JOIN logbook_entries e ON e.document_id = d.id
      WHERE d.partnership_id = $1
      GROUP BY d.id
      ORDER BY d.uploaded_at DESC
    `, [partnershipId]);
    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /logbook/documents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/logbook/documents/:id/file — view/download the original scanned source
router.get('/documents/:id/file', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [doc] } = await pool.query(
      'SELECT file_key, source_filename FROM logbook_documents WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const filepath = path.join(UPLOADS_DIR, doc.file_key);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Source file missing' });
    res.sendFile(filepath);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /logbook/documents/:id/file error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/logbook/import — upload a new page/photo/document and extract entries from it,
// without needing to re-scan the whole logbook. Use this for new entries going forward.
router.post('/import', upload.single('file'), async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const { category } = req.body;
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }

    const mime = req.file.mimetype;
    const isPdf = mime === 'application/pdf';
    if (!isPdf && !mime.startsWith('image/')) {
      return res.status(400).json({ error: 'File must be a PDF or an image' });
    }

    const ext = isPdf ? 'pdf' : (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const storedName = `${category}-${crypto.randomUUID()}.${ext}`;
    fs.mkdirSync(SOURCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(SOURCE_DIR, storedName), req.file.buffer);

    const result = await extractAndStore({
      buffer: req.file.buffer,
      mediaType: mime,
      isPdf,
      category,
      partnershipId,
      sourceFilename: req.file.originalname || storedName,
      fileKey: path.join('logbooks', 'source', storedName),
    });

    res.status(201).json(result);

    // Archive a copy to the shared Google Drive, if connected. Fire-and-forget: the
    // Claude extraction above already made the request slow, so don't stack an awaited
    // Drive upload on top of it — the response has already gone out.
    googleAuth.isConnected().then(async (connected) => {
      if (!connected) return;
      const driveFileId = await googleDrive.uploadFile('logbooks', {
        name: req.file.originalname || storedName, mimeType: mime, buffer: req.file.buffer,
      });
      await pool.query('UPDATE logbook_documents SET drive_file_id = $1 WHERE id = $2', [driveFileId, result.document_id]);
    }).catch((err) => console.error(`Drive sync failed for logbook document ${result.document_id}:`, err.message));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /logbook/import error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// GET /api/logbook/entries
router.get('/entries', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { category, q, date_from, date_to, needs_review, order } = req.query;
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';

    const conditions = ['e.partnership_id = $1'];
    const params = [partnershipId];

    if (category) {
      if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }
      params.push(category);
      conditions.push(`e.category = $${params.length}`);
    }
    if (date_from) {
      params.push(date_from);
      conditions.push(`e.entry_date >= $${params.length}`);
    }
    if (date_to) {
      params.push(date_to);
      conditions.push(`e.entry_date <= $${params.length}`);
    }
    if (needs_review === 'true' || needs_review === 'false') {
      params.push(needs_review === 'true');
      conditions.push(`e.needs_review = $${params.length}`);
    }
    if (q && q.trim()) {
      params.push(q.trim());
      conditions.push(`e.search_vector @@ websearch_to_tsquery('english', $${params.length})`);
    }

    const { rows } = await pool.query(`
      SELECT e.id, e.document_id, e.category, e.page_number,
             TO_CHAR(e.entry_date, 'YYYY-MM-DD') AS entry_date,
             e.summary, e.raw_text, e.fields, e.tags, e.needs_review, e.reviewed_at, e.created_at,
             e.invoice_id, inv.invoice_number, d.source_filename
      FROM logbook_entries e
      JOIN logbook_documents d ON d.id = e.document_id
      LEFT JOIN invoices inv ON inv.id = e.invoice_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.entry_date ${sortDir} NULLS LAST, d.source_filename, e.page_number
      LIMIT 500
    `, params);

    res.json(rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('GET /logbook/entries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/logbook/entries/:id — correct/review an extracted entry
router.patch('/entries/:id', async (req, res) => {
  try {
    const partnershipId = await getPartnershipId(req.session.userId);
    const { rows: [existing] } = await pool.query(
      'SELECT id FROM logbook_entries WHERE id = $1 AND partnership_id = $2',
      [req.params.id, partnershipId]
    );
    if (!existing) return res.status(404).json({ error: 'Entry not found' });

    const { entry_date, summary, raw_text, fields, tags, needs_review } = req.body;
    const sets = [];
    const params = [];

    if (entry_date !== undefined) { params.push(entry_date || null); sets.push(`entry_date = $${params.length}`); }
    if (summary    !== undefined) { params.push(summary);            sets.push(`summary = $${params.length}`); }
    if (raw_text   !== undefined) { params.push(raw_text);           sets.push(`raw_text = $${params.length}`); }
    if (fields     !== undefined) { params.push(JSON.stringify(fields)); sets.push(`fields = $${params.length}`); }
    if (tags       !== undefined) { params.push(tags);               sets.push(`tags = $${params.length}`); }
    if (needs_review !== undefined) {
      params.push(!!needs_review);
      sets.push(`needs_review = $${params.length}`);
      sets.push(`reviewed_at = ${needs_review ? 'NULL' : 'NOW()'}`);
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const { rows: [entry] } = await pool.query(`
      UPDATE logbook_entries SET ${sets.join(', ')} WHERE id = $${params.length}
      RETURNING id, document_id, category, page_number, TO_CHAR(entry_date, 'YYYY-MM-DD') AS entry_date,
                summary, raw_text, fields, tags, needs_review, reviewed_at, created_at
    `, params);

    res.json(entry);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /logbook/entries/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function buildCorpus(entries) {
  return entries.map(e => {
    const fieldsStr = Object.keys(e.fields || {}).length ? `\nFields: ${JSON.stringify(e.fields)}` : '';
    const dateStr = e.entry_date || 'undated';
    return `ID:${e.id} | ${e.category} | ${e.source_filename} p.${e.page_number ?? '?'} | ${dateStr}\n` +
           `${e.summary}\n${e.raw_text}${fieldsStr}`;
  }).join('\n\n---\n\n');
}

// POST /api/logbook/ask — chat Q&A over the imported logbook corpus
router.post('/ask', async (req, res) => {
  try {
    if (!anthropic) return res.status(503).json({ error: 'Logbook chat is not configured' });
    const partnershipId = await getPartnershipId(req.session.userId);
    const { question, history } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'question is required' });

    const { rows: entries } = await pool.query(`
      SELECT e.id, e.document_id, e.category, e.page_number,
             TO_CHAR(e.entry_date, 'YYYY-MM-DD') AS entry_date,
             e.summary, e.raw_text, e.fields,
             d.source_filename
      FROM logbook_entries e
      JOIN logbook_documents d ON d.id = e.document_id
      WHERE e.partnership_id = $1
      ORDER BY e.entry_date ASC NULLS LAST
    `, [partnershipId]);

    if (entries.length === 0) {
      return res.json({
        answer: "No logbook entries have been imported yet, so I can't answer questions about the aircraft's maintenance history.",
        citations: [],
      });
    }

    const corpus = buildCorpus(entries);

    const historyMessages = Array.isArray(history)
      ? history.slice(-6).flatMap(h => [
          { role: 'user', content: h.question },
          { role: 'assistant', content: h.answer },
        ])
      : [];

    const systemPrompt =
      'You are answering questions about an aircraft\'s maintenance history using ONLY the ' +
      'logbook entries provided below. These entries were OCR-transcribed from scanned paper ' +
      'logbooks and may be incomplete. Cite the specific entries you used by their ID. If the ' +
      'entries don\'t contain the answer, say so plainly rather than guessing or using outside ' +
      'knowledge. Respond with ONLY a JSON object, no other text: ' +
      '{"answer": "<your answer in plain English, written for an aircraft owner>", ' +
      '"citation_ids": ["<entry ID>", ...]}';

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `LOGBOOK ENTRIES:\n\n${corpus}`, cache_control: { type: 'ephemeral' } },
          ],
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
      if (!parsed) parsed = { answer: rawText || 'Sorry, something went wrong answering that.', citation_ids: [] };
    }

    const citedIds = Array.isArray(parsed.citation_ids) ? parsed.citation_ids : [];
    const citations = entries
      .filter(e => citedIds.includes(e.id))
      .map(e => ({
        id: e.id,
        document_id: e.document_id,
        category: e.category,
        source_filename: e.source_filename,
        page_number: e.page_number,
        entry_date: e.entry_date,
        summary: e.summary,
      }));

    res.json({ answer: parsed.answer, citations });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /logbook/ask error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
