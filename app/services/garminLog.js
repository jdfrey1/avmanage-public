const path = require('path');
// Parses a Garmin avionics data log ("Original CSV" from flyGarmin / Garmin Pilot): one row per
// second with position, air data and engine data. The file is three header lines —
//   #airframe_info, key="value", ...
//   #units row
//   column names (Lcl Date, Lcl Time, UTCOfst, AtvWpt, Latitude, ..., E1 CHT1..6, E1 EGT1..6, ...)
// — then data rows. Times are local with a UTC offset column. One file covers one engine run.

const SERIES_STEP = 5; // seconds between samples kept for charts

// Bump when the parser's stats change; stored logs with an older version are re-parsed at startup.
const PARSER_VERSION = 8; // 6: cruise spans and per-metric peak times; 7: peaks only within spans; 8: steady-power misfire check

// Continental IO-550-N (SR22) limits and the cautions we flag below them.
const LIMITS = {
  chtCaution: 420, chtRedline: 460,      // °F; 420 is the usual longevity ceiling
  oilTempCaution: 225, oilTempRedline: 240, // °F
  oilPressLow: 30, oilPressMin: 10, oilPressHigh: 70, // psi; green arc 30–60
  shockCoolRate: 50,                     // °F per minute CHT drop
  egtDip: 75,                            // °F single-cylinder EGT drop in 10 s while others hold
  egtDipSustained: 50,                   // °F still down (vs. the other cylinders) 20 s later
  steadyRpm: 60, steadyMap: 0.6, steadyFf: 1.0, // max range over ±20 s to count as steady power
  misfireMinPwr: 0.4,                    // only look for misfires above 40% power
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

  // Single-cylinder EGT drop while the others hold steady: a possible misfire (plug, ignition
  // lead, injector, valve). Power changes (throttle, prop, mixture) and idle shift EGTs unevenly
  // between cylinders as a matter of course, so only drops in steady flight count:
  //  1. airborne above 40% power;
  //  2. RPM, MAP and fuel flow all steady for 20 s either side (no power or mixture change);
  //  3. the cylinder dropped > 75°F in 10 s while the median of the other five moved < 25°F;
  //  4. and it matters: still ≥ 50°F down against the others 20 s later (sustained), or it keeps
  //     happening — 3 or more separate brief drops in one flight (intermittent).
  const egts = (r) => cyl.map(c => num(r, `E1 EGT${c}`));
  const rangeOk = (rs, col, max) => {
    let lo = Infinity, hi = -Infinity;
    for (const r of rs) { const v = num(r, col); if (v == null) return false; if (v < lo) lo = v; if (v > hi) hi = v; }
    return hi - lo <= max;
  };
  // warm rows ≈ 1 s apart; idx of the row about dt seconds from row i (null across a gap).
  const near = (i, dt) => {
    const target = warm[i].ms + dt * 1000;
    let j = i;
    while (dt > 0 ? j + 1 < warm.length && warm[j].ms < target : j > 0 && warm[j].ms > target) j += dt > 0 ? 1 : -1;
    return Math.abs(warm[j].ms - target) <= 3000 ? j : null;
  };
  const steadyAt = (i) => {
    const a = near(i, -20), b = near(i, 20);
    if (a == null || b == null) return false;
    const win = warm.slice(a, b + 1);
    return rangeOk(win, 'E1 RPM', LIMITS.steadyRpm) && rangeOk(win, 'E1 MAP', LIMITS.steadyMap) && rangeOk(win, 'E1 FFlow', LIMITS.steadyFf);
  };
  // Cylinder k's EGT minus the average of the other five.
  const rel = (r, k) => { const e = egts(r); if (e.some(v => v == null)) return null; return e[k] - (e.reduce((s, v) => s + v, 0) - e[k]) / 5; };
  const dips = {};
  for (let i = 10; i < warm.length; i++) {
    const r = warm[i];
    if ((num(r, 'IAS') ?? 0) < 50 || (num(r, 'E1 %Pwr') ?? 0) < LIMITS.misfireMinPwr) continue;
    const pi = near(i, -10);
    if (pi == null) continue;
    const now = egts(r), before = egts(warm[pi]);
    if (now.some(v => v == null) || before.some(v => v == null)) continue;
    const d = now.map((v, k) => v - before[k]);
    for (let k = 0; k < 6; k++) {
      const others = d.filter((_, m) => m !== k).sort((x, y) => x - y);
      const med = (others[2] + others[3]) / 2;
      if (!(d[k] < -LIMITS.egtDip && Math.abs(med) < 25)) continue;
      const c = k + 1;
      if (dips[c] && r.ms - dips[c].lastMs <= 30000) { dips[c].lastMs = r.ms; continue; } // same drop
      if (!steadyAt(i)) continue;
      const after = near(i, 20), base = rel(warm[pi], k), later = after != null ? rel(warm[after], k) : null;
      const sustained = base != null && later != null && base - later >= LIMITS.egtDipSustained;
      const prev = dips[c] || { count: 0, sustained: 0, worst: 0, firstMs: r.ms };
      dips[c] = { count: prev.count + 1, sustained: prev.sustained + (sustained ? 1 : 0), worst: Math.min(prev.worst, d[k]),
        firstMs: prev.firstMs, firstSustainedMs: prev.firstSustainedMs ?? (sustained ? r.ms : undefined), lastMs: r.ms };
    }
  }
  for (const [c, d] of Object.entries(dips)) {
    if (!d.sustained && d.count < 3) continue; // a single brief dip in steady flight isn't worth an alert
    const what = d.sustained
      ? `EGT #${c} dropped ${Math.round(-d.worst)}°F at steady power and stayed down while the other cylinders held`
      : `EGT #${c} dipped up to ${Math.round(-d.worst)}°F ${d.count} times at steady power while the other cylinders held`;
    add('egt_dip', d.count >= 3 || -d.worst >= 150 ? 'warning' : 'caution', `${what} — possible misfire`,
      d.firstSustainedMs ?? d.firstMs, { cyl: Number(c), value: d.count });
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

// Per-second values of the cruise metrics that engineAnalysis compares between flights (same keys).
const CYLS = [1, 2, 3, 4, 5, 6];
const devOf = (vals, c) => (vals.some(v => v == null) ? null : vals[c - 1] - avg(vals));
const ROW_METRICS = {
  ...Object.fromEntries(CYLS.map(c => [`cht_dev${c}`, (r, num) => devOf(CYLS.map(k => num(r, `E1 CHT${k}`)), c)])),
  ...Object.fromEntries(CYLS.map(c => [`egt_dev${c}`, (r, num) => devOf(CYLS.map(k => num(r, `E1 EGT${k}`)), c)])),
  cht_spread: (r, num) => { const v = CYLS.map(k => num(r, `E1 CHT${k}`)); return v.some(x => x == null) ? null : Math.max(...v) - Math.min(...v); },
  oilt: (r, num) => num(r, 'E1 OilT'),
  oilp: (r, num) => num(r, 'E1 OilP'),
  ff_per_pwr: (r, num) => { const ff = num(r, 'E1 FFlow'), p = num(r, 'E1 %Pwr'); return ff != null && p > 0.4 ? (ff / p) * 0.65 : null; },
};
const SMOOTH = 30; // seconds averaged, so a single noisy sample isn't "the moment"

// Where in the flight the cruise numbers came from: the level-cruise stretches (spans, as
// [from, to] ISO times, 1 min or longer) and, per metric, when its 30-s average was highest and
// lowest (peaks[key] = { hi: [iso, value], lo: [iso, value] }). Lets a finding say when the
// outlying reading happened and the chart mark it.
function cruiseMoments(allCruise, num) {
  let groups = [];
  for (const r of allCruise) {
    const g = groups[groups.length - 1];
    if (g && r.ms - g[g.length - 1].ms <= 30000) g.push(r); else groups.push([r]);
  }
  groups = groups.filter(g => g[g.length - 1].ms - g[0].ms >= 60000);
  const spans = groups.map(g => [g[0].ms, g[g.length - 1].ms]);
  const cruise = groups.flat(); // peaks only inside the stretches that get shaded on the chart
  const peaks = {};
  for (const [key, fn] of Object.entries(ROW_METRICS)) {
    const vals = cruise.map(r => fn(r, num));
    let hi = null, lo = null, sum = 0, n = 0;
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] != null) { sum += vals[i]; n++; }
      const j = i - SMOOTH;
      if (j >= 0 && vals[j] != null) { sum -= vals[j]; n--; }
      if (n < SMOOTH / 2) continue;
      const v = sum / n, at = cruise[Math.floor(i - Math.min(i, SMOOTH) / 2)].ms; // middle of the window
      if (!hi || v > hi[1]) hi = [at, v];
      if (!lo || v < lo[1]) lo = [at, v];
    }
    if (hi) peaks[key] = { hi: [new Date(hi[0]).toISOString(), round(hi[1], 1)], lo: [new Date(lo[0]).toISOString(), round(lo[1], 1)] };
  }
  return {
    spans: spans.map(s => s.map(ms => new Date(ms).toISOString())),
    peaks,
  };
}

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
    ...cruiseMoments(cruise, num),
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
