const path = require('path');
// Parses a Garmin avionics data log ("Original CSV" from flyGarmin / Garmin Pilot): one row per
// second with position, air data and engine data. The file is three header lines —
//   #airframe_info, key="value", ...
//   #units row
//   column names (Lcl Date, Lcl Time, UTCOfst, AtvWpt, Latitude, ..., E1 CHT1..6, E1 EGT1..6, ...)
// — then data rows. Times are local with a UTC offset column. One file covers one engine run.

const SERIES_STEP = 5; // seconds between samples kept for charts

// Bump when the parser's stats change; stored logs with an older version are re-parsed at startup.
const PARSER_VERSION = 5;

// Continental IO-550-N (SR22) limits and the cautions we flag below them.
const LIMITS = {
  chtCaution: 420, chtRedline: 460,      // °F; 420 is the usual longevity ceiling
  oilTempCaution: 225, oilTempRedline: 240, // °F
  oilPressLow: 30, oilPressMin: 10, oilPressHigh: 70, // psi; green arc 30–60
  shockCoolRate: 50,                     // °F per minute CHT drop
  egtDip: 75,                            // °F single-cylinder EGT drop in 10 s while others hold
  voltLow: 26.0, ampDischarge: -2,       // 28 V system, after warm-up
  warmupSec: 120,
};

