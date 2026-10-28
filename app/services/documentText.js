const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

// Full verbatim transcription of every page gets expensive/large fast — beyond this many
// pages we skip automatic extraction rather than near-certainly blow the output budget.
const MAX_PAGES_FOR_AUTO_EXTRACT = 20;

const PROMPT = `Transcribe all readable text content from this document, in plain text, as \
completely and accurately as possible. Preserve structure (headings, tables as simple rows, \
lists) using plain text formatting only — no markdown syntax, no commentary before or after. \
If a table has many rows, keep each row on its own line with values separated by " | ". This \
transcription will be used to answer questions about the document later, so prioritize \
capturing every number, limitation, and specification exactly as written.`;

function getPdfPageCount(buffer) {
  const tmpPath = path.join(os.tmpdir(), `pagecount-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    return parseInt(execFileSync('qpdf', ['--show-npages', tmpPath]).toString().trim(), 10);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

// Extracts plain text from a document buffer (PDF or image) for later chat/search use.
// Returns { status: 'ready'|'skipped'|'error', text, error }.
async function extractDocumentText({ buffer, mediaType, isPdf }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: 'error', text: null, error: 'Text extraction is not configured' };
  }

  if (isPdf) {
    const pageCount = getPdfPageCount(buffer);
    if (pageCount > MAX_PAGES_FOR_AUTO_EXTRACT) {
      return {
        status: 'skipped',
        text: null,
        error: `Document has ${pageCount} pages — automatic text extraction is limited to ${MAX_PAGES_FOR_AUTO_EXTRACT} pages. This document won't be searchable via chat until it's processed in smaller batches.`,
      };
    }
  }

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } };

  try {
    const anthropic = new Anthropic();
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 32000,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: PROMPT }] }],
    });
    const finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason === 'max_tokens') {
      return { status: 'error', text: null, error: 'Document text was too long to extract in one pass' };
    }
    const textBlock = finalMessage.content.find(b => b.type === 'text');
    return { status: 'ready', text: textBlock?.text ?? '', error: null };
  } catch (err) {
    return { status: 'error', text: null, error: err.message };
  }
}

module.exports = { extractDocumentText, MAX_PAGES_FOR_AUTO_EXTRACT };
