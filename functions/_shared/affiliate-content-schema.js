// ── Pet Licence Factory — Affiliate Content Schema ─────────────────────────
// Small, safe runtime migration for creator UGC fields. The base affiliate
// schema is still in affiliate_setup.sql; this keeps production compatible
// when new dashboard fields deploy before the SQL file is manually re-run.
// ---------------------------------------------------------------------------

let readyPromise = null;

// Cloudflare Hyperdrive uses Postgres' extended query protocol which only
// allows ONE statement per `db.query()` call. Splitting the ALTER TABLE
// and CREATE INDEX into separate queries prevents the migration from
// silently rejecting and starving the affiliate admin endpoint.
async function runMigrations(db) {
  await db.query(`
    ALTER TABLE affiliate_creators
      ADD COLUMN IF NOT EXISTS tiktok_ad_code TEXT,
      ADD COLUMN IF NOT EXISTS tiktok_ad_code_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS review_video_r2_key TEXT,
      ADD COLUMN IF NOT EXISTS review_video_filename TEXT,
      ADD COLUMN IF NOT EXISTS review_video_content_type TEXT,
      ADD COLUMN IF NOT EXISTS review_video_size_bytes BIGINT,
      ADD COLUMN IF NOT EXISTS review_video_status TEXT NOT NULL DEFAULT 'not_submitted',
      ADD COLUMN IF NOT EXISTS review_video_submitted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS review_video_reviewed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS review_video_review_notes TEXT,
      ADD COLUMN IF NOT EXISTS review_video_bonus_cents INTEGER NOT NULL DEFAULT 1000
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_aff_creators_review_video_status
      ON affiliate_creators (review_video_status)
  `);
}

export function ensureAffiliateContentSchema(db) {
  if (!readyPromise) {
    readyPromise = runMigrations(db).catch(err => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}
