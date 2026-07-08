const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      google_sub TEXT PRIMARY KEY,
      email TEXT,
      trial_start_ts BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { pool, initSchema };
