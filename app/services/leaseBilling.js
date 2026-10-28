const cron = require('node-cron');
const pool = require('../db');
const reports = require('./reports');

// Automatic ledger entries driven by the lease terms:
//  - Excess flight hours: once a lessee's counted Flight hours pass their allotment for the
//    current lease year, ONE debit entry per lease year is kept in sync with
//    (excess hrs x excess rate). It is created when they first go over, updated as flights are
//    added/edited/removed, and removed if they drop back under. Nothing is charged before then.
//  - Monthly rent: due recurring 'monthly_lease' charges are posted on their due date.

async function syncExcessHours(partnershipId) {
  const { rows: lessees } = await pool.query(
    `SELECT user_id FROM partnership_members WHERE partnership_id = $1 AND role = 'lessee'`, [partnershipId]);
  for (const { user_id } of lessees) {
    const h = await reports.getHoursSummary(user_id, partnershipId);
    if (h.not_started || h.overage_rate == null) continue;
    const key = `excess:${h.window_start}`;
    if (h.overage_cost > 0) {
      const desc = `Excess flight hours: ${h.overage.toFixed(1)} hrs over ${h.annual_allotment} @ $${h.overage_rate.toFixed(2)}/hr ` +
                   `(${h.period === 'monthly' ? 'month' : 'lease year'} ${h.window_start} to ${h.window_end})`;
      const { rowCount } = await pool.query(
        `UPDATE financial_ledger SET amount = $4, description = $5
         WHERE partnership_id = $1 AND lessee_id = $2 AND auto_key = $3`,
        [partnershipId, user_id, key, h.overage_cost, desc]);
      if (!rowCount) {
        await pool.query(
          `INSERT INTO financial_ledger
             (partnership_id, created_by, lessee_id, entry_type, direction, amount, effective_date, description, auto_key)
           VALUES ($1,$2,$2,'overage_hours','debit',$3,CURRENT_DATE,$4,$5)`,
          [partnershipId, user_id, h.overage_cost, desc, key]);
      }
    } else {
      await pool.query(
        `DELETE FROM financial_ledger WHERE partnership_id = $1 AND lessee_id = $2 AND auto_key = $3`,
        [partnershipId, user_id, key]);
    }
  }
}

async function postDueRent() {
  const { rows: due } = await pool.query(
    `SELECT id FROM recurring_charges
     WHERE active AND entry_type = 'monthly_lease' AND next_due_date <= CURRENT_DATE`);
  for (const { id } of due) {
    // Catch up one month at a time (e.g. if the server was down on the 1st).
    for (;;) {
      const client = await pool.connect();
      let more = false;
      try {
        await client.query('BEGIN');
        const { rows: [c] } = await client.query(
          `SELECT * FROM recurring_charges WHERE id = $1 AND active AND next_due_date <= CURRENT_DATE FOR UPDATE`, [id]);
        if (c) {
          await client.query(
            `INSERT INTO financial_ledger
               (partnership_id, created_by, lessee_id, entry_type, direction, amount, effective_date, description)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [c.partnership_id, c.created_by, c.lessee_id, c.entry_type, c.direction, c.amount, c.next_due_date, c.description_template]);
          await client.query(
            `UPDATE recurring_charges SET next_due_date = next_due_date + INTERVAL '1 month' WHERE id = $1`, [id]);
          more = true;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      if (!more) break;
    }
  }
}

async function runDaily() {
  try {
    await postDueRent();
    const { rows } = await pool.query('SELECT id FROM partnerships');
    for (const p of rows) await syncExcessHours(p.id);
  } catch (err) {
    console.error('[lease-billing] daily run failed:', err.message);
  }
}

function initCron() {
  runDaily(); // catch up after a restart
  cron.schedule('10 0 * * *', runDaily);
}

// Fire-and-forget hook for routes that change flights.
function syncExcessHoursSoon(partnershipId) {
  syncExcessHours(partnershipId).catch(err => console.error('[lease-billing] excess sync failed:', err.message));
}

module.exports = { initCron, syncExcessHours, syncExcessHoursSoon, postDueRent };
