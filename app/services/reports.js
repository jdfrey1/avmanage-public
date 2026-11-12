const pool = require('../db');


// Pure, parameter-driven versions of the currency/hours/cost logic already used by
// currency.js GET /, flights.js GET /annual-summary, and maintenance.js GET /summary +
// GET /cost-analysis — factored out here so the monthly report (and the routes) share one
// implementation instead of drifting. Each function takes explicit ids, not req.session/
// req.query, so it can run outside a request (from a cron job).

// Currency dates are calendar dates in the app's time zone (the server runs in UTC, which made
// "today" tomorrow every evening). Days left are counted the way ForeFlight does: the expiration
// day itself counts, so landings yesterday with a 90-day limit show 90 days left. Once lapsed, the
// value is negative: -N means it expired N days ago.
const CURRENCY_TZ = process.env.APP_TIMEZONE || 'America/New_York';
const localToday = () => new Date().toLocaleDateString('en-CA', { timeZone: CURRENCY_TZ });
const dayNum = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const ymdOf = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const addDays = (ymd, n) => ymdOf(dayNum(ymd) + n);
// Last day of the Nth calendar month after the month of `ymd`.
const endOfMonthAfter = (ymd, months) => { const [y, m] = ymd.split('-').map(Number); return ymdOf(Date.UTC(y, m - 1 + months + 1, 0) / 86400000); };
const daysLeft = (expiry, today) => { const d = dayNum(expiry) - dayNum(today); return d >= 0 ? d + 1 : d; };

async function getCurrencyStatus(userId) {
  const today = localToday();

  // IFR (14 CFR 61.57(c)): within the 6 calendar months preceding the month of the flight,
  // 6 instrument approaches AND holding procedures. The window runs from the 1st of the month six
  // months back, and each requirement lapses at the end of the 6th month after the flight that
  // satisfied it; IFR currency ends when the first of the two lapses. An IPC (61.57(d)) also
  // makes the pilot current through the end of the 6th month after it.
  const { rows: ifrRows } = await pool.query(`
    SELECT event_date::text,
           SUM(approaches)::int AS approach_count,
           BOOL_OR(holds_accomplished) AS hold,
           BOOL_OR(event_type = 'ipc') AS ipc
    FROM currency_events
    WHERE user_id = $1
      AND source IN ('foreflight_import', 'manual', 'auto_flight')
      AND (approaches > 0 OR holds_accomplished OR event_type = 'ipc')
      AND event_date >= date_trunc('month', $2::date) - INTERVAL '6 months'
    GROUP BY event_date
    ORDER BY event_date DESC
  `, [userId, today]);

  const totalApproaches = ifrRows.reduce((s, r) => s + r.approach_count, 0);
  const lastHold = ifrRows.find(r => r.hold)?.event_date ?? null;
  const lastIpc = ifrRows.find(r => r.ipc)?.event_date ?? null;
  let sixthApproach = null;
  for (let accum = 0, i = 0; i < ifrRows.length; i++) {
    accum += ifrRows[i].approach_count;
    if (accum >= 6) { sixthApproach = ifrRows[i].event_date; break; }
  }

  let ifrExpiry = null;
  if (sixthApproach && lastHold) {
    const ea = endOfMonthAfter(sixthApproach, 6), eh = endOfMonthAfter(lastHold, 6);
    ifrExpiry = ea < eh ? ea : eh;
  }
  if (lastIpc) {
    const ei = endOfMonthAfter(lastIpc, 6);
    if (!ifrExpiry || ei > ifrExpiry) ifrExpiry = ei;
  }
  const ifrCurrent = !!ifrExpiry && ifrExpiry >= today;
  const ifrExpiresInDays = ifrExpiry ? daysLeft(ifrExpiry, today) : -1;

  // 61.57(a)/(b): 3 takeoffs and landings in the preceding 90 days. Any landing counts toward
  // day currency, including night landings; night currency needs night full-stop landings.
  // Currency runs through the 90th day after the date of the third-most-recent landing.
  const landingCurrency = async (expr) => {
    const { rows } = await pool.query(`
      SELECT event_date::text, SUM(${expr})::int AS count
      FROM currency_events
      WHERE user_id = $1
        AND source IN ('foreflight_import', 'manual', 'auto_flight')
        AND ${expr} > 0
        AND event_date >= $2::date - 90
        AND (aircraft_class = 'airplane_single_engine_land' OR aircraft_class IS NULL)
      GROUP BY event_date
      ORDER BY event_date DESC
    `, [userId, today]);
    let accum = 0;
    for (const r of rows) {
      accum += r.count;
      if (accum >= 3) {
        const expiresDate = addDays(r.event_date, 90);
        return { current: true, expiresDate, expiresInDays: daysLeft(expiresDate, today) };
      }
    }
    return { current: false, expiresDate: null, expiresInDays: -1 };
  };
  const dayLanding = await landingCurrency('COALESCE(landings_day, 0) + COALESCE(landings_night, 0)');
  const nightLanding = await landingCurrency('COALESCE(landings_night, 0)');

  const { rows: [u] } = await pool.query(
    `SELECT name, last_foreflight_import_at, last_foreflight_import_file,
            medical_expires_date::text AS medical_expires_date, bfr_date::text AS bfr_date
     FROM users WHERE id = $1`,
    [userId]
  );

  const medicalDate = u.medical_expires_date ?? null;
  const medicalDaysUntilExpiry = medicalDate ? daysLeft(medicalDate, today) : null;
  const medicalCurrent = !!medicalDate && medicalDate >= today;

  // Flight review (61.56): good through the end of the 24th calendar month after it.
  const bfrDate = u.bfr_date ?? null;
  const bfrExpiresDate = bfrDate ? endOfMonthAfter(bfrDate, 24) : null;
  const bfrDaysUntilExpiry = bfrExpiresDate ? daysLeft(bfrExpiresDate, today) : null;
  const bfrCurrent = !!bfrExpiresDate && bfrExpiresDate >= today;

  return {
    ifr:          { current: ifrCurrent, expiresDate: ifrExpiry, expiresInDays: ifrExpiresInDays, approachesInWindow: totalApproaches, holdInWindow: !!lastHold, lastHoldDate: lastHold, ipcDate: lastIpc },
    dayLanding,
    nightLanding,
    medical:      { current: medicalCurrent, expiresDate: medicalDate, daysUntilExpiry: medicalDaysUntilExpiry },
    bfr:          { current: bfrCurrent, accomplishedDate: bfrDate, expiresDate: bfrExpiresDate, daysUntilExpiry: bfrDaysUntilExpiry },
    lastImportAt:   u.last_foreflight_import_at,
    lastImportFile: u.last_foreflight_import_file || null,
    pilot:          u.name,
  };
}

