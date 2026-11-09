const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pool = require('../db');
const { parseGarminLog, PARSER_VERSION } = require('./garminLog');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

// Engine monitoring across Garmin data logs:
//  - events: limit exceedances and in-flight events found by the parser (stats.events)
//  - outliers: a run whose cruise numbers sit far outside this engine's own history
//  - trends: the last few runs shifted away from the earlier baseline
// Cylinder temperatures are compared as each cylinder's difference from that run's average of
// all six, which cancels power setting, altitude and outside air temperature — what's left is
// the cylinder itself (plugs, injector, valves, baffling, probe).

const MIN_HISTORY = 5;   // prior runs with cruise data before outlier checks start
const RECENT = 5;        // runs in the "recent" window for trend checks
const MIN_TREND = 10;    // runs with cruise data before trend checks start
const BASELINE_MAX = 20; // prior runs used as the baseline

// Metric definitions. scale = smallest believable spread (floors the MAD so a very steady
// history doesn't flag noise); delta = smallest difference worth reporting.
const CYL = [1, 2, 3, 4, 5, 6];
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const devs = (arr) => {
  if (!arr || arr.some(v => v == null)) return null;
  const m = mean(arr);
  return arr.map(v => v - m);
};
const METRICS = [
  ...CYL.map(c => ({
    key: `cht_dev${c}`, label: `CHT #${c} vs. average`, unit: '°F', scale: 5, delta: 15, trendDelta: 10, cyl: c,
    get: (r) => devs(r.stats.cruise?.cht)?.[c - 1] ?? null,
  })),
  ...CYL.map(c => ({
    key: `egt_dev${c}`, label: `EGT #${c} vs. average`, unit: '°F', scale: 15, delta: 40, trendDelta: 30, cyl: c,
    get: (r) => devs(r.stats.cruise?.egt)?.[c - 1] ?? null,
  })),
  { key: 'cht_spread', label: 'Cruise CHT spread', unit: '°F', scale: 6, delta: 20, trendDelta: 15,
    get: (r) => { const a = r.stats.cruise?.cht; return a && a.every(v => v != null) ? Math.max(...a) - Math.min(...a) : null; } },
  { key: 'oilt', label: 'Cruise oil temperature', unit: '°F', scale: 4, delta: 12, trendDelta: 8, get: (r) => r.stats.cruise?.oilt ?? null },
  { key: 'oilp', label: 'Cruise oil pressure', unit: ' psi', scale: 1.5, delta: 5, trendDelta: 4, get: (r) => r.stats.cruise?.oilp ?? null },
  { key: 'ff_per_pwr', label: 'Fuel flow at cruise power', unit: ' gph per 65%', scale: 0.4, delta: 1.5, trendDelta: 1.0,
    get: (r) => { const c = r.stats.cruise; return c?.ff != null && c?.pwr ? (c.ff / c.pwr) * 0.65 : null; } },
];

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (v, unit) => `${v > 0 ? '+' : ''}${Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(1)}${unit}`;
const fmtAbs = (v, unit) => `${Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(1)}${unit}`;
const runDate = (r) => new Date(r.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: process.env.APP_TIMEZONE || 'America/New_York' });

// What a shift in a metric might mean, for the finding's detail line.
function hint(m, dir) {
  if (m.key.startsWith('cht_dev')) return dir > 0 ? 'Check baffling, injector flow and the CHT probe for this cylinder.' : 'Check the CHT probe; a cooler cylinder can also mean low compression.';
  if (m.key.startsWith('egt_dev')) return dir > 0 ? 'Hotter EGT on one cylinder can point to a lean injector or a valve issue.' : 'Cooler EGT on one cylinder can point to a plug, ignition or probe issue.';
  if (m.key === 'cht_spread') return 'Cylinders are cooling less evenly; check baffling and injector balance.';
  if (m.key === 'oilt') return dir > 0 ? 'Check oil cooler airflow/baffling and oil level.' : null;
  if (m.key === 'oilp') return dir < 0 ? 'Falling oil pressure is worth watching; check oil level and the pressure sender.' : null;
  if (m.key === 'ff_per_pwr') return 'Fuel flow for the same power changed; may be leaning technique, or injector/fuel flow transducer.';
  return null;
}

