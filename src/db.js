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
const migrations = [
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT`,

    // Order intake tracking: when the request actually came in (may
    // predate when staff got around to entering it), and who sent it
    // if it arrived by email.
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_email TEXT`,

    // Turnaround / workload management.
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS due_date DATE`,

    // Staff-only notes -- distinct from invoices.notes, which is
    // client-facing and printed on the PDF. This one never leaves the
    // building.
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS internal_notes TEXT`,

    // Payment tracking on invoices.
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_received_at TIMESTAMPTZ`,

    // Per-order file attachments (reference docs, completed search
    // results, anything staff wants on hand when the order comes up
    // again). Stored directly in Postgres as bytea so it survives
    // Railway redeploys without needing separate object storage.
    `CREATE TABLE IF NOT EXISTS order_files (
        id SERIAL PRIMARY KEY,
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                file_name TEXT NOT NULL,
                    mime_type TEXT,
                        file_size INTEGER,
                            file_data BYTEA NOT NULL,
                                uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
                                  )`,
    `CREATE INDEX IF NOT EXISTS idx_order_files_order ON order_files(order_id)`,
  ];

(async () => {
    for (const sql of migrations) {
          try {
                  await pool.query(sql);
          } catch (err) {
                  console.error('Migration failed:', sql.slice(0, 80).replace(/\s+/g, ' ') + '...', '-', err.message);
          }
    }
})();

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool,
};