// The allotment window is anchored to the member's lease start date (per the lease: the
// allotment is per "lease year", unused hours expire at its end, no carry-over). Returns the
// [start, end) dates of the window containing `today` as YYYY-MM-DD strings, or null before
// the lease has started. With no lease_start_date it falls back to a rolling window.
function allotmentWindow(period, leaseStart, today) {
  const ymd = (d) => d.toISOString().slice(0, 10);
  const parse = (str) => new Date(str + 'T00:00:00Z');
  const t = parse(today);
  if (!leaseStart) {
    const s = new Date(t);
    if (period === 'monthly') s.setUTCMonth(s.getUTCMonth() - 1); else s.setUTCFullYear(s.getUTCFullYear() - 1);
    return { start: ymd(s), end: ymd(new Date(t.getTime() + 86400000)) };
  }
  const ls = parse(leaseStart);
  if (t < ls) return null;
  const step = (n) => {
    const d = new Date(ls);
    if (period === 'monthly') d.setUTCMonth(d.getUTCMonth() + n); else d.setUTCFullYear(d.getUTCFullYear() + n);
    return d;
  };
  let n = period === 'monthly'
    ? (t.getUTCFullYear() - ls.getUTCFullYear()) * 12 + (t.getUTCMonth() - ls.getUTCMonth())
    : t.getUTCFullYear() - ls.getUTCFullYear();
  while (step(n) > t) n--;
  return { start: ymd(step(n)), end: ymd(step(n + 1)) };
}

