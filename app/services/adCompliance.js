const pool = require('../db');
const reports = require('./reports');

// The AD/SB list for Logbooks → AD/SB Compliance. Each item carries the logbook entries that
// document it: its line on the compliance report, any entries linked by hand, and any maintenance
// log entry that quotes its number (e.g. "Complied with AD 2024-24-11 …").

// A pattern matching an AD/SB number as written in a logbook entry, tolerant of spacing and
// hyphens ("SB 2X-55-15 R1" vs "SB2X-55-15R1"); an SB's "SB" prefix is optional.
function numberPattern(item) {
  let n = item.number.toUpperCase().trim();
  const sbPrefix = /^SB\s*/.test(n);
  if (sbPrefix) n = n.replace(/^SB\s*/, '');
  const tokens = n.replace(/(\d)(R\d+)$/, '$1 $2').split(/[\s-]+/).filter(Boolean);
  if (!tokens.length) return null;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = tokens.map(esc).join('[\\s-]?');
  return new RegExp(`(?<![A-Z0-9-])${sbPrefix ? '(?:SB[\\s-]?)?' : ''}${body}(?![0-9A-Z])`, 'i');
}

async function getAdItems(partnershipId) {
  const { rows: items } = await pool.query(`
    SELECT id, kind, applies_to, number, TO_CHAR(effective_date, 'YYYY-MM-DD') AS effective_date, subject, status,
           method_of_compliance, recurring, recurring_note, TO_CHAR(complied_date, 'YYYY-MM-DD') AS complied_date,
           complied_hours::float, next_due_hours::float, TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date,
           report_entry_id, sort_order, notes
      FROM ad_items WHERE partnership_id = $1
     ORDER BY CASE applies_to WHEN 'airframe' THEN 1 WHEN 'engine' THEN 2 WHEN 'propeller' THEN 3 ELSE 4 END, sort_order`,
    [partnershipId]);
  if (!items.length) return { current_hours: null, report: null, items: [] };

  const entryCols = `e.id, TO_CHAR(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.category, e.page_number, e.summary`;
  const reportIds = items.map(i => i.report_entry_id).filter(Boolean);
  const { rows: reportEntries } = await pool.query(
    `SELECT ${entryCols}, e.document_id FROM logbook_entries e WHERE e.id = ANY($1::uuid[])`, [reportIds]);
  const { rows: manual } = await pool.query(`
    SELECT l.ad_item_id, ${entryCols} FROM ad_item_links l JOIN logbook_entries e ON e.id = l.entry_id
     WHERE l.ad_item_id = ANY($1::uuid[])`, [items.map(i => i.id)]);
  // Maintenance log entries (not compliance reports) that mention an AD or SB at all.
  const { rows: candidates } = await pool.query(`
    SELECT ${entryCols}, e.raw_text FROM logbook_entries e
     WHERE e.partnership_id = $1 AND e.category <> 'ad_sb_compliance'
       AND e.raw_text ~* '(\\mAD\\M|\\mSB|bulletin|directive)'`, [partnershipId]);

  const byId = new Map(reportEntries.map(e => [e.id, e]));
  const current = await reports.getCurrentFlightHours(partnershipId);

  const out = items.map(item => {
    const entries = [];
    const add = (e, role) => {
      if (!e || entries.some(x => x.id === e.id)) return;
      const { raw_text, document_id, ad_item_id, ...rest } = e;
      entries.push({ ...rest, role });
    };
    add(byId.get(item.report_entry_id), 'report');
    const re = numberPattern(item);
    const logged = [
      ...manual.filter(m => m.ad_item_id === item.id),
      ...(re ? candidates.filter(c => re.test(c.raw_text)) : []),
    ].sort((a, b) => (a.entry_date ?? '').localeCompare(b.entry_date ?? ''));
    for (const e of logged) add(e, 'log');
    const hours_remaining = item.next_due_hours != null && current != null ? +(item.next_due_hours - current).toFixed(1) : null;
    const { report_entry_id, ...rest } = item;
    return { ...rest, hours_remaining, entries };
  });

  // The report the AD lines came from: the document holding most of the report entries.
  const docCount = new Map();
  for (const e of reportEntries) docCount.set(e.document_id, (docCount.get(e.document_id) ?? 0) + 1);
  const topDoc = [...docCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  let report = null;
  if (topDoc) {
    // Report-level details (date, aircraft and engine times) are kept on each of its lines.
    const { rows: [d] } = await pool.query(`
      SELECT d.id, d.source_filename, d.page_count,
             (SELECT e.fields->>'report_date' FROM logbook_entries e WHERE e.document_id = d.id AND e.fields ? 'report_date' LIMIT 1) AS report_date,
             (SELECT e.fields->>'report_hours' FROM logbook_entries e WHERE e.document_id = d.id AND e.fields ? 'report_hours' LIMIT 1) AS report_hours
        FROM logbook_documents d WHERE d.id = $1`, [topDoc]);
    report = d ?? null;
  }
  return { current_hours: current, report, items: out };
}

module.exports = { getAdItems, numberPattern };
