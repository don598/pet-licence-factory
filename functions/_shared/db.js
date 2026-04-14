// ── Pet Licence Factory — Shared Database Connection (Cloudflare) ────────────
// AWS RDS PostgreSQL via Hyperdrive + pg Pool
// Shared instance: lessoncomplete-db.c9e2648w8z0z.us-east-2.rds.amazonaws.com
// Database: petlicencefactory
// ---------------------------------------------------------------------------

import pg from 'pg';
const { Pool } = pg;

export function getDb(env) {
  // Use Hyperdrive connection string when available (Cloudflare Pages),
  // fall back to DATABASE_URL for local development
  const connStr = env.HYPERDRIVE
    ? env.HYPERDRIVE.connectionString
    : (env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '');

  const pool = new Pool({
    connectionString: connStr,
    // Hyperdrive manages SSL and pooling; only set ssl for direct connections
    ...(env.HYPERDRIVE ? {} : { ssl: { rejectUnauthorized: false } }),
    max: 3,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });

  return { query: (text, params) => pool.query(text, params) };
}