async function getHoursSummary(userId, partnershipId) {
  const { rows: [member] } = await pool.query(
    `SELECT role, annual_hour_allotment, hour_allotment_period, overage_rate_per_hr,
            lease_start_date::text AS lease_start_date, CURRENT_DATE::text AS today
     FROM partnership_members WHERE user_id = $1 AND partnership_id = $2`,
    [userId, partnershipId]
  );

  const period    = member?.hour_allotment_period ?? 'annual';
  const allotment = parseInt(member?.annual_hour_allotment ?? 75);
  const rate      = member?.overage_rate_per_hr != null ? parseFloat(member.overage_rate_per_hr) : null;
  const isOwner   = member?.role === 'owner';
  // The owner has no allotment: show calendar-year hours instead.
  const win       = isOwner
    ? { start: member.today.slice(0, 4) + '-01-01', end: (parseInt(member.today.slice(0, 4)) + 1) + '-01-01' }
    : member ? allotmentWindow(period, member.lease_start_date, member.today) : null;

  let hoursFlown = 0;
  if (win) {
    const { rows: [row] } = await pool.query(`
      SELECT COALESCE(SUM(f.flight_time), 0)::float AS hours_flown
      FROM flights f
      WHERE f.pilot_id = $1
        AND f.partnership_id = $2
        AND NOT f.exclude_from_allotment
        AND f.flight_date >= $3 AND f.flight_date < $4
    `, [userId, partnershipId, win.start, win.end]);
    hoursFlown = parseFloat(row?.hours_flown ?? 0);
  }

  // Lease bills excess in 0.1-hr units.
  const overage = isOwner ? 0 : Math.round(Math.max(0, hoursFlown - allotment) * 10) / 10;
  return {
    hours_flown:      hoursFlown,
    annual_allotment: isOwner ? null : allotment,
    no_allotment:     isOwner,
    overage,
    overage_rate:     rate,
    overage_cost:     !isOwner && rate != null ? Math.round(overage * rate * 100) / 100 : null,
    period,
    window_start:     win?.start ?? null,
    window_end:       win?.end ?? null,
    not_started:      !win,
    lease_start:      member?.lease_start_date ?? null,
  };
}

// Flights logged by a pilot within the current calendar month, for the monthly report's
// per-pilot flight list.
async function getMonthlyFlights(userId, partnershipId, period) {
  const { rows } = await pool.query(`
    SELECT TO_CHAR(flight_date, 'YYYY-MM-DD') AS flight_date, route, flight_time, exclude_from_allotment, notes, pilot_name
    FROM flights
    WHERE pilot_id = $1
      AND partnership_id = $2
      AND flight_date >= $3 AND flight_date < $4
    ORDER BY flight_date ASC
  `, [userId, partnershipId, period.month_start, period.month_end]);
  return rows;
}

// Per-member Flight-hour usage for the member manager: calendar year-to-date and current
// calendar month, split into hours that count toward the allotment and hours flagged
// "exclude from allotment", plus the current allotment-window figure (same rolling window the
// dashboard uses, via getHoursSummary).
async function getMemberUsage(partnershipId) {
  const { rows } = await pool.query(`
    SELECT pm.id, pm.user_id, u.name, u.email, pm.role, u.is_admin,
           pm.annual_hour_allotment, pm.hour_allotment_period,
           pm.lease_monthly_rate::float AS lease_monthly_rate, pm.overage_rate_per_hr::float AS overage_rate_per_hr,
           pm.lease_start_date::text AS lease_start_date,
           COALESCE(SUM(f.flight_time) FILTER (WHERE NOT f.exclude_from_allotment AND f.flight_date >= DATE_TRUNC('year', CURRENT_DATE)), 0)::float AS ytd_hours,
           COALESCE(SUM(f.flight_time) FILTER (WHERE f.exclude_from_allotment AND f.flight_date >= DATE_TRUNC('year', CURRENT_DATE)), 0)::float AS ytd_excluded,
           COALESCE(SUM(f.flight_time) FILTER (WHERE NOT f.exclude_from_allotment AND f.flight_date >= DATE_TRUNC('month', CURRENT_DATE)), 0)::float AS month_hours,
           COALESCE(SUM(f.flight_time) FILTER (WHERE f.exclude_from_allotment AND f.flight_date >= DATE_TRUNC('month', CURRENT_DATE)), 0)::float AS month_excluded
    FROM partnership_members pm
    JOIN users u ON u.id = pm.user_id
    LEFT JOIN flights f ON f.pilot_id = pm.user_id AND f.partnership_id = pm.partnership_id
    WHERE pm.partnership_id = $1
    GROUP BY pm.id, u.id
    ORDER BY pm.role DESC, u.name
  `, [partnershipId]);
  return Promise.all(rows.map(async (m) => {
    const window = await getHoursSummary(m.user_id, partnershipId);
    return {
      ...m, window_hours: window.hours_flown, window_overage: window.overage,
      window_overage_cost: window.overage_cost, window_start: window.window_start,
      window_end: window.window_end, not_started: window.not_started,
    };
  }));
}

async function getMaintenanceCostSummary(partnershipId, year = new Date().getFullYear()) {
  const { rows } = await pool.query(`
    SELECT category, SUM(cost_amount)::float AS total
    FROM maintenance_log
    WHERE partnership_id = $1
      AND cost_amount IS NOT NULL
      AND EXTRACT(YEAR FROM entry_date) = $2
    GROUP BY category
    ORDER BY total DESC
  `, [partnershipId, year]);
  return rows;
}

