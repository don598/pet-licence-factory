// ── Pet Licence Factory — Creator Dashboard Data ────────────────────────────
// POST /api/affiliate-dashboard   { token }
//
// Returns the data the dashboard renders: identity, coupon code, affiliate
// URL, click counts (7-day + all-time), order count, commission earned,
// pending vs paid balance, payout history, recent activity feed.
//
// Auth = the creator's long-lived `dashboard_token` (delivered in the
// onboarding email and exchanged for via /api/affiliate-magic-link).
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { findCreatorByDashboardToken } from '../_shared/affiliate.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
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
  try { body = await request.json(); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const token = String(body.token || '').trim();
  if (!token) return json(401, { error: 'Missing token' });

  const db      = getDb(env);
  const creator = await findCreatorByDashboardToken(db, token);
  if (!creator) return json(401, { error: 'Invalid token' });

  // ── Aggregate stats in parallel ────────────────────────────────────────
  const [stats, payouts, recent] = await Promise.all([
    db.query(
      `SELECT
         (SELECT COUNT(*) FROM affiliate_clicks WHERE creator_id = $1)                                        AS clicks_total,
         (SELECT COUNT(*) FROM affiliate_clicks WHERE creator_id = $1 AND created_at > NOW() - INTERVAL '7 days') AS clicks_7d,
         (SELECT COUNT(*) FROM affiliate_clicks WHERE creator_id = $1 AND created_at > NOW() - INTERVAL '14 days' AND created_at <= NOW() - INTERVAL '7 days') AS clicks_prev_7d,
         (SELECT COUNT(*)             FROM affiliate_orders WHERE creator_id = $1 AND is_freebie = FALSE)        AS orders_count,
         (SELECT COALESCE(SUM(commission_cents), 0) FROM affiliate_orders WHERE creator_id = $1 AND is_freebie = FALSE AND commission_zeroed = FALSE) AS commission_earned_cents,
         (SELECT COALESCE(SUM(amount_cents),     0) FROM affiliate_payouts WHERE creator_id = $1)             AS commission_paid_cents`,
      [creator.id]
    ),
    db.query(
      `SELECT id, amount_cents, method, paid_at, notes
       FROM affiliate_payouts WHERE creator_id = $1 ORDER BY paid_at DESC`,
      [creator.id]
    ),
    db.query(
      `(SELECT 'order'  AS kind, created_at AS at, order_id_text AS label, commission_cents AS cents, is_freebie
        FROM affiliate_orders WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 10)
       UNION ALL
       (SELECT 'click'  AS kind, created_at AS at, COALESCE(referrer, landing_path) AS label, NULL::int AS cents, FALSE AS is_freebie
        FROM affiliate_clicks WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 10)
       ORDER BY at DESC LIMIT 10`,
      [creator.id]
    ),
  ]);

  const s = stats.rows[0];
  const earnedCents = Number(s.commission_earned_cents) || 0;
  const paidCents   = Number(s.commission_paid_cents)   || 0;

  return json(200, {
    creator: {
      name:                   creator.name,
      email:                  creator.email,
      coupon_code:            creator.coupon_code,
      commission_rate:        Number(creator.commission_rate),
      customer_discount_rate: Number(creator.customer_discount_rate),
    },
    affiliate_url: `${env.URL || 'https://petlicensefactory.com'}/?ref=${encodeURIComponent(creator.coupon_code)}`,
    stats: {
      clicks_total:           Number(s.clicks_total),
      clicks_7d:              Number(s.clicks_7d),
      clicks_prev_7d:         Number(s.clicks_prev_7d),
      orders_count:           Number(s.orders_count),
      commission_earned_cents: earnedCents,
      commission_paid_cents:   paidCents,
      commission_pending_cents: Math.max(0, earnedCents - paidCents),
    },
    payouts: payouts.rows,
    activity: recent.rows.map(r => ({
      kind:       r.kind,
      at:         r.at,
      label:      r.label,
      cents:      r.cents !== null ? Number(r.cents) : null,
      is_freebie: r.is_freebie,
    })),
  });
}
