// ── Pet Licence Factory — Shared Database Connection (Cloudflare) ────────────
// AWS RDS PostgreSQL via pg Pool
// Shared instance: lessoncomplete-db.c9e2648w8z0z.us-east-2.rds.amazonaws.com
// Database: petlicencefactory
// ---------------------------------------------------------------------------

import pg from 'pg';
const { Pool } = pg;

let pool;

export function getDb(env) {
  if (!pool) {
    const connStr = (env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '');
    pool = new Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
    });
  }
  return { query: (text, params) => pool.query(text, params) };
}