// The monthly report covers the last complete month.
async function getReportPeriod() {
  const { rows: [period] } = await pool.query(`
    SELECT TO_CHAR(m, 'YYYY-MM-DD') AS month_start,
           TO_CHAR(m + INTERVAL '1 month', 'YYYY-MM-DD') AS month_end,
           TO_CHAR(DATE_TRUNC('year', m), 'YYYY-MM-DD') AS year_start,
           TO_CHAR(m + INTERVAL '1 month' - INTERVAL '1 day', 'FMMon FMDD') AS last_day_label,
           TO_CHAR(m, 'FMMonth YYYY') AS month_label,
           EXTRACT(YEAR FROM m)::int AS year
    FROM (SELECT DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') AS m) x
  `);
  return period;
}

// What the aircraft cost, from the ledger: the report month per category, and the year's total
// through that month. Lease and excess-hour charges are between members, not aircraft costs,
// so only these categories count. Credits (refunds) reduce a category.
const COST_CATEGORIES = {
  annual: 'Annual',
  maintenance: 'Maintenance',
  insurance: 'Insurance',
  hangar: 'Hangar',
  subscriptions: 'Subscriptions',
  capital: 'Capital',
  one_time_fuel: 'Fuel',
  tks: 'TKS',
  oil: 'Oil',
};

async function getCostSummary(partnershipId, period) {
  const { rows } = await pool.query(`
    SELECT entry_type,
           COALESCE(SUM(CASE WHEN effective_date >= $3 THEN signed END), 0)::float AS month_total,
           SUM(signed)::float AS ytd_total
    FROM (
      SELECT entry_type, effective_date,
             CASE WHEN direction = 'debit' THEN amount ELSE -amount END AS signed
      FROM financial_ledger
      WHERE partnership_id = $1 AND entry_type = ANY($2)
        AND effective_date >= $4 AND effective_date < $5
    ) e
    GROUP BY entry_type
    ORDER BY month_total DESC
  `, [partnershipId, Object.keys(COST_CATEGORIES), period.month_start, period.year_start, period.month_end]);
  const { rows: entries } = await pool.query(`
    SELECT TO_CHAR(effective_date, 'FMMon FMDD') AS date, entry_type, description,
           (CASE WHEN direction = 'debit' THEN amount ELSE -amount END)::float AS amount
    FROM financial_ledger
    WHERE partnership_id = $1 AND entry_type = ANY($2)
      AND effective_date >= $3 AND effective_date < $4
    ORDER BY effective_date, created_at
  `, [partnershipId, Object.keys(COST_CATEGORIES), period.month_start, period.month_end]);
  return {
    entries: entries.map(e => ({ ...e, category: COST_CATEGORIES[e.entry_type] })),
    rows: rows.filter(r => r.month_total !== 0).map(r => ({ category: COST_CATEGORIES[r.entry_type], total: r.month_total })),
    month_total: rows.reduce((t, r) => t + r.month_total, 0),
    ytd_total: rows.reduce((t, r) => t + r.ytd_total, 0),
  };
}

// Cost analysis for any date range (Ledger → Cost Analysis): aircraft costs from the ledger by
// category (same categories as the monthly report), split into fixed costs and per-hour consumables
// (fuel, TKS, oil), against the hours flown. No per-pilot allocation: fixed costs are shared
// regardless of hours flown.
const VARIABLE_COST_TYPES = ['one_time_fuel', 'tks', 'oil'];

async function getCostAnalysis(partnershipId, startDate, endDate) {
  const [{ rows: costRows }, { rows: flightRows }] = await Promise.all([
    pool.query(`
      SELECT entry_type, SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END)::float AS total
      FROM financial_ledger
      WHERE partnership_id = $1 AND entry_type = ANY($2) AND effective_date >= $3 AND effective_date <= $4
      GROUP BY entry_type
      HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0
      ORDER BY total DESC
    `, [partnershipId, Object.keys(COST_CATEGORIES), startDate, endDate]),
    pool.query(`
      SELECT COALESCE(SUM(flight_time), 0)::float AS hours
      FROM flights WHERE partnership_id = $1 AND flight_date >= $2 AND flight_date <= $3
    `, [partnershipId, startDate, endDate]),
  ]);
  const { rows: [first] } = await pool.query(
    `SELECT TO_CHAR(MIN(flight_date), 'YYYY-MM-DD') AS d FROM flights WHERE partnership_id = $1`, [partnershipId]);
  const totalCost = costRows.reduce((s, r) => s + r.total, 0);
  const variableCost = costRows.filter(r => VARIABLE_COST_TYPES.includes(r.entry_type)).reduce((s, r) => s + r.total, 0);
  const totalHours = flightRows.reduce((s, r) => s + r.hours, 0);
  return {
    start_date: startDate, end_date: endDate,
    first_flight_date: first?.d ?? null, // flights logged in the app start here; hours before it are missing
    total_hours: totalHours,
    total_cost: totalCost,
    fixed_cost: totalCost - variableCost,
    variable_cost: variableCost,
    cost_per_hour: totalHours > 0 ? totalCost / totalHours : 0,
    by_category: costRows.map(r => ({
      category: COST_CATEGORIES[r.entry_type], total: r.total, variable: VARIABLE_COST_TYPES.includes(r.entry_type),
    })),
  };
}