// Within-flight checks on the 1 Hz rows. Returns events: { type, severity, msg, at, cyl?, value }.
function findEvents(rows, num, running) {
  const events = [];
  const cyl = [1, 2, 3, 4, 5, 6];
  const add = (type, severity, msg, ms, extra = {}) => events.push({ type, severity, msg, at: new Date(ms).toISOString(), ...extra });
  const startMs = running[0]?.ms ?? rows[0].ms;
  const warm = running.filter(r => r.ms - startMs >= LIMITS.warmupSec * 1000 && (num(r, 'E1 RPM') ?? 0) > 1000);

  // Longest run of consecutive (≈1 s apart) rows satisfying pred: { secs, row, peak }. peak is the
  // highest value, or the lowest when low = true (for "below" checks).
  const sustained = (rs, pred, val, low = false) => {
    let best = { secs: 0 }, cur = null;
    const worse = (v, p) => (low ? v < p : v > p);
    for (const r of rs) {
      if (pred(r)) {
        if (!cur || r.ms - cur.last > 3000) cur = { first: r, last: r.ms, peak: val(r) };
        cur.last = r.ms;
        if (val(r) != null && (cur.peak == null || worse(val(r), cur.peak))) cur.peak = val(r);
        const secs = (cur.last - cur.first.ms) / 1000 + 1;
        if (secs > best.secs) best = { secs, row: cur.first, peak: cur.peak };
      } else cur = null;
    }
    return best;
  };

  for (const c of cyl) {
    const col = `E1 CHT${c}`;
    const hot = sustained(running, r => (num(r, col) ?? 0) > LIMITS.chtCaution, r => num(r, col));
    if (hot.secs >= 5) {
      const red = hot.peak > LIMITS.chtRedline;
      add('cht_high', red ? 'warning' : 'caution',
        `CHT #${c} reached ${Math.round(hot.peak)}°F (${red ? 'over redline' : `above ${LIMITS.chtCaution}°F`} for ${Math.round(hot.secs)} s)`,
        hot.row.ms, { cyl: c, value: Math.round(hot.peak) });
    }
  }

  // Shock cooling: fastest CHT drop over 60 s on any cylinder.
  let cool = null;
  for (let i = 0, j = 0; i < running.length; i++) {
    while (j < running.length && running[j].ms - running[i].ms < 60000) j++;
    if (j >= running.length) break;
    for (const c of cyl) {
      const a = num(running[i], `E1 CHT${c}`), b = num(running[j], `E1 CHT${c}`);
      if (a != null && b != null && a - b > (cool?.value ?? LIMITS.shockCoolRate)) cool = { value: a - b, cyl: c, ms: running[i].ms };
    }
  }
  if (cool) add('shock_cooling', 'caution', `Shock cooling: CHT #${cool.cyl} fell ${Math.round(cool.value)}°F in a minute`, cool.ms, { cyl: cool.cyl, value: Math.round(cool.value) });

  // Single-cylinder EGT dips while the others hold steady: a possible misfire (plug, injector, valve).
  const dips = {};
  for (let i = 10; i < warm.length; i++) {
    const r = warm[i], p = warm[i - 10];
    if (r.ms - p.ms > 15000) continue;
    const d = cyl.map(c => { const a = num(r, `E1 EGT${c}`), b = num(p, `E1 EGT${c}`); return a != null && b != null ? a - b : null; });
    if (d.some(v => v == null)) continue;
    d.forEach((v, k) => {
      const others = d.filter((_, m) => m !== k).sort((x, y) => x - y);
      const med = (others[2] + others[3]) / 2;
      if (v < -LIMITS.egtDip && Math.abs(med) < 25) {
        const c = k + 1;
        if (!dips[c] || r.ms - dips[c].lastMs > 30000) {
          dips[c] = { count: (dips[c]?.count ?? 0) + 1, lastMs: r.ms, firstMs: dips[c]?.firstMs ?? r.ms, worst: Math.min(dips[c]?.worst ?? 0, v) };
        } else {
          dips[c].lastMs = r.ms; dips[c].worst = Math.min(dips[c].worst, v);
        }
      }
    });
  }
  for (const [c, d] of Object.entries(dips)) {
    add('egt_dip', d.count >= 3 ? 'warning' : 'caution',
      `EGT #${c} dropped ${Math.round(-d.worst)}°F while other cylinders held steady${d.count > 1 ? ` (${d.count} times)` : ''} — possible misfire`,
      d.firstMs, { cyl: Number(c), value: d.count });
  }

  const oilT = sustained(running, r => (num(r, 'E1 OilT') ?? 0) > LIMITS.oilTempCaution, r => num(r, 'E1 OilT'));
  if (oilT.secs >= 10) {
    const red = oilT.peak > LIMITS.oilTempRedline;
    add('oil_temp_high', red ? 'warning' : 'caution', `Oil temperature reached ${Math.round(oilT.peak)}°F`, oilT.row.ms, { value: Math.round(oilT.peak) });
  }
  const oilLow = sustained(warm, r => { const v = num(r, 'E1 OilP'); return v != null && v < LIMITS.oilPressLow; }, r => num(r, 'E1 OilP'), true);
  if (oilLow.secs >= 10) {
    const min = warm.reduce((m, r) => Math.min(m, num(r, 'E1 OilP') ?? m), 999);
    add('oil_press_low', min < LIMITS.oilPressMin ? 'warning' : 'caution', `Oil pressure below ${LIMITS.oilPressLow} psi for ${Math.round(oilLow.secs)} s (low ${Math.round(min)} psi)`, oilLow.row.ms, { value: Math.round(min) });
  }
  const oilHigh = sustained(warm, r => (num(r, 'E1 OilP') ?? 0) > LIMITS.oilPressHigh, r => num(r, 'E1 OilP'));
  if (oilHigh.secs >= 10) add('oil_press_high', 'caution', `Oil pressure above ${LIMITS.oilPressHigh} psi for ${Math.round(oilHigh.secs)} s`, oilHigh.row.ms, { value: Math.round(oilHigh.peak) });

  const volt = sustained(warm, r => { const v = num(r, 'volt1'); return v != null && v < LIMITS.voltLow; }, r => num(r, 'volt1'), true);
  if (volt.secs >= 30) add('volts_low', 'warning', `Bus voltage below ${LIMITS.voltLow} V for ${Math.round(volt.secs)} s after warm-up (low ${volt.peak?.toFixed(1)} V) — alternator not charging?`, volt.row.ms, { value: volt.peak });
  const amps = sustained(warm, r => { const v = num(r, 'amp1'); return v != null && v < LIMITS.ampDischarge; }, r => num(r, 'amp1'), true);
  if (amps.secs >= 60) add('battery_discharge', 'caution', `Battery discharging (${amps.peak?.toFixed(1)} A) for ${Math.round(amps.secs)} s after warm-up`, amps.row.ms, { value: amps.peak });

  const rank = { warning: 0, caution: 1, info: 2 };
  return events.sort((a, b) => rank[a.severity] - rank[b.severity] || a.at.localeCompare(b.at));
}

// Columns kept in the chart series (key → CSV column) and their rounding.
const SERIES_COLS = {
  lat: ['Latitude', 5], lon: ['Longitude', 5], alt: ['AltMSL', 0], ias: ['IAS', 0], gs: ['GndSpd', 0],
  tas: ['TAS', 0], vs: ['VSpd', 0], oat: ['OAT', 0], rpm: ['E1 RPM', 0], map: ['E1 MAP', 1],
  ff: ['E1 FFlow', 1], pwr: ['E1 %Pwr', 2], oilt: ['E1 OilT', 0], oilp: ['E1 OilP', 0],
  fql: ['FQtyL', 1], fqr: ['FQtyR', 1], volt: ['volt1', 1], amp: ['amp1', 1],
  cht1: ['E1 CHT1', 0], cht2: ['E1 CHT2', 0], cht3: ['E1 CHT3', 0], cht4: ['E1 CHT4', 0], cht5: ['E1 CHT5', 0], cht6: ['E1 CHT6', 0],
  egt1: ['E1 EGT1', 0], egt2: ['E1 EGT2', 0], egt3: ['E1 EGT3', 0], egt4: ['E1 EGT4', 0], egt5: ['E1 EGT5', 0], egt6: ['E1 EGT6', 0],
};

