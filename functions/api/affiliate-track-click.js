// ── Pet Licence Factory — Affiliate Click Tracker ───────────────────────────
// POST /api/affiliate-track-click   { code, landingPath, referrer }
//
// 1. Validates the creator exists.
// 2. Computes a per-day visitor hash from IP + UA so we can dedup repeat
//    clicks within a 24-hour window.
// 3. Inserts the row (ignoring duplicates) and sets the first-party
//    referral cookie so the visitor is attributed even after they leave
//    and come back, or jump off-site to Stripe.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import {
  findCreatorByCode,
  normalizeCode,
  visitorHash,
  setRefCookie,
} from '../_shared/affiliate.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, ...extraHeaders },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const code = normalizeCode(body.code);
  if (!code) return json(400, { error: 'Missing code' });

  const db = getDb(env);
  const creator = await findCreatorByCode(db, code);

  // We always set the cookie if the creator exists, even if the click insert
  // races/dedupes. If the code is bogus, do nothing (prevents creating dummy
  // cookies for typos).
  if (!creator) {
    return json(200, { tracked: false });
  }

  // ── Visitor hash (IP + UA + daily salt) ──────────────────────────────────
  const ip = request.headers.get('CF-Connecting-IP')
          || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
          || '';
  const ua = request.headers.get('User-Agent') || '';
  const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  const salt  = env.AFFILIATE_CLICK_SALT || env.ADMIN_JWT_SECRET || 'plf-salt';
  const vhash = await visitorHash(ip, ua, `${salt}|${today}`);

  // ── Dedup insert ─────────────────────────────────────────────────────────
  // The unique index on (creator_id, visitor_hash, bucket_day) does the
  // dedup; ON CONFLICT swallows the duplicate so the response stays 200.
  try {
    await db.query(
      `INSERT INTO affiliate_clicks
         (creator_id, visitor_hash, bucket_day, referrer, user_agent, landing_path)
       VALUES ($1, $2, CURRENT_DATE, $3, $4, $5)
       ON CONFLICT (creator_id, visitor_hash, bucket_day) DO NOTHING`,
      [
        creator.id,
        vhash,
        (body.referrer    || '').toString().slice(0, 500),
        ua.slice(0, 500),
        (body.landingPath || '').toString().slice(0, 500),
      ]
    );
  } catch (err) {
    // Non-fatal — we still want to set the cookie so attribution works.
    console.error('affiliate click insert failed:', err);
  }

  return json(200, { tracked: true, code: creator.coupon_code }, {
    'Set-Cookie': setRefCookie(creator.coupon_code),
  });
}