// Calendar-date-due recurring maintenance items, soonest first. There's no hours-based due
// tracking (e.g. 100-hr inspection interval) in the schema today.
async function getUpcomingMaintenance(partnershipId) {
  const { rows } = await pool.query(`
    SELECT id, category, title, description, cost_amount,
           TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date
    FROM maintenance_recurring
    WHERE partnership_id = $1 AND active = true
    ORDER BY next_due_date ASC
  `, [partnershipId]);
  return rows;
}

// Hour-based maintenance. "Hours" = cumulative Flight timer (flights.hobbs_end — the hobbs_*
// columns hold the Flight meter). Current hours = highest Flight reading logged so far.
async function getCurrentFlightHours(partnershipId) {
  // Highest of the logged flights and the recorded meter baseline.
  const { rows: [r] } = await pool.query(
    `SELECT GREATEST(
        (SELECT MAX(hobbs_end) FROM flights WHERE partnership_id = $1),
        (SELECT baseline_flight FROM partnerships WHERE id = $1))::float AS hrs`, [partnershipId]);
  return r?.hrs ?? null;
}

// The logbook entries recording when each tracked item was last done, keyed by item id.
async function trackerEntryLinks(column, ids) {
  if (!ids.length) return {};
  const { rows } = await pool.query(`
    SELECT l.${column} AS item_id, e.id, TO_CHAR(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.category, e.page_number, e.summary
    FROM tracker_logbook_links l JOIN logbook_entries e ON e.id = l.entry_id
    WHERE l.${column} = ANY($1)
    ORDER BY e.entry_date, e.category`, [ids]);
  const out = {};
  for (const { item_id, ...entry } of rows) (out[item_id] ||= []).push(entry);
  return out;
}

async function getHourIntervals(partnershipId) {
  const current = await getCurrentFlightHours(partnershipId);
  const { rows } = await pool.query(`
    SELECT id, title, description, interval_hours::float, last_done_hours::float,
           TO_CHAR(last_done_date, 'YYYY-MM-DD') AS last_done_date, warn_hours::float
    FROM maintenance_intervals WHERE partnership_id = $1 AND active = true
  `, [partnershipId]);
  const items = rows.map(r => {
    const next_due_hours = r.last_done_hours + r.interval_hours;
    const hours_remaining = current == null ? null : +(next_due_hours - current).toFixed(1);
    const status = hours_remaining == null ? 'unknown'
      : hours_remaining < 0 ? 'overdue' : hours_remaining <= r.warn_hours ? 'due_soon' : 'ok';
    return { ...r, next_due_hours: +next_due_hours.toFixed(1), hours_remaining, status };
  }).sort((a, b) => (a.hours_remaining ?? Infinity) - (b.hours_remaining ?? Infinity));
  const links = await trackerEntryLinks('interval_id', items.map(i => i.id));
  return { current_hours: current, items: items.map(i => ({ ...i, logbook_entries: links[i.id] ?? [] })) };
}

