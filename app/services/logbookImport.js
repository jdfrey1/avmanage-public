const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');

const VALID_CATEGORIES = ['engine', 'airframe', 'prop', 'ad_sb_compliance', 'other'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // Anthropic API hard limit on base64 image size

const PROMPT = `You are transcribing scanned pages from an aircraft maintenance logbook. \
These are safety-critical, legally significant maintenance records — transcribe numbers \
(tach times, hours, AD numbers, dates) with extra care and never guess a value you cannot \
actually read.

These documents come in two shapes:
1. Chronological logbook entries — narrative write-ups, each dated, describing work performed.
2. Tabular compliance reports (e.g. an "Airworthiness Directives Compliance Report" or "Service \
Bulletin" listing) — a table with one row per AD/SB, columns like AD#/SB#, subject, method of \
compliance, date/hours at compliance, recurring?, next due, signature. For this shape, treat \
EACH ROW as its own separate entry — do NOT summarize the whole page or table into one entry. \
Many rows will show "N/A" for compliance (not applicable to this aircraft/serial number) with \
no compliance date — that is still a real entry worth capturing (use entry_date: null for it), \
because it documents that the AD/SB was reviewed and found not applicable.

IMPORTANT: AD numbers and SB numbers are formatted like a date but are NOT one — e.g. \
"2006-21-03" or "2005-17-19" is an AD number (year-issue-revision), not a calendar date. Put \
AD/SB numbers only in fields.ad_number / fields.sb_number, never in entry_date. entry_date \
must only ever be a real calendar date the document shows for when work/compliance actually \
happened (often written MM/DD/YY, convert to YYYY-MM-DD) — if that row has no such date, use null.

Return ONLY a JSON array (no markdown fences, no commentary before or after). Each element \
represents one discrete entry (a single page may contain many — return one array element per \
entry/row, not one per page):

{
  "page_number": <int, 1-based page this entry appears on>,
  "entry_date": "<YYYY-MM-DD, or null if no date is legible or not applicable>",
  "summary": "<one sentence describing the work/event, or the AD/SB subject + compliance status>",
  "raw_text": "<the entry's actual content — narrative text, or for a table row, the row's values — \
condensed to the essential content. Do NOT repeat shop/repair-station letterhead \
(name, address, phone) or other boilerplate that is identical across every entry in this \
document — that information is constant and not worth repeating per-entry. Keep specific \
values (dates, tach/hours, part numbers, AD/SB numbers, signer name) verbatim and accurate; \
the narrative description can be tightened/condensed as long as no fact is lost.>",
  "fields": { <any structured values present: tach, aircraft_tt, tsmoh, flighttime, work_order, \
signed_by, ad_number, sb_number, subject, method_of_compliance, recurrent, next_due, \
part_numbers, etc. Use whatever keys are relevant to this entry; omit keys that don't apply.> },
  "tags": ["<short lowercase keywords, e.g. oil-change, inspection, compression-check, ad-compliance, not-applicable, overhaul>"],
  "needs_review": <true if any part of this entry involved handwriting, was ambiguous, or you are not fully \
confident in the transcription; false only if the source is clearly typed/printed and unambiguous>
}

Keep raw_text concise (aim for 1-3 short sentences unless the entry is unusually detailed) — \
token budget is limited and there may be many entries in this document.`;

// Claude's image size limit is on the base64 payload, not the file — shrink oversized
// photos (common with phone camera captures of logbook pages) before encoding.
function base64Size(buffer) {
  return Math.ceil(buffer.length / 3) * 4;
}

function resizeImageBuffer(buffer) {
  const tmpIn = path.join(os.tmpdir(), `logbook-in-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tmpOut = `${tmpIn}-out.jpg`;
  fs.writeFileSync(tmpIn, buffer);
  try {
    execFileSync('convert', [tmpIn, '-resize', '2000x2000>', '-quality', '85', `jpg:${tmpOut}`]);
    return fs.readFileSync(tmpOut);
  } finally {
    fs.unlinkSync(tmpIn);
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
}

// Claude occasionally confuses an AD-number-shaped string (e.g. "2005-17-19") for a real
// date. Guard against inserting anything that isn't a valid calendar date.
function sanitizeDate(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return value;
}

function buildContentBlock({ buffer, mediaType, isPdf }) {
  if (isPdf) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  let finalBuffer = buffer;
  let finalMediaType = mediaType;
  if (base64Size(buffer) > MAX_IMAGE_BYTES) {
    finalBuffer = resizeImageBuffer(buffer);
    finalMediaType = 'image/jpeg';
    if (base64Size(finalBuffer) > MAX_IMAGE_BYTES) {
      throw new Error(`Image still exceeds ${MAX_IMAGE_BYTES} bytes (base64) after resizing`);
    }
  }
  return { type: 'image', source: { type: 'base64', media_type: finalMediaType, data: finalBuffer.toString('base64') } };
}

// Runs the Claude extraction over an already-resolved file buffer and stores the results.
// `fileKey` should point to wherever the source file lives under UPLOADS_DIR (caller is
// responsible for placing it there before calling this).
async function extractAndStore({ buffer, mediaType, isPdf, category, partnershipId, sourceFilename, fileKey }) {
  if (!VALID_CATEGORIES.includes(category)) {
    throw Object.assign(new Error(`category must be one of: ${VALID_CATEGORIES.join(', ')}`), { status: 400 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error('Logbook import is not configured'), { status: 503 });
  }

  const { rows: [doc] } = await pool.query(`
    INSERT INTO logbook_documents (partnership_id, category, source_filename, file_key, status)
    VALUES ($1, $2, $3, $4, 'pending')
    RETURNING id, category, source_filename, file_key, status, uploaded_at
  `, [partnershipId, category, sourceFilename, fileKey]);

  const anthropic = new Anthropic();
  const contentBlock = buildContentBlock({ buffer, mediaType, isPdf });

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 32000,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: PROMPT }] }],
    });
    const finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason === 'max_tokens') {
      throw new Error('Response was cut off at max_tokens — document may need to be split into smaller batches');
    }
    const textBlock = finalMessage.content.find(b => b.type === 'text');
    const cleaned = (textBlock?.text ?? '').trim().replace(/^```json\s*/, '').replace(/```$/, '');
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`Could not parse Claude's response as JSON: ${e.message}\n---\n${cleaned.slice(0, 800)}`);
    }

    // Insert all entries (plus the final status flip) as one transaction — if any single
    // entry fails to insert, the whole batch rolls back instead of leaving the document
    // half-populated.
    const client = await pool.connect();
    let entries = [];
    try {
      await client.query('BEGIN');
      entries = [];
      for (const e of parsed) {
        const { rows: [row] } = await client.query(`
          INSERT INTO logbook_entries
            (document_id, partnership_id, category, page_number, entry_date, summary, raw_text, fields, tags, needs_review)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING id, document_id, category, page_number, TO_CHAR(entry_date, 'YYYY-MM-DD') AS entry_date,
                    summary, raw_text, fields, tags, needs_review, reviewed_at, created_at
        `, [
          doc.id, partnershipId, category,
          e.page_number ?? null,
          sanitizeDate(e.entry_date),
          e.summary || '(no summary)',
          e.raw_text || '',
          JSON.stringify(e.fields || {}),
          e.tags || [],
          e.needs_review !== false,
        ]);
        entries.push({ ...row, source_filename: sourceFilename });
      }

      const maxPage = parsed.reduce((m, e) => Math.max(m, e.page_number || 1), 1);
      await client.query(
        `UPDATE logbook_documents SET status = 'processed', processed_at = NOW(), page_count = $2 WHERE id = $1`,
        [doc.id, maxPage]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { document_id: doc.id, entries };
  } catch (err) {
    await pool.query(
      `UPDATE logbook_documents SET status = 'error', error_message = $2 WHERE id = $1`,
      [doc.id, err.message]
    );
    throw err;
  }
}

module.exports = { extractAndStore, VALID_CATEGORIES };
