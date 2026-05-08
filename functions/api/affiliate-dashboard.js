// ── Pet Licence Factory — Creator Dashboard Data ────────────────────────────
// POST /api/affiliate-dashboard   { token, action? }
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
import { ensureAffiliateContentSchema } from '../_shared/affiliate-content-schema.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

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
  let isForm = false;
  try {
    const contentType = request.headers.get('Content-Type') || '';
    if (contentType.includes('multipart/form-data')) {
      body = await request.formData();
      isForm = true;
    } else {
      body = await request.json();
    }
  }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const token = String(isForm ? body.get('token') : body.token || '').trim();
  if (!token) return json(401, { error: 'Missing token' });

  const db      = getDb(env);
  await ensureAffiliateContentSchema(db);
  const creator = await findCreatorByDashboardToken(db, token);
  if (!creator) return json(401, { error: 'Invalid token' });

  const action = String(isForm ? body.get('action') : body.action || 'get_dashboard').trim() || 'get_dashboard';

  if (action === 'save_ad_code') {
    const tiktokAdCode = cleanText(isForm ? body.get('tiktokAdCode') : body.tiktokAdCode, 500);
    await db.query(
      `UPDATE affiliate_creators
       SET tiktok_ad_code = $1, tiktok_ad_code_updated_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [tiktokAdCode || null, creator.id]
    );
    const fresh = await findCreatorByDashboardToken(db, token);
    return json(200, await dashboardPayload(env, db, fresh, token));
  }

  if (action === 'upload_video') {
    if (!env.CREATOR_UPLOADS) {
      return json(503, { error: 'Video uploads are not configured yet. Ask Pet Licence Factory to attach the CREATOR_UPLOADS R2 bucket.' });
    }
    const file = body.get('video');
    if (!file || typeof file.stream !== 'function') {
      return json(400, { error: 'Choose a video file to upload.' });
    }
    if (!String(file.type || '').startsWith('video/')) {
      return json(400, { error: 'Please upload a video file.' });
    }
    if (Number(file.size) > MAX_VIDEO_BYTES) {
      return json(400, { error: 'Video is too large. Please keep uploads under 100 MB.' });
    }

    const fileName = safeFileName(file.name || 'creator-video.mp4');
    const key = `creator-videos/${creator.id}/${Date.now()}-${crypto.randomUUID()}-${fileName}`;
    await env.CREATOR_UPLOADS.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || 'video/mp4' },
      customMetadata: {
        creatorId: String(creator.id),
        creatorEmail: String(creator.email || ''),
        uploadedAt: new Date().toISOString(),
      },
    });

    await db.query(
      `UPDATE affiliate_creators
       SET review_video_r2_key = $1,
           review_video_filename = $2,
           review_video_content_type = $3,
           review_video_size_bytes = $4,
           review_video_status = 'pending',
           review_video_submitted_at = NOW(),
           review_video_reviewed_at = NULL,
           review_video_review_notes = NULL,
           updated_at = NOW()
       WHERE id = $5`,
      [key, file.name || fileName, file.type || 'video/mp4', Number(file.size) || 0, creator.id]
    );

    const fresh = await findCreatorByDashboardToken(db, token);
    return json(200, await dashboardPayload(env, db, fresh, token));
  }

  if (action !== 'get_dashboard') {
    return json(400, { error: `Unknown action: ${action}` });
  }

  return json(200, await dashboardPayload(env, db, creator, token));
}

async function dashboardPayload(env, db, creator, token) {
  // ── Aggregate stats in parallel ────────────────────────────────────────
  const [stats, payouts, recent] = await Promise.all([
    db.query(
      `SELECT
         (SELECT COUNT(*) FROM affiliate_clicks WHERE creator_id = $1)                                        AS clicks_total,
         (SELECT COUNT(*) FROM affiliate_clicks WHERE creator_id = $1 AND created_at > NOW() - INTERVAL '7 days') AS clicks_7d,
         (SELECT COUNT(*) FROM affiliate_clicks WHERE creator_id = $1 AND created_at > NOW() - INTERVAL '14 days' AND created_at <= NOW() - INTERVAL '7 days') AS clicks_prev_7d,
         (SELECT COUNT(*)             FROM affiliate_orders WHERE creator_id = $1 AND is_freebie = FALSE)        AS orders_count,
         (SELECT COALESCE(SUM(commission_cents), 0) FROM affiliate_orders WHERE creator_id = $1 AND is_freebie = FALSE AND commission_zeroed = FALSE) AS commission_earned_cents,
         (SELECT COALESCE(SUM(amount_cents),     0) FROM creator_balance_ledger WHERE creator_id = $1)        AS bonus_cents,
         (SELECT COALESCE(SUM(amount_cents),     0) FROM affiliate_payouts
            WHERE creator_id = $1 AND external_status IS DISTINCT FROM 'failed')                              AS commission_paid_cents`,
      [creator.id]
    ),
    db.query(
      `SELECT id, amount_cents, method, paid_at, notes,
              external_id, external_status, recipient_email, redemption_code, failure_reason
       FROM affiliate_payouts WHERE creator_id = $1 ORDER BY paid_at DESC`,
      [creator.id]
    ),
    db.query(
      `(SELECT 'order'  AS kind, created_at AS at, order_id_text AS label, commission_cents AS cents, is_freebie
        FROM affiliate_orders WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 10)
       UNION ALL
       (SELECT 'click'  AS kind, created_at AS at, COALESCE(referrer, landing_path) AS label, NULL::int AS cents, FALSE AS is_freebie
        FROM affiliate_clicks WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 10)
       UNION ALL
       (SELECT 'bonus'  AS kind, created_at AS at, kind          AS label, amount_cents     AS cents, FALSE AS is_freebie
        FROM creator_balance_ledger WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 10)
       ORDER BY at DESC LIMIT 10`,
      [creator.id]
    ),
  ]);

  const s = stats.rows[0];
  const earnedCents = Number(s.commission_earned_cents) || 0;
  const bonusCents  = Number(s.bonus_cents)             || 0;
  const paidCents   = Number(s.commission_paid_cents)   || 0;

  return {
    creator: {
      name:                   creator.name,
      email:                  creator.email,
      coupon_code:            creator.coupon_code,
      commission_rate:        Number(creator.commission_rate),
      customer_discount_rate: Number(creator.customer_discount_rate),
      tiktok_ad_code:          creator.tiktok_ad_code || '',
      tiktok_ad_code_updated_at: creator.tiktok_ad_code_updated_at || null,
      review_video_status:     creator.review_video_status || 'not_submitted',
      review_video_submitted_at: creator.review_video_submitted_at || null,
      review_video_reviewed_at: creator.review_video_reviewed_at || null,
      review_video_review_notes: creator.review_video_review_notes || null,
      review_video_filename:   creator.review_video_filename || null,
      review_video_size_bytes: Number(creator.review_video_size_bytes) || 0,
      review_video_bonus_cents: Number(creator.review_video_bonus_cents) || 1000,
      review_video_url:        creator.review_video_r2_key ? `/api/affiliate-video?token=${encodeURIComponent(token)}` : null,
      stripe_connect_payouts_enabled: !!creator.stripe_connect_payouts_enabled,
      stripe_connect_onboarded_at:    creator.stripe_connect_onboarded_at || null,
    },
    affiliate_url: `${env.URL || 'https://petlicensefactory.com'}/?ref=${encodeURIComponent(creator.coupon_code)}`,
    stats: {
      clicks_total:           Number(s.clicks_total),
      clicks_7d:              Number(s.clicks_7d),
      clicks_prev_7d:         Number(s.clicks_prev_7d),
      orders_count:           Number(s.orders_count),
      commission_earned_cents: earnedCents,
      bonus_cents:             bonusCents,
      total_earned_cents:      earnedCents + bonusCents,
      commission_paid_cents:   paidCents,
      commission_pending_cents: Math.max(0, earnedCents + bonusCents - paidCents),
    },
    payouts: payouts.rows,
    activity: recent.rows.map(r => ({
      kind:       r.kind,
      at:         r.at,
      label:      r.label,
      cents:      r.cents !== null ? Number(r.cents) : null,
      is_freebie: r.is_freebie,
    })),
  };
}

function cleanText(value, maxLen) {
  return String(value || '').trim().slice(0, maxLen);
}

function safeFileName(value) {
  const cleaned = String(value || 'creator-video.mp4')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120);
  return cleaned || 'creator-video.mp4';
}