// Date-based inspections/expirations (annual, ELT, avionics checks, CAPS repack, registration…).
// status: overdue | due_soon (within warn_days) | ok | no_date
async function getInspections(partnershipId) {
  const { rows } = await pool.query(`
    SELECT id, title, notes, interval_months, warn_days,
           TO_CHAR(last_done_date, 'YYYY-MM-DD') AS last_done_date,
           TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date,
           (due_date - CURRENT_DATE) AS days_until
    FROM inspection_items
    WHERE partnership_id = $1 AND active
    ORDER BY due_date ASC NULLS LAST, title`, [partnershipId]);
  const links = await trackerEntryLinks('inspection_item_id', rows.map(r => r.id));
  // The Navigation database is tracked from Maintenance → Databases (it's what IFR navigation needs);
  // its expiration shows here read-only so it is flagged with everything else.
  const { rows: nav } = await pool.query(`
    SELECT 'database:' || d.id AS id, 'database' AS source,
           'Navigation database' || COALESCE(' (cycle ' || d.cycle || ')', '') AS title,
           'Required current for IFR GPS navigation. Update it and record the new cycle on the Databases tab.' AS notes,
           NULL::int AS interval_months, d.warn_days,
           (SELECT TO_CHAR(MAX(u.updated_on), 'YYYY-MM-DD') FROM avionics_database_updates u WHERE u.database_id = d.id) AS last_done_date,
           TO_CHAR(d.expires_date, 'YYYY-MM-DD') AS due_date,
           (d.expires_date - CURRENT_DATE) AS days_until
      FROM avionics_databases d
     WHERE d.partnership_id = $1 AND lower(d.name) = 'navigation'`, [partnershipId]);
  return [...rows, ...nav].map(r => ({
    ...r,
    logbook_entries: links[r.id] ?? [],
    status: r.due_date == null ? 'no_date' : r.days_until < 0 ? 'overdue' : r.days_until <= r.warn_days ? 'due_soon' : 'ok',
  })).sort((a, b) => (a.due_date ?? '9999') < (b.due_date ?? '9999') ? -1 : (a.due_date ?? '9999') > (b.due_date ?? '9999') ? 1 : a.title.localeCompare(b.title));
}

// What the Dashboard / scheduler need to know about the aircraft right now: a major open
// squawk grounds it, overdue inspections are flagged, and insurance coverage end date is
// returned so the scheduler can warn about reservations past it.
async function getAircraftStatus(partnershipId) {
  const [{ rows: major }, inspections, { rows: [p] }] = await Promise.all([
    pool.query(`SELECT id, description FROM squawks WHERE partnership_id = $1 AND status <> 'resolved' AND severity = 'major' ORDER BY reported_at`, [partnershipId]),
    getInspections(partnershipId),
    pool.query(`SELECT TO_CHAR(insurance_expires_date, 'YYYY-MM-DD') AS insurance_expires_date FROM partnerships WHERE id = $1`, [partnershipId]),
  ]);
  return {
    grounded: major.length > 0,
    major_squawks: major,
    overdue: inspections.filter(i => i.status === 'overdue'),
    due_soon: inspections.filter(i => i.status === 'due_soon'),
    insurance_expires_date: p?.insurance_expires_date ?? null,
  };
}

async function getOpenSquawks(partnershipId) {
  const { rows } = await pool.query(`
    SELECT s.id, s.description, s.severity, s.status, s.tach_at_report, s.reported_at, u.name AS reported_by_name
    FROM squawks s
    JOIN users u ON u.id = s.reported_by
    WHERE s.partnership_id = $1 AND s.status <> 'resolved'
    ORDER BY CASE s.severity WHEN 'major' THEN 0 WHEN 'minor' THEN 1 ELSE 2 END, s.reported_at DESC
  `, [partnershipId]);
  return rows;
}

