'use strict';
// ── Pet Licence Factory — Shared Database Connection ─────────────────────────
// AWS RDS PostgreSQL via pg Pool
// Shared instance: lessoncomplete-db.c9e2648w8z0z.us-east-2.rds.amazonaws.com
// Database: petlicencefactory
// ---------------------------------------------------------------------------

const { Pool } = require('pg');

// Strip sslmode from connection string — we configure SSL via the ssl object instead
const connStr = (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '');

const pool = new Pool({
  connectionString: connStr,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 10000,
});

module.exports = { query: (text, params) => pool.query(text, params) };
