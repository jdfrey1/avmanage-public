// Text extraction and parsing for maintenance invoices. Plain code only — no AI/API calls.
// Text comes from the PDF's own text layer (pdf-parse). Shop-specific parsers in
// ./invoiceParsers turn a recognised work order into header details and line items; any other
// invoice is stored with its text (searchable) and the person fills in the header details.
const pdfParse = require('pdf-parse');

// Add a parser for another shop's work-order format by dropping a module in ./invoiceParsers
// that exports parse(text) -> { header, items, itemsOk } | null, and listing it here.
const PARSERS = [
  require('./invoiceParsers/sweetAviation'),
];

async function extractPdfText(buffer) {
  try {
    const { text } = await pdfParse(buffer);
    return (text || '').trim();
  } catch (err) {
    console.error('invoice PDF text extraction failed:', err.message);
    return '';
  }
}

// First parser that recognises the text wins; null if none do.
function parseWorkOrder(text) {
  for (const p of PARSERS) {
    const r = p.parse(text);
    if (r) return r;
  }
  return null;
}

// Plain-text rendering stored in documents.extracted_text so the invoice shows up in search/chat.
function buildSearchText(header, items) {
  const m$ = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const L = [`${header.vendor} — Work Order ${header.invoice_number}${header.invoice_date ? ` (${header.invoice_date})` : ''}`];
  if (header.customer) L.push(`Customer: ${header.customer}`);
  if (header.summary) L.push(`Summary: ${header.summary}`);
  L.push(`Totals: Labor ${m$(header.labor)} | Parts ${m$(header.parts)} | Shipping ${m$(header.shipping)} | Tax ${m$(header.tax)} | Total ${m$(header.total)}`);
  for (const i of items) {
    L.push('', `Item ${i.n} [${i.status.toUpperCase()}${i.date ? ' ' + i.date : ''}]: ${i.description}`);
    if (i.work) L.push(`Work performed: ${i.work}`);
    L.push(`Labor: ${i.hours} hrs @ ${m$(i.rate)} = ${m$(i.labor)}`);
    for (const p of i.parts) L.push(`Part: ${p.part} | ${p.description} | qty ${p.qty} @ ${m$(p.unit)} = ${m$(p.ext)}`);
    L.push(`Item total: ${m$(i.total)}`);
  }
  return L.join('\n');
}

module.exports = { extractPdfText, parseWorkOrder, buildSearchText };
