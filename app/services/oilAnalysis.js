const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const OIL_DIR = path.join(UPLOADS_DIR, 'maintenance', 'oil-analysis');

// Spectrographic elements in the order labs (Blackstone) print them, with what each usually
// points to in a piston aircraft engine.
const ELEMENTS = [
  ['aluminum',   'Al', 'pistons, case'],
  ['chromium',   'Cr', 'piston rings, cylinder barrels'],
  ['iron',       'Fe', 'cylinders, cam/lifters, crankshaft, gears'],
  ['copper',     'Cu', 'bushings, oil cooler'],
  ['lead',       'Pb', '100LL blow-by'],
  ['tin',        'Sn', 'bearings, bronze parts'],
  ['molybdenum', 'Mo', 'piston rings, additive'],
  ['nickel',     'Ni', 'exhaust valves/guides, cylinders'],
  ['manganese',  'Mn', 'valves'],
  ['silver',     'Ag', 'bearings'],
  ['titanium',   'Ti', 'alloys'],
  ['potassium',  'K',  'coolant/additive'],
  ['boron',      'B',  'additive, dirt'],
  ['silicon',    'Si', 'dirt (air filtration), sealers'],
  ['sodium',     'Na', 'additive, contamination'],
  ['calcium',    'Ca', 'additive'],
  ['magnesium',  'Mg', 'additive, case'],
  ['phosphorus', 'P',  'additive (e.g. CamGuard)'],
  ['zinc',       'Zn', 'additive, brass'],
  ['barium',     'Ba', 'additive'],
];
const ELEMENT_KEYS = ELEMENTS.map(e => e[0]);
const PROPERTY_KEYS = ['sus_viscosity_210f', 'cst_viscosity_100c', 'flashpoint_f', 'fuel_pct', 'antifreeze_pct', 'water_pct', 'insolubles_pct'];
// Wear metals whose per-hour rate is worth trending (lead is mostly fuel, not wear).
const WEAR_METALS = ['iron', 'chromium', 'nickel', 'aluminum', 'copper', 'tin', 'silicon'];

const PROMPT = `You are reading an engine oil analysis lab report (for example Blackstone Laboratories) \
for a piston aircraft engine. Transcribe numbers exactly; never guess a value you cannot read.

A report page shows the CURRENT sample in its first column, the lab's comments for it, and up to \
six EARLIER samples in the following columns (ignore the "unit/location averages" and \
"universal averages" columns). A PDF may contain several reports (one per page).

Return ONLY a JSON array (no markdown fences, no commentary), one element per report page:
{
  "page_number": <int, 1-based>,
  "lab": "<laboratory name>",
  "lab_number": "<lab/sample number>",
  "report_date": "<YYYY-MM-DD>",
  "engine": "<equipment make/model>",
  "oil_type": "<oil type and grade>",
  "submitted_by": "<shop or client company name only, no address/phone/email>",
  "comments": "<the lab's comments, verbatim>",
  "samples": [   // first = the current sample, then each earlier column left to right
    {
      "sample_date": "<YYYY-MM-DD>",
      "oil_hours": <number or null>,      // MI/HR on oil
      "unit_hours": <number or null>,     // MI/HR on unit (engine)
      "makeup_oil": "<e.g. '3 qts' or null>",
      "elements": { ${ELEMENT_KEYS.map(k => `"${k}": <ppm int>`).join(', ')} },
      "properties": { ${PROPERTY_KEYS.map(k => `"${k}": "<value as printed, e.g. '93.5', '<0.5', 'TR', 'POS', '-'>"`).join(', ')} },
      "flags": ["<element or property keys the lab printed in bold>"]
    }
  ]
}`;

const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

function cleanSample(s) {
  const elements = {};
  for (const k of ELEMENT_KEYS) if (num(s.elements?.[k]) !== null) elements[k] = num(s.elements[k]);
  const properties = {};
  for (const k of PROPERTY_KEYS) if (s.properties?.[k] != null && s.properties[k] !== '') properties[k] = String(s.properties[k]);
  const known = new Set([...ELEMENT_KEYS, ...PROPERTY_KEYS]);
  return {
    sample_date: isoDate(s.sample_date),
    oil_hours: num(s.oil_hours),
    unit_hours: num(s.unit_hours),
    makeup_oil: s.makeup_oil || null,
    elements, properties,
    flags: (Array.isArray(s.flags) ? s.flags : []).filter(f => known.has(f)),
  };
}