// runs: oldest first, each { id, started_at, stats, ... }; acks: { finding_key: { note, acked_at, acked_by_name } }.
// Returns { findings (active), addressed, marks, history }.
function analyze(runs, acks = {}) {
  const findings = [];
  const marks = {}; // metric key -> run ids flagged (for chart dots)
  const mark = (key, id) => { (marks[key] ||= []).push(id); };

  // 1. Events the parser found within each flight.
  for (const r of runs) {
    for (const e of r.stats.events || []) {
      findings.push({ key: `event:${e.type}:${e.cyl ?? ''}:${r.id}`, kind: e.type === 'cht_high' || e.type.startsWith('oil_') ? 'limit' : 'event', severity: e.severity, title: e.msg, detail: null, log_id: r.id, at: e.at, metric: e.type });
      if (e.cyl && e.type === 'cht_high') mark(`cht_max${e.cyl}`, r.id);
    }
  }

  const cruiseRuns = runs.filter(r => r.stats.cruise);
  for (const m of METRICS) {
    const series = cruiseRuns.map(r => ({ r, v: m.get(r) })).filter(p => p.v != null);

    // 2. Outliers: each run against up to BASELINE_MAX runs before it. Consecutive outlying runs
    // in the same direction are reported once ("on 4 flights since …").
    const hits = [];
    for (let i = MIN_HISTORY; i < series.length; i++) {
      const base = series.slice(Math.max(0, i - BASELINE_MAX), i).map(p => p.v);
      const med = median(base);
      const mad = median(base.map(v => Math.abs(v - med))) * 1.4826;
      const sigma = Math.max(mad, m.scale);
      const diff = series[i].v - med;
      if (Math.abs(diff) >= m.delta && Math.abs(diff) / sigma >= 3) hits.push({ i, p: series[i], med, diff, z: Math.abs(diff) / sigma });
    }
    const groups = [];
    for (const h of hits) {
      const g = groups[groups.length - 1];
      if (g && h.i === g[g.length - 1].i + 1 && Math.sign(h.diff) === Math.sign(g[0].diff)) g.push(h);
      else groups.push([h]);
    }
    for (const g of groups) {
      const first = g[0], last = g[g.length - 1];
      const worst = g.reduce((w, h) => (h.z > w.z ? h : w), first);
      const when = g.length === 1 ? `on ${runDate(first.p.r)}` : `on ${g.length} flights in a row since ${runDate(first.p.r)}`;
      findings.push({
        key: `outlier:${m.key}:${first.p.r.id}`,
        kind: 'outlier', severity: worst.z >= 5 ? 'warning' : 'caution',
        title: `${m.label} ${g.length === 1 ? 'was' : 'has been'} ${fmtAbs(last.p.v, m.unit)} ${when} — ${fmt(first.diff, m.unit)} from its usual ${fmtAbs(first.med, m.unit)}`,
        detail: hint(m, Math.sign(first.diff)), log_id: last.p.r.id, at: last.p.r.started_at, metric: m.key,
      });
      g.forEach(h => mark(m.key, h.p.r.id));
    }

    // 3. Trend shift: the last RECENT runs vs. the baseline before them.
    if (series.length >= MIN_TREND) {
      const recent = series.slice(-RECENT);
      const base = series.slice(Math.max(0, series.length - RECENT - BASELINE_MAX), -RECENT).map(p => p.v);
      const bMed = median(base), rMed = median(recent.map(p => p.v));
      const shift = rMed - bMed;
      const sameSide = recent.filter(p => Math.sign(p.v - bMed) === Math.sign(shift)).length;
      const covered = groups.some(g => g[g.length - 1].i === series.length - 1 && g.length >= RECENT - 1);
      if (!covered && Math.abs(shift) >= m.trendDelta && sameSide >= RECENT - 1) {
        findings.push({
          key: `trend:${m.key}`, since: recent[0].r.started_at,
          kind: 'trend', severity: Math.abs(shift) >= m.trendDelta * 2 ? 'warning' : 'caution',
          title: `${m.label} has shifted ${fmt(shift, m.unit)} over the last ${RECENT} flights (now ${fmtAbs(rMed, m.unit)}, was ${fmtAbs(bMed, m.unit)})`,
          detail: hint(m, Math.sign(shift)), log_id: recent[recent.length - 1].r.id, at: recent[recent.length - 1].r.started_at, metric: m.key,
        });
        recent.forEach(p => mark(m.key, p.r.id));
      }
    }
  }

  // Addressed findings move to their own list. A trend comes back only once all of its recent
  // flights were flown after it was marked addressed, i.e. the shift persisted after the fix.
  const active = [], addressed = [];
  for (const f of findings) {
    const ack = acks[f.key];
    const stillHidden = ack && (f.kind !== 'trend' || new Date(f.since) < new Date(ack.acked_at));
    if (stillHidden) addressed.push({ ...f, ack });
    else active.push(f);
  }

  const rank = { warning: 0, caution: 1, info: 2 };
  const order = (a, b) => rank[a.severity] - rank[b.severity] || String(b.at).localeCompare(String(a.at));
  active.sort(order);
  addressed.sort((a, b) => String(b.ack.acked_at).localeCompare(String(a.ack.acked_at)));
  return {
    findings: active, addressed, marks,
    history: { cruise_runs: cruiseRuns.length, outliers_from: MIN_HISTORY + 1, trends_from: MIN_TREND },
  };
}
// Runs (newest `limit`) plus the analysis of them, with the partnership's acks applied.
async function loadAnalysis(partnershipId, limit) {
  const { rows } = await pool.query(
    `SELECT g.id, g.flight_id, g.filename, g.started_at, g.engine_on_at, g.engine_off_at, g.takeoff_at, g.landing_at,
            g.engine_hrs::float, g.air_hrs::float, g.fuel_used_gal::float, g.origin, g.destination,
            g.max_cht::float, g.max_cht_cyl, g.stats, TO_CHAR(f.flight_date, 'YYYY-MM-DD') AS flight_date,
            COALESCE(f.pilot_name, u.name) AS pilot_name
     FROM garmin_data_logs g
     LEFT JOIN flights f ON f.id = g.flight_id
     LEFT JOIN users u ON u.id = f.pilot_id
     WHERE g.partnership_id = $1
     ORDER BY g.started_at DESC LIMIT $2`,
    [partnershipId, limit]);
  const runs = rows.reverse();
  const { rows: ackRows } = await pool.query(
    `SELECT a.finding_key, a.note, a.acked_at, u.name AS acked_by_name
     FROM engine_finding_acks a LEFT JOIN users u ON u.id = a.acked_by WHERE a.partnership_id = $1`, [partnershipId]);
  const acks = Object.fromEntries(ackRows.map(r => [r.finding_key, { note: r.note, acked_at: r.acked_at, acked_by_name: r.acked_by_name }]));
  return { runs, ...analyze(runs, acks) };
}

