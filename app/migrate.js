const fs = require('fs');
const path = require('path');
const pool = require('./db');

// Applies the numbered SQL files in ./migrations that haven't run yet, in order, each in its
// own transaction, recording them in schema_migrations. Runs at startup before the server
// listens. A database created before migrations existed (it has tables but no
// schema_migrations) is treated as already at the baseline.
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version FROM public.schema_migrations');
    const applied = new Set(rows.map(r => r.version));

    if (applied.size === 0) {
      const { rows: [{ existing }] } = await client.query(`SELECT to_regclass('public.users') IS NOT NULL AS existing`);
      if (existing) {
        const baseline = files[0].replace(/\.sql$/, '');
        await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [baseline]);
        applied.add(baseline);
        console.log(`[migrate] existing database — marked ${baseline} as applied`);
      }
    }

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    // Migrations can change session settings (pg_dump output clears search_path), so don't
    // hand this connection back to the pool.
    client.release(true);
  }
}

module.exports = { migrate };