// Insert or merge one sample. A sample's own report (source 'report') is authoritative; a history
// column from a later report only fills in a sample we don't have yet.
async function upsertSample(db, partnershipId, sample, meta) {
  if (!sample.sample_date) return null;
  // Engine hours identify a sample better than the date: a lab's history columns repeat whatever date
  // the lab recorded, even after we have corrected a typo (e.g. 4/17 vs 5/17 at 1327 hrs). So a sample at
  // the same engine hours within ~6 weeks is the same sample; without hours, fall back to the exact date.
  const { rows: [existing] } = await db.query(
    `SELECT id, source FROM oil_analysis_samples
     WHERE partnership_id = $1 AND (
       ($3::numeric IS NOT NULL AND unit_hours = $3 AND ABS(sample_date - $2::date) <= 45)
       OR ($3::numeric IS NULL AND unit_hours IS NULL AND sample_date = $2))
     ORDER BY ABS(sample_date - $2::date) LIMIT 1`,
    [partnershipId, sample.sample_date, sample.unit_hours]);
  if (existing && meta.source === 'history') return existing.id;

  const vals = [
    partnershipId, meta.file_id ?? null, meta.page_number ?? null, meta.source,
    meta.lab ?? null, meta.lab_number ?? null, isoDate(meta.report_date), sample.sample_date,
    sample.oil_hours, sample.unit_hours, sample.makeup_oil, meta.oil_type ?? null, meta.engine ?? null,
    meta.submitted_by ?? null, JSON.stringify(sample.elements), JSON.stringify(sample.properties), sample.flags,
    meta.source === 'report' ? (meta.comments ?? null) : null, meta.notes ?? null,
  ];
  if (existing) {
    await db.query(
      `UPDATE oil_analysis_samples SET file_id = $2, page_number = $3, source = $4, lab = $5, lab_number = $6,
         report_date = $7, sample_date = $8, oil_hours = $9, unit_hours = $10, makeup_oil = $11, oil_type = $12,
         engine = $13, submitted_by = $14, elements = $15, properties = $16, flags = $17, comments = $18,
         notes = COALESCE($19, notes)
       WHERE id = $20`, [...vals, existing.id]);
    return existing.id;
  }
  const { rows: [row] } = await db.query(
    `INSERT INTO oil_analysis_samples (partnership_id, file_id, page_number, source, lab, lab_number, report_date,
       sample_date, oil_hours, unit_hours, makeup_oil, oil_type, engine, submitted_by, elements, properties, flags,
       comments, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`, vals);
  return row.id;
}

// Store a set of parsed reports (from Claude or a manual transcription) against a file.
async function storeReports(partnershipId, fileId, reports) {
  const client = await pool.connect();
  let stored = 0;
  try {
    await client.query('BEGIN');
    // Current samples first, so a report's own column always wins over another report's history.
    for (const r of reports) {
      const [current] = r.samples || [];
      if (current && await upsertSample(client, partnershipId, cleanSample(current),
        { ...r, file_id: fileId, source: 'report' })) stored++;
    }
    for (const r of reports) {
      for (const s of (r.samples || []).slice(1)) {
        await upsertSample(client, partnershipId, cleanSample(s),
          { lab: r.lab, engine: r.engine, oil_type: r.oil_type, file_id: fileId, page_number: r.page_number, source: 'history' });
      }
    }
    const pages = reports.reduce((m, r) => Math.max(m, r.page_number || 1), 1);
    await client.query(`UPDATE oil_analysis_files SET status = 'processed', processed_at = NOW(), page_count = $2, error_message = NULL WHERE id = $1`,
      [fileId, pages]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { reports: reports.length, stored };
}

// Read an uploaded report PDF with Claude and store its samples.
async function processFile(fileId) {
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Oil analysis import is not configured'), { status: 503 });
  const { rows: [file] } = await pool.query('SELECT * FROM oil_analysis_files WHERE id = $1', [fileId]);
  if (!file) throw Object.assign(new Error('File not found'), { status: 404 });
  const buffer = fs.readFileSync(path.join(UPLOADS_DIR, file.file_key));
  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.stream({
      model: 'claude-sonnet-5-5',
      max_tokens: 32000,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
        { type: 'text', text: PROMPT },
      ] }],
    }).finalMessage();
    const text = (msg.content.find(b => b.type === 'text')?.text ?? '').trim().replace(/^```json\s*/, '').replace(/```$/, '');
    const match = text.match(/\[[\s\S]*\]/);
    const reports = JSON.parse(match ? match[0] : text);
    if (!Array.isArray(reports) || !reports.length) throw new Error('No oil analysis reports found in the file');
    return await storeReports(file.partnership_id, fileId, reports);
  } catch (err) {
    await pool.query(`UPDATE oil_analysis_files SET status = 'error', error_message = $2 WHERE id = $1`, [fileId, err.message]);
    throw err;
  }
}