// Re-parse stored logs from an older parser version (new stats/events), from the original CSVs.
async function reparseStale() {
  const { rows } = await pool.query(
    `SELECT id, file_key, filename FROM garmin_data_logs WHERE COALESCE((stats->>'v')::int, 0) < $1`, [PARSER_VERSION]);
  let n = 0;
  for (const r of rows) {
    try {
      const text = zlib.gunzipSync(fs.readFileSync(path.join(UPLOADS_DIR, r.file_key))).toString('utf8');
      const log = parseGarminLog(text, r.filename || '');
      await pool.query(
        `UPDATE garmin_data_logs SET engine_on_at=$2, engine_off_at=$3, takeoff_at=$4, landing_at=$5, engine_hrs=$6, air_hrs=$7,
           fuel_used_gal=$8, fuel_start_gal=$9, fuel_end_gal=$10, max_cht=$11, max_cht_cyl=$12, stats=$13, series=$14,
           origin=$15, destination=$16
         WHERE id=$1`,
        [r.id, log.engine_on_at, log.engine_off_at, log.takeoff_at, log.landing_at, log.engine_hrs, log.air_hrs,
         log.fuel_used_gal, log.fuel_start_gal, log.fuel_end_gal, log.max_cht, log.max_cht_cyl, log.stats, log.series,
         log.origin, log.destination]);
      n++;
    } catch (err) {
      console.error(`[garmin] re-parse of ${r.filename} failed:`, err.message);
    }
  }
  if (n) console.log(`[garmin] re-parsed ${n} log(s) to parser v${PARSER_VERSION}`);
  return n;
}

module.exports = { analyze, loadAnalysis, reparseStale, METRICS };
