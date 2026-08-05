const { Pool } = require('pg');

// Single shared connection pool for the whole app.
// DATABASE_URL comes from .env, e.g:
// postgres://user:password@localhost:5432/bluewave_registry
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
  process.exit(1);
});

// Small, idempotent forward-only migrations that aren't (yet) reflected
// in schema.sql. Safe to run on every boot -- IF NOT EXISTS makes each
// one a no-op after the first successful run.
pool.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT')
.catch((err) => console.error('Migration (invoices.notes) failed:', err.message));

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