async function getLedgerBalance(partnershipId, userId, before = null) {
  const { rows: [row] } = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0)::float AS balance
    FROM financial_ledger
    WHERE partnership_id = $1 AND lessee_id = $2
      AND ($3::date IS NULL OR effective_date < $3::date)
  `, [partnershipId, userId, before]);
  return row.balance;
}

function fmtMoney(n) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function currencyRow(label, status) {
  const days = status.expiresInDays ?? status.daysUntilExpiry;
  const state = status.current ? `Current (${days} days left)` : 'NOT CURRENT';
  return `<tr><td style="padding:4px 12px 4px 0;">${label}</td><td style="padding:4px 0;">${state}</td></tr>`;
}

function flightsList(flights, monthLabel) {
  if (flights.length === 0) {
    return `<p style="font-size:14px;margin:8px 0 0;color:#666;">No flights logged in ${monthLabel}.</p>`;
  }
  const rows = flights.map(f => `
    <tr>
      <td style="padding:4px 12px 4px 0;">${f.flight_date}</td>
      <td style="padding:4px 12px 4px 0;">${f.route || ''}${f.pilot_name ? ` (flown by ${f.pilot_name})` : ''}</td>
      <td style="padding:4px 0;">${f.flight_time ? `${parseFloat(f.flight_time).toFixed(1)} hrs` : ''}${f.exclude_from_allotment ? ' (excluded from allotment)' : ''}</td>
    </tr>`).join('');
  return `<table style="border-collapse:collapse;font-size:14px;margin-top:8px;">${rows}</table>`;
}

async function buildMonthlyReportHtml(partnershipId) {
  const { rows: [partnership] } = await pool.query('SELECT aircraft_tail FROM partnerships WHERE id = $1', [partnershipId]);
  const tail = partnership?.aircraft_tail || 'Aircraft';

  const { rows: members } = await pool.query(
    `SELECT u.id, u.name, pm.role FROM users u
     JOIN partnership_members pm ON pm.user_id = u.id
     WHERE pm.partnership_id = $1
     ORDER BY u.name`,
    [partnershipId]
  );

  const period = await getReportPeriod();
  const [costs, upcoming, openSquawks, hourIntervals, inspections] = await Promise.all([
    getCostSummary(partnershipId, period),
    getUpcomingMaintenance(partnershipId),
    getOpenSquawks(partnershipId),
    getHourIntervals(partnershipId),
    getInspections(partnershipId),
  ]);

  const pilotSections = await Promise.all(members.map(async (m) => {
    const isOwner = m.role === 'owner';
    const [currency, hours, balance, flights] = await Promise.all([
      getCurrencyStatus(m.id),
      getHoursSummary(m.id, partnershipId),
      getLedgerBalance(partnershipId, m.id, period.month_end),
      getMonthlyFlights(m.id, partnershipId, period),
    ]);
    const hoursLine = isOwner
      ? `Hours flown (${hours.period}): <strong>${hours.hours_flown.toFixed(1)}</strong>`
      : hours.not_started
        ? `Lease starts ${hours.lease_start} — ${hours.annual_allotment} hrs allotted per ${hours.period === 'monthly' ? 'month' : 'lease year'}`
        : `Hours flown this ${hours.period === 'monthly' ? 'month' : 'lease year'} (since ${hours.window_start}): <strong>${hours.hours_flown.toFixed(1)}</strong> of ${hours.annual_allotment} allotted` +
          (hours.overage > 0
            ? ` — <strong>${hours.overage.toFixed(1)} hrs over</strong>${hours.overage_cost != null ? ` ($${hours.overage_cost.toFixed(2)} at $${hours.overage_rate.toFixed(2)}/hr)` : ''}`
            : '');
    return `
      <h3 style="margin:24px 0 8px;">${m.name}</h3>
      <table style="border-collapse:collapse;font-size:14px;">
        ${currencyRow('IFR (6 approaches + hold / 6mo)', currency.ifr)}
        ${currencyRow('Day landings (3 / 90 days)', currency.dayLanding)}
        ${currencyRow('Night landings (3 / 90 days)', currency.nightLanding)}
        ${currencyRow('Medical', currency.medical)}
        ${currencyRow('BFR', currency.bfr)}
      </table>
      <p style="font-size:14px;margin:12px 0 0;">${hoursLine}</p>
      ${isOwner
        ? (balance !== 0 ? `<p style="font-size:14px;margin:4px 0 0;">Total expenses through ${period.last_day_label}: <strong>${fmtMoney(-balance)}</strong></p>` : '')
        : `<p style="font-size:14px;margin:4px 0 0;">Ledger balance on ${period.last_day_label}: <strong>${fmtMoney(balance)}</strong> ${balance < 0 ? '(owed to partnership)' : ''}</p>`}
      <p style="font-size:13px;margin:16px 0 0;color:#666;">Flights in ${period.month_label}</p>
      ${flightsList(flights, period.month_label)}`;
  }));

  const costCell = 'padding:4px 0 4px 16px;text-align:right;';
  const costRows = costs.rows.length
    ? costs.rows.map(r => `<tr><td style="padding:4px 12px 4px 0;">${r.category}</td><td style="${costCell}">${fmtMoney(r.total)}</td></tr>`).join('')
      + `<tr style="font-weight:bold;border-top:1px solid #ccc;"><td style="padding:4px 12px 4px 0;">Total</td><td style="${costCell}">${fmtMoney(costs.month_total)}</td></tr>`
    : `<tr><td style="padding:4px 0;" colspan="2">No costs recorded in ${period.month_label}.</td></tr>`;

  const costDetails = costs.entries.length
    ? `<p style="font-size:13px;margin:16px 0 4px;color:#666;">Details</p>
      <table style="border-collapse:collapse;font-size:14px;">${costs.entries.map(e => `<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;">${e.date}</td><td style="padding:4px 12px 4px 0;vertical-align:top;">${e.description}</td><td style="padding:4px 12px 4px 0;vertical-align:top;color:#666;">${e.category}</td><td style="padding:4px 0;text-align:right;vertical-align:top;">${e.amount < 0 ? `−${fmtMoney(-e.amount)}` : fmtMoney(e.amount)}</td></tr>`).join('')}</table>`
    : '';

  const upcomingRows = upcoming.length
    ? upcoming.map(u => `<tr><td style="padding:4px 12px 4px 0;">${u.title}</td><td style="padding:4px 12px 4px 0;">${u.next_due_date}</td><td style="padding:4px 0;">${fmtMoney(parseFloat(u.cost_amount))}</td></tr>`).join('')
    : '<tr><td style="padding:4px 0;" colspan="3">No upcoming recurring maintenance scheduled.</td></tr>';

  const intervalRows = hourIntervals.items.length
    ? hourIntervals.items.map(i => {
        const left = i.hours_remaining == null ? '' : i.hours_remaining < 0
          ? `<strong style="color:#b00020;">${Math.abs(i.hours_remaining).toFixed(1)} hrs overdue</strong>`
          : `${i.hours_remaining.toFixed(1)} hrs left${i.status === 'due_soon' ? ' (due soon)' : ''}`;
        return `<tr><td style="padding:4px 12px 4px 0;">${i.title}</td><td style="padding:4px 12px 4px 0;">due at ${i.next_due_hours.toFixed(1)}</td><td style="padding:4px 0;">${left}</td></tr>`;
      }).join('')
    : '<tr><td style="padding:4px 0;" colspan="3">No hour-based items set up.</td></tr>';

  const inspectionRows = inspections.length
    ? inspections.map(i => {
        const when = i.due_date == null
          ? '<em style="color:#b36b00;">date needed</em>'
          : i.status === 'overdue'
            ? `<strong style="color:#b00020;">${Math.abs(i.days_until)} days overdue (${i.due_date})</strong>`
            : `${i.due_date} (${i.days_until} days)${i.status === 'due_soon' ? ' <strong style="color:#b36b00;">due soon</strong>' : ''}`;
        return `<tr><td style="padding:4px 12px 4px 0;">${i.title}</td><td style="padding:4px 0;">${when}</td></tr>`;
      }).join('')
    : '<tr><td style="padding:4px 0;" colspan="2">No inspections set up.</td></tr>';

  const squawkRows = openSquawks.length
    ? openSquawks.map(s => `<tr><td style="padding:4px 12px 4px 0;text-transform:capitalize;">${s.severity}</td><td style="padding:4px 0;">${s.description}${s.status === 'in_progress' ? ' <em style="color:#666;">(planned)</em>' : ''}</td></tr>`).join('')
    : '<tr><td style="padding:4px 0;" colspan="2">No open squawks.</td></tr>';

  return `
    <div style="font-family:sans-serif;color:#1a1a1a;max-width:640px;">
      <h2 style="margin:0 0 4px;">${tail} — Monthly Report</h2>
      <p style="color:#666;margin:0 0 16px;">${period.month_label}</p>

      ${pilotSections.join('')}

      <h3 style="margin:28px 0 8px;">Costs — ${period.month_label}</h3>
      <table style="border-collapse:collapse;font-size:14px;">${costRows}</table>
      <p style="font-size:14px;margin:8px 0 0;">${period.year} year to date: <strong>${fmtMoney(costs.ytd_total)}</strong></p>
      ${costDetails}

      <h3 style="margin:28px 0 8px;">Upcoming maintenance</h3>
      <table style="border-collapse:collapse;font-size:14px;">${upcomingRows}</table>

      <h3 style="margin:28px 0 8px;">Hour-based maintenance${hourIntervals.current_hours != null ? ` (Flight timer ${hourIntervals.current_hours.toFixed(1)})` : ''}</h3>
      <table style="border-collapse:collapse;font-size:14px;">${intervalRows}</table>

      <h3 style="margin:28px 0 8px;">Inspections &amp; expirations</h3>
      <table style="border-collapse:collapse;font-size:14px;">${inspectionRows}</table>

      <h3 style="margin:28px 0 8px;">Open squawks</h3>
      <table style="border-collapse:collapse;font-size:14px;">${squawkRows}</table>
    </div>`;
}

module.exports = {
  getCurrencyStatus,
  getHoursSummary,
  getMemberUsage,
  getMaintenanceCostSummary,
  getCostAnalysis,
  getReportPeriod,
  getCostSummary,
  getUpcomingMaintenance,
  getCurrentFlightHours,
  getHourIntervals,
  getInspections,
  getAircraftStatus,
  getOpenSquawks,
  getLedgerBalance,
  buildMonthlyReportHtml,
};