const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

function parseMeta(line) {
  const meta = {};
  for (const m of line.matchAll(/(\w+)=("([^"]*)"|[^,\s]+)/g)) meta[m[1]] = m[3] ?? m[2];
  return meta;
}

function parseGarminLog(text, filename = '') {
  const lines = text.replace(/\r/g, '').split('\n');
  if (!lines[0]?.startsWith('#airframe_info')) {
    throw Object.assign(new Error('Not a Garmin data log (missing #airframe_info header)'), { status: 400 });
  }
  const meta = parseMeta(lines[0]);
  const headerIdx = lines.findIndex((l, i) => i > 0 && !l.startsWith('#') && /Lcl Date/.test(l));
  if (headerIdx < 0) throw Object.assign(new Error('Garmin data log has no column header row'), { status: 400 });
  const cols = lines[headerIdx].split(',').map(s => s.trim());
  const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
  const need = ['Lcl Date', 'Lcl Time', 'UTCOfst', 'E1 RPM'];
  for (const c of need) if (!(c in ix)) throw Object.assign(new Error(`Garmin data log is missing the ${c} column`), { status: 400 });

  // Parse rows with a timestamp into { ms, get(col) }.
  const rows = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const f = line.split(',').map(s => s.trim());
    const d = f[ix['Lcl Date']], t = f[ix['Lcl Time']];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{2}:\d{2}:\d{2}$/.test(t)) continue;
    const off = /^([+-])(\d{2}):(\d{2})$/.exec(f[ix.UTCOfst] || '+00:00') || ['', '+', '00', '00'];
    const offMin = (off[1] === '-' ? -1 : 1) * (parseInt(off[2], 10) * 60 + parseInt(off[3], 10));
    const ms = Date.parse(`${d}T${t}Z`) - offMin * 60000;
    rows.push({ ms, f });
  }
  if (rows.length < 30) throw Object.assign(new Error('Garmin data log has too few data rows'), { status: 400 });

  const num = (r, col) => {
    const i = ix[col];
    if (i == null) return null;
    const v = r.f[i];
    if (v === '' || v == null) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  const running = rows.filter(r => (num(r, 'E1 RPM') ?? 0) > 500);
  const airborne = rows.filter(r => (num(r, 'IAS') ?? 0) > 50);
  const first = (a) => a[0]?.ms ?? null, last = (a) => a[a.length - 1]?.ms ?? null;
  const hrs = (a, b) => (a && b ? round((b - a) / 3600000, 2) : null);

  // Fuel burned: integrate fuel flow (gph) over time.
  let fuelUsed = 0;
  for (let i = 1; i < rows.length; i++) {
    const dt = Math.min(10, (rows[i].ms - rows[i - 1].ms) / 1000);
    fuelUsed += ((num(rows[i], 'E1 FFlow') ?? 0) * dt) / 3600;
  }
  const fuelQty = (r) => {
    const l = num(r, 'FQtyL'), rr = num(r, 'FQtyR');
    return l == null && rr == null ? null : (l ?? 0) + (rr ?? 0);
  };
  const qtyAvg = (rs) => round(avg(rs.map(fuelQty).filter(v => v != null)), 1);

  // Peaks over the engine run; oil pressure only once running steadily (>1000 rpm).
  const cyl = [1, 2, 3, 4, 5, 6];
  const maxOf = (rs, col) => rs.reduce((m, r) => { const v = num(r, col); return v != null && (m == null || v > m) ? v : m; }, null);
  const minOf = (rs, col) => rs.reduce((m, r) => { const v = num(r, col); return v != null && (m == null || v < m) ? v : m; }, null);
  const chtMax = cyl.map(c => round(maxOf(running, `E1 CHT${c}`), 0));
  const egtMax = cyl.map(c => round(maxOf(running, `E1 EGT${c}`), 0));
  const steady = running.filter(r => (num(r, 'E1 RPM') ?? 0) > 1000);
  const hottest = chtMax.reduce((b, v, i) => (v != null && (b == null || v > chtMax[b]) ? i : b), null);

  // Cruise: airborne, level (|VS| < 300 fpm), above 40% power. Averages are what trend over time.
  const cruise = airborne.filter(r => Math.abs(num(r, 'VSpd') ?? 999) < 300 && (num(r, 'E1 %Pwr') ?? 0) > 0.4);
  const cAvg = (col, d = 0) => round(avg(cruise.map(r => num(r, col)).filter(v => v != null)), d);
  const cruiseStats = cruise.length >= 60 ? {
    minutes: round(cruise.length / 60, 0),
    cht: cyl.map(c => cAvg(`E1 CHT${c}`)), egt: cyl.map(c => cAvg(`E1 EGT${c}`)),
    oilt: cAvg('E1 OilT'), oilp: cAvg('E1 OilP'), ff: cAvg('E1 FFlow', 1), map: cAvg('E1 MAP', 1),
    rpm: cAvg('E1 RPM'), pwr: cAvg('E1 %Pwr', 2), tas: cAvg('TAS'), alt: cAvg('AltMSL'), oat: cAvg('OAT'),
  } : null;

  // Airports: departure from the filename (log_YYMMDD_HHMMSS_KPAO.csv), arrival = last
  // 4-letter active waypoint (airports are 4 letters; fixes are 5, VORs 3, runways have digits).
  // Garmin Pilot exports are named for the route instead: YYYY-MM-DD-FROM-TO.csv (a long log may
  // come split as …_1.csv, …_2.csv); both airports come from that name.
  const gp = /^\d{4}-\d{2}-\d{2}-([A-Z0-9]{3,4})-([A-Z0-9]{3,4})(?:_\d+)?(?:\.csv)+$/i.exec(path.basename(filename));
  const fnAirport = gp ? gp[1].toUpperCase() : /_([A-Z0-9]{3,4})(?:\.csv)+$/i.exec(filename)?.[1]?.toUpperCase() || null;
  let dest = gp ? gp[2].toUpperCase() : null;
  if (!dest && 'AtvWpt' in ix) {
    for (let i = rows.length - 1; i >= 0 && !dest; i--) {
      const w = rows[i].f[ix.AtvWpt];
      if (/^[A-Z]{4}$/.test(w)) dest = w;
    }
  }

  if (!dest && fnAirport && 'Latitude' in ix) {
    const pos = rows.filter(r => num(r, 'Latitude') != null && num(r, 'Longitude') != null);
    const a = pos[0], z = pos[pos.length - 1];
    if (a && z && Math.abs(num(a, 'Latitude') - num(z, 'Latitude')) < 0.05 && Math.abs(num(a, 'Longitude') - num(z, 'Longitude')) < 0.05) dest = fnAirport;
  }

  // Chart series, one sample every SERIES_STEP seconds.
  const t0 = rows[0].ms;
  const series = { t0, step: SERIES_STEP, t: [], ...Object.fromEntries(Object.keys(SERIES_COLS).map(k => [k, []])) };
  let nextT = -1;
  for (const r of rows) {
    const sec = Math.round((r.ms - t0) / 1000);
    if (sec < nextT) continue;
    nextT = sec + SERIES_STEP;
    series.t.push(sec);
    for (const [k, [col, d]] of Object.entries(SERIES_COLS)) series[k].push(round(num(r, col), d));
  }
  for (const k of Object.keys(SERIES_COLS)) if (series[k].every(v => v == null)) delete series[k];

  return {
    meta: { airframe: meta.airframe_name || null, system_id: meta.system_id || null, software: meta.system_software_part_number || null },
    started_at: new Date(rows[0].ms),
    ended_at: new Date(rows[rows.length - 1].ms),
    engine_on_at: first(running) ? new Date(first(running)) : null,
    engine_off_at: last(running) ? new Date(last(running)) : null,
    takeoff_at: first(airborne) ? new Date(first(airborne)) : null,
    landing_at: last(airborne) ? new Date(last(airborne)) : null,
    engine_hrs: hrs(first(running), last(running)),
    air_hrs: hrs(first(airborne), last(airborne)),
    fuel_used_gal: round(fuelUsed, 1),
    fuel_start_gal: qtyAvg(running.slice(0, 30)),
    fuel_end_gal: qtyAvg(running.slice(-30)),
    origin: fnAirport,
    destination: dest,
    max_cht: hottest == null ? null : chtMax[hottest],
    max_cht_cyl: hottest == null ? null : hottest + 1,
    stats: {
      v: PARSER_VERSION,
      events: findEvents(rows, num, running),
      cht_max: chtMax, egt_max: egtMax,
      oilt_max: round(maxOf(running, 'E1 OilT'), 0),
      oilp_min: round(minOf(steady, 'E1 OilP'), 0), oilp_max: round(maxOf(steady, 'E1 OilP'), 0),
      alt_max: round(maxOf(rows, 'AltMSL'), 0), gs_max: round(maxOf(rows, 'GndSpd'), 0),
      tas_max: round(maxOf(rows, 'TAS'), 0),
      volt_min: round(minOf(steady.filter(r => r.ms - (running[0]?.ms ?? 0) >= LIMITS.warmupSec * 1000), 'volt1'), 1),
      cruise: cruiseStats,
    },
    series,
  };
}

module.exports = { parseGarminLog, PARSER_VERSION, LIMITS };