async function listSamples(partnershipId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.file_id, s.page_number, s.source, s.lab, s.lab_number,
            TO_CHAR(s.report_date, 'YYYY-MM-DD') AS report_date, TO_CHAR(s.sample_date, 'YYYY-MM-DD') AS sample_date,
            s.oil_hours::float, s.unit_hours::float, s.makeup_oil, s.oil_type, s.engine, s.submitted_by,
            s.elements, s.properties, s.flags, s.comments, s.notes, f.filename
     FROM oil_analysis_samples s LEFT JOIN oil_analysis_files f ON f.id = s.file_id
     WHERE s.partnership_id = $1
     ORDER BY s.sample_date DESC, s.unit_hours DESC NULLS LAST`, [partnershipId]);
  return rows;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Simple, explainable trend notes: each wear metal's latest wear rate (ppm per oil hour) against
// this engine's own history, plus contamination readings and what the lab flagged.
function computeTrends(samples) {
  const notes = [];
  const withHours = samples.filter(s => s.oil_hours > 0);
  if (withHours.length < 3) return notes;
  const [latest, ...prior] = withHours;
  for (const m of WEAR_METALS) {
    const rate = (s) => (s.elements?.[m] ?? null) === null ? null : s.elements[m] / s.oil_hours;
    const hist = prior.map(rate).filter(r => r !== null);
    const now = rate(latest);
    if (now === null || hist.length < 2) continue;
    const base = median(hist);
    const label = ELEMENTS.find(e => e[0] === m);
    const ratio = base > 0 ? now / base : null;
    if (ratio !== null && (ratio >= 1.5 || ratio <= 0.6) && Math.abs(now - base) * latest.oil_hours >= 2) {
      notes.push({
        level: ratio >= 1.5 ? 'watch' : 'good',
        metal: m,
        text: `${label[0][0].toUpperCase() + label[0].slice(1)} (${label[2]}) is ${ratio >= 1.5 ? 'up' : 'down'}: `
          + `${now.toFixed(2)} ppm/hr in the latest sample vs ${base.toFixed(2)} typical for this engine.`,
      });
    }
  }
  // Longer-term shift: the last five samples against everything before them. Short oil runs read
  // higher per hour (less time to dilute the first hours' wear), so say when intervals changed.
  if (withHours.length >= 10) {
    const last = withHours.slice(0, 5), earlier = withHours.slice(5);
    for (const m of WEAR_METALS) {
      const rates = (xs) => xs.map(s => s.elements?.[m] == null ? null : s.elements[m] / s.oil_hours).filter(r => r !== null);
      const a = median(rates(last)), b = median(rates(earlier));
      const runs = (xs) => median(xs.map(s => s.oil_hours));
      // Ignore shifts too small to matter: under ~3 ppm over a typical recent oil run.
      if (!(b > 0) || a / b < 1.6 || (a - b) * runs(last) < 3 || notes.some(n => n.metal === m)) continue;
      const label = ELEMENTS.find(e => e[0] === m);
      notes.push({
        level: 'watch', metal: m,
        text: `${label[0][0].toUpperCase() + label[0].slice(1)} (${label[2]}) has run about ${(a / b).toFixed(1)}× its earlier wear rate over the last five samples `
          + `(${a.toFixed(2)} vs ${b.toFixed(2)} ppm/hr)${runs(last) < runs(earlier) * 0.75 ? `; oil runs are also shorter now (${runs(last)} vs ${runs(earlier)} hrs), which raises per-hour readings` : ''}.`,
      });
    }
  }
  const recent = withHours.slice(0, 4);
  if (recent.some(s => /^(TR|[1-9]|0\.[5-9])/.test(s.properties?.fuel_pct || ''))) {
    notes.push({ level: 'watch', text: 'Fuel dilution showed up in one of the last four samples.' });
  }
  if (recent.some(s => s.properties?.water_pct && !/^0(\.0)?$|^-$/.test(s.properties.water_pct))) {
    notes.push({ level: 'watch', text: 'Water was detected in one of the last four samples.' });
  }
  if (latest.flags?.length) notes.push({ level: 'watch', text: `The lab flagged ${latest.flags.join(', ')} on the latest sample.` });
  return notes;
}

// Plain-text corpus for the maintenance chat, one block per sample.
function chatCorpus(samples) {
  return samples.map(s => {
    const metals = ELEMENTS.filter(([k]) => s.elements?.[k] !== undefined).map(([k, sym]) => `${sym} ${s.elements[k]}`).join(', ');
    const props = Object.entries(s.properties || {}).map(([k, v]) => `${k} ${v}`).join(', ');
    return `ID:oil:${s.id} | oil analysis | ${s.lab || 'lab'} ${s.lab_number || ''} | sample ${s.sample_date}\n`
      + `Oil hours ${s.oil_hours ?? '?'}, engine hours ${s.unit_hours ?? '?'}${s.makeup_oil ? `, make-up oil ${s.makeup_oil}` : ''}. `
      + `Submitted by ${s.submitted_by || '?'}.\nWear metals (ppm): ${metals}\nProperties: ${props}`
      + `${s.flags?.length ? `\nFlagged by lab: ${s.flags.join(', ')}` : ''}`
      + `${s.comments ? `\nLab comments: ${s.comments}` : ''}${s.notes ? `\nNote: ${s.notes}` : ''}`;
  }).join('\n\n---\n\n');
}

// Pair logbook oil-change entries with the oil sample drawn at that change: same engine hours
// (within 3 hrs) and within ~6 weeks of the entry date. Returns Map(entryId -> sample summary).
const ENTRY_HOURS_KEYS = ['eng_tt', 'aircraft_tt', 'total_time', 'flighttime', 'flt_tach'];
function isOilChangeEntry(e) {
  return (e.tags || []).some(t => t === 'oil-change' || t === 'oil-analysis')
    || /oil change/i.test(e.summary || '');
}
async function matchSamplesToEntries(partnershipId, entries) {
  const out = new Map();
  const candidates = entries.filter(isOilChangeEntry);
  if (!candidates.length) return out;
  const samples = (await listSamples(partnershipId)).filter(s => s.unit_hours != null);
  const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;
  for (const e of candidates) {
    const hrsRaw = ENTRY_HOURS_KEYS.map(k => e.fields?.[k]).find(v => v != null && !isNaN(parseFloat(v)));
    if (hrsRaw == null || !e.entry_date) continue;
    const hrs = parseFloat(hrsRaw);
    const best = samples
      .filter(s => Math.abs(s.unit_hours - hrs) <= 3 && days(s.sample_date, e.entry_date) <= 45)
      .sort((a, b) => days(a.sample_date, e.entry_date) - days(b.sample_date, e.entry_date))[0];
    if (!best) continue;
    out.set(e.id, {
      id: best.id, sample_date: best.sample_date, unit_hours: best.unit_hours, lab_number: best.lab_number,
      flagged: (best.flags || []).length > 0,
      url: best.file_id ? `/api/oil-analysis/files/${best.file_id}/file${best.page_number ? `#page=${best.page_number}` : ''}` : null,
    });
  }
  return out;
}

module.exports = { matchSamplesToEntries, OIL_DIR, ELEMENTS, ELEMENT_KEYS, PROPERTY_KEYS, WEAR_METALS, processFile, storeReports, listSamples, computeTrends, chatCorpus };
