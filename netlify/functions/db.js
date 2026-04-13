'use strict';
// ── Pet Licence Factory — Shared Database Connection ─────────────────────────
// AWS RDS PostgreSQL via pg Pool
// Shared instance: lessoncomplete-db.c9e2648w8z0z.us-east-2.rds.amazonaws.com
// Database: petlicencefactory
// ---------------------------------------------------------------------------

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 10000,
});

module.exports = { query: (text, params) => pool.query(text, params) };
