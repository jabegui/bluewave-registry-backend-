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

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
