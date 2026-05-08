// ── Pet Licence Factory — Affiliate Admin API ───────────────────────────────
// POST /api/affiliate-admin   { action, ...params }
// Auth: Bearer JWT issued by /api/admin-api login (role=admin).
//
// Actions:
//   list_creators           → list with derived stats
//   get_creator             → full detail (orders, clicks, payouts, ledger)
//   invite_creator          → create coupons, save row, email onboarding
//   approve_creator         → approve a public application, create coupons, email onboarding
//   retry_creator_setup     → re-run failed Stripe coupon creation
//   resend_onboarding       → resend onboarding email
//   approve_review_video    → approve creator video proof for $10 bonus
//   reject_review_video     → reject creator video proof with optional note
//   preview_onboarding      → returns rendered HTML for the preview-before-send
//   delete_creator          → admin-only hard delete (deactivates Stripe coupons)
//   record_payout           → write a manual payout row
//   delete_payout           → undo a payout
//   export_outstanding_csv  → returns CSV of outstanding balances
// ---------------------------------------------------------------------------

import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import { getDb } from '../_shared/db.js';
import {
  validateCodeShape,
  generateToken,
} from '../_shared/affiliate.js';
import {
  activateReservedCreator,
  createCreatorInvite,
  clampRate,
  sendOnboardingAndLog,
} from '../_shared/affiliate-onboarding.js';
import { renderCreatorOnboardingEmail } from '../_shared/email.js';
import { ensureAffiliateContentSchema } from '../_shared/affiliate-content-schema.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, ...extraHeaders },
  });
}

function verifyToken(request, env) {
  const auth  = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try { return jwt.verify(token, env.ADMIN_JWT_SECRET); }
  catch { return null; }
}

const VALID_PAYOUT_METHODS = ['venmo', 'paypal', 'zelle', 'cash', 'check', 'other'];

// Shape returned for the list view — derived columns done in SQL.
const LIST_SQL = `
  SELECT
    c.id, c.name, c.email, c.coupon_code, c.commission_rate, c.customer_discount_rate,
    c.freebie_code, c.setup_status, c.setup_error, c.notes, c.created_at,
    c.freebie_redeemed_at, c.tiktok_ad_code, c.review_video_status,
    c.review_video_submitted_at, c.review_video_bonus_cents,

    -- Click stats
    COALESCE((SELECT COUNT(*) FROM affiliate_clicks ac WHERE ac.creator_id = c.id),                                0) AS clicks_total,
    COALESCE((SELECT COUNT(*) FROM affiliate_clicks ac WHERE ac.creator_id = c.id AND ac.created_at > NOW() - INTERVAL '7 days'), 0) AS clicks_7d,

    -- Order stats (excluding freebies)
    COALESCE((SELECT COUNT(*)            FROM affiliate_orders ao WHERE ao.creator_id = c.id AND ao.is_freebie = FALSE), 0) AS orders_count,
    COALESCE((SELECT SUM(gross_cents)    FROM affiliate_orders ao WHERE ao.creator_id = c.id AND ao.is_freebie = FALSE), 0) AS gross_cents,
    COALESCE((SELECT SUM(commission_cents) FROM affiliate_orders ao WHERE ao.creator_id = c.id AND ao.is_freebie = FALSE AND ao.commission_zeroed = FALSE), 0) AS commission_earned_cents,

    -- Non-commission credits/debits (video bonuses, manual adjustments, clawbacks)
    COALESCE((SELECT SUM(amount_cents) FROM creator_balance_ledger WHERE creator_id = c.id), 0) AS bonus_cents,

    -- Payouts (excludes failed external payouts so the balance is restored
    -- when a Tremendous gift card / Stripe Connect transfer fails).
    COALESCE((SELECT SUM(amount_cents) FROM affiliate_payouts ap
              WHERE ap.creator_id = c.id
                AND ap.external_status IS DISTINCT FROM 'failed'), 0) AS commission_paid_cents,

    -- Last activity = most recent of: click, order, payout, freebie redeem, created
    GREATEST(
      c.created_at,
      COALESCE(c.freebie_redeemed_at, '1970-01-01'::timestamptz),
      COALESCE((SELECT MAX(created_at) FROM affiliate_clicks  WHERE creator_id = c.id), '1970-01-01'::timestamptz),
      COALESCE((SELECT MAX(created_at) FROM affiliate_orders  WHERE creator_id = c.id), '1970-01-01'::timestamptz),
      COALESCE((SELECT MAX(paid_at)    FROM affiliate_payouts WHERE creator_id = c.id), '1970-01-01'::timestamptz)
    ) AS last_activity_at
  FROM affiliate_creators c
  ORDER BY c.created_at DESC
`;

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  // Auth
  const payload = verifyToken(request, env);
  if (!payload || payload.role !== 'admin') {
    return json(401, { error: 'Unauthorized' });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { action } = body;
  if (!action) return json(400, { error: 'Missing action' });

  const db = getDb(env);
  await ensureAffiliateContentSchema(db);

  try {
    switch (action) {

      // ── LIST ──────────────────────────────────────────────────────────
      case 'list_creators': {
        const res = await db.query(LIST_SQL);
        return json(200, { creators: res.rows.map(rowToListItem) });
      }

      // ── DETAIL ────────────────────────────────────────────────────────
      case 'get_creator': {
        const id = parseInt(body.id);
        if (!id) return json(400, { error: 'Missing id' });

        const cRes = await db.query('SELECT * FROM affiliate_creators WHERE id = $1', [id]);
        if (cRes.rows.length === 0) return json(404, { error: 'Creator not found' });
        const c = cRes.rows[0];

        const [orders, clicks, payouts, ledger] = await Promise.all([
          db.query(
            `SELECT id, order_id_text, attribution_method, is_freebie,
                    gross_cents, discount_cents, commission_rate, commission_cents,
                    commission_zeroed, refunded_at, refund_cents,
                    stripe_session_id, stripe_payment_intent, created_at
             FROM affiliate_orders WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 200`,
            [id]
          ),
          db.query(
            `SELECT id, referrer, landing_path, created_at
             FROM affiliate_clicks WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 100`,
            [id]
          ),
          db.query(
            `SELECT id, amount_cents, method, paid_at, notes,
                    external_id, external_status, recipient_email, redemption_code, failure_reason
             FROM affiliate_payouts WHERE creator_id = $1 ORDER BY paid_at DESC`,
            [id]
          ),
          db.query(
            `SELECT id, kind, amount_cents, reference_type, reference_id, notes, created_at
             FROM creator_balance_ledger WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 200`,
            [id]
          ),
        ]);

        // Balance summary. Failed external payouts are excluded so the
        // reservation is rolled back when Tremendous / Stripe Connect fails.
        const earnedCents = orders.rows
          .filter(r => !r.is_freebie && !r.commission_zeroed)
          .reduce((s, r) => s + (r.commission_cents || 0), 0);
        const bonusCents  = ledger.rows.reduce((s, r) => s + (r.amount_cents || 0), 0);
        const paidCents   = payouts.rows
          .filter(r => r.external_status !== 'failed')
          .reduce((s, r) => s + (r.amount_cents || 0), 0);

        return json(200, {
          creator: {
            ...c,
            commission_rate:        Number(c.commission_rate),
            customer_discount_rate: Number(c.customer_discount_rate),
          },
          orders:  orders.rows,
          clicks:  clicks.rows,
          payouts: payouts.rows,
          ledger_entries: ledger.rows,
          ledger: {
            earned_cents:        earnedCents,
            bonus_cents:         bonusCents,
            total_earned_cents:  earnedCents + bonusCents,
            paid_cents:          paidCents,
            outstanding_cents:   Math.max(0, earnedCents + bonusCents - paidCents),
          },
        });
      }

      // ── INVITE ────────────────────────────────────────────────────────
      case 'invite_creator': {
        const result = await createCreatorInvite(env, db, {
          name:                 body.name,
          email:                body.email,
          couponCode:           body.couponCode,
          commissionRate:       body.commissionRate,
          customerDiscountRate: body.customerDiscountRate,
          notes:                body.notes,
          skipEmail:            !!body.skipEmail,
        });
        return json(200, result);
      }

      // ── APPROVE PUBLIC APPLICATION ───────────────────────────────────
      case 'approve_creator': {
        const id = parseInt(body.id);
        if (!id) return json(400, { error: 'Missing id' });

        const cRes = await db.query('SELECT * FROM affiliate_creators WHERE id = $1', [id]);
        if (cRes.rows.length === 0) return json(404, { error: 'Creator not found' });
        const c = cRes.rows[0];
        if (c.setup_status !== 'pending_review') {
          return json(400, { error: `Creator is not pending review (status=${c.setup_status || 'unknown'}).` });
        }

        const result = await activateReservedCreator(env, db, c, { skipEmail: false });
        return json(200, result);
      }

      // ── RETRY SETUP ───────────────────────────────────────────────────
      case 'retry_creator_setup': {
        const id = parseInt(body.id);
        if (!id) return json(400, { error: 'Missing id' });

        const cRes = await db.query('SELECT * FROM affiliate_creators WHERE id = $1', [id]);
        if (cRes.rows.length === 0) return json(404, { error: 'Creator not found' });
        const c = cRes.rows[0];
        if (c.setup_status === 'invited' || c.setup_status === 'activated') {
          return json(400, { error: `Setup already complete (status=${c.setup_status})` });
        }
        if (c.setup_status === 'pending_review') {
          return json(400, { error: 'Creator is pending review — approve them to create coupons and send onboarding.' });
        }

        const result = await activateReservedCreator(env, db, c, { skipEmail: true });
        return json(200, { success: true, ...result });
      }

      // ── RESEND ONBOARDING ─────────────────────────────────────────────
      case 'resend_onboarding': {
        const id = parseInt(body.id);
        if (!id) return json(400, { error: 'Missing id' });
        const cRes = await db.query('SELECT * FROM affiliate_creators WHERE id = $1', [id]);
        if (cRes.rows.length === 0) return json(404, { error: 'Creator not found' });
        const c = cRes.rows[0];
        if (!c.freebie_code) {
          return json(400, { error: 'Creator setup incomplete — retry setup first.' });
        }

        const result = await sendOnboardingAndLog(env, db, {
          creatorId:   c.id,
          creatorName: c.name,
          creatorEmail: c.email,
          affiliateCode: c.coupon_code,
          freebieCode:   c.freebie_code,
          customerDiscountPct: Math.round(Number(c.customer_discount_rate) * 100),
          commissionPct:       Math.round(Number(c.commission_rate)        * 100),
          dashboardToken: c.dashboard_token,
          siteOrigin: env.URL || 'https://petlicensefactory.com',
        });
        return json(200, { success: true, email: result });
      }

      // ── REVIEW VIDEO BONUS ───────────────────────────────────────────
      case 'approve_review_video': {
        const id = parseInt(body.id);
        if (!id) return json(400, { error: 'Missing id' });
        const notes = (body.notes || 'Approved for $10 TikTok review video bonus.').toString().slice(0, 500);

        const cRes = await db.query('SELECT * FROM affiliate_creators WHERE id = $1', [id]);
        if (cRes.rows.length === 0) return json(404, { error: 'Creator not found' });
        const c = cRes.rows[0];
        if (!c.review_video_r2_key) return json(400, { error: 'Creator has not uploaded a review video yet.' });

        const wasAlreadyApproved = c.review_video_status === 'approved';
        const bonusCents = Number(c.review_video_bonus_cents) || 1000;

        await db.query(
          `UPDATE affiliate_creators
           SET review_video_status = 'approved',
               review_video_reviewed_at = NOW(),
               review_video_review_notes = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [notes, id]
        );

        // Credit the bonus to the balance ledger. The partial unique index on
        // (creator_id, kind, reference_type, reference_id) WHERE kind='video_bonus'
        // makes this idempotent if the admin re-clicks approve.
        let credited = false;
        if (!wasAlreadyApproved && bonusCents > 0) {
          const ins = await db.query(
            `INSERT INTO creator_balance_ledger
               (creator_id, kind, amount_cents, reference_type, reference_id, notes)
             VALUES ($1, 'video_bonus', $2, 'review_video', $1, $3)
             ON CONFLICT (creator_id, kind, reference_type, reference_id)
             WHERE kind = 'video_bonus'
             DO NOTHING
             RETURNING id`,
            [id, bonusCents, `Video bonus on approval. ${notes}`]
          );
          credited = ins.rows.length > 0;
        }

        return json(200, {
          success: true,
          bonus_credited_cents: credited ? bonusCents : 0,
          already_approved: wasAlreadyApproved,
        });
      }

      case 'reject_review_video': {
        const id = parseInt(body.id);
        if (!id) return json(400, { error: 'Missing id' });
        const notes = (body.notes || 'Please upload a clearer TikTok review video.').toString().slice(0, 500);

        const cRes = await db.query('SELECT * FROM affiliate_creators WHERE id = $1', [id]);
        if (cRes.rows.length === 0) return json(404, { error: 'Creator not found' });
        const c = cRes.rows[0];
        if (!c.review_video_r2_key) return json(400, { error: 'Creator has not uploaded a review video yet.' });

        await db.query(
          `UPDATE affiliate_creators
           SET review_video_status = 'rejected',
               review_video_reviewed_at = NOW(),
               review_video_review_notes = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [notes, id]
        );
        return json(200, { success: true });
      }

      // ── PREVIEW ONBOARDING (renders the actual HTML, no send) ────────
      case 'preview_onboarding': {
        const name                  = (body.name || 'Creator Name').trim();
        const email                 = (body.email || 'creator@example.com').trim();
        const codeShape             = validateCodeShape(body.couponCode || 'PREVIEW');
        if (!codeShape.ok) return json(400, { error: codeShape.error });
        const commissionRate        = clampRate(body.commissionRate, 0.20);
        const customerDiscountRate  = clampRate(body.customerDiscountRate, 0.15);
        const siteOrigin            = env.URL || 'https://petlicensefactory.com';

        // For pending applicants we don't have a freebie code yet — show the
        // shape they'll receive ("CODE-WELCOME-XXXX") so the admin can
        // verify the welcome-bonus copy before approving.
        const freebieCode    = codeShape.code + '-WELCOME-XXXX';
        const dashboardToken = 'PREVIEW-' + codeShape.code;

        const rendered = renderCreatorOnboardingEmail({
          creatorName: name,
          affiliateCode: codeShape.code,
          freebieCode,
          customerDiscountPct: Math.round(customerDiscountRate * 100),
          commissionPct:       Math.round(commissionRate        * 100),
          siteOrigin,
          dashboardToken,
        });

        return json(200, {
          preview: {
            to: email,
            subject:               rendered.subject,
            html:                  rendered.html,
            text:                  rendered.text,
            affiliate_code:        codeShape.code,
            freebie_code:          freebieCode,
            customer_discount_pct: Math.round(customerDiscountRate * 100),
            commission_pct:        Math.round(commissionRate * 100),
            urls:                  rendered.urls,
          },
        });
      }

      // ── PREVIEW ONBOARDING for an existing creator row ───────────────
      // Uses their stored commission/discount rates and (when available)
      // the real freebie code + dashboard token, so the admin can review
      // exactly what an approved creator would have received — including
      // the $10 video-bonus copy.
      case 'preview_onboarding_for_creator': {
        const id = parseInt(body.id);
        if (!id) return json(400, { error: 'Missing id' });
        const cRes = await db.query('SELECT * FROM affiliate_creators WHERE id = $1', [id]);
        if (cRes.rows.length === 0) return json(404, { error: 'Creator not found' });
        const c = cRes.rows[0];

        const siteOrigin = env.URL || 'https://petlicensefactory.com';
        const freebieCode = c.freebie_code || (c.coupon_code + '-WELCOME-XXXX');
        const dashboardToken = c.dashboard_token || ('PREVIEW-' + c.coupon_code);

        const rendered = renderCreatorOnboardingEmail({
          creatorName: c.name,
          affiliateCode: c.coupon_code,
          freebieCode,
          customerDiscountPct: Math.round(Number(c.customer_discount_rate) * 100),
          commissionPct:       Math.round(Number(c.commission_rate)        * 100),
          siteOrigin,
          dashboardToken,
        });

        return json(200, {
          preview: {
            to: c.email,
            subject:               rendered.subject,
            html:                  rendered.html,
            text:                  rendered.text,
            affiliate_code:        c.coupon_code,
            freebie_code:          freebieCode,
            customer_discount_pct: Math.round(Number(c.customer_discount_rate) * 100),
            commission_pct:        Math.round(Number(c.commission_rate)        * 100),
            urls:                  rendered.urls,
            is_real_kit:           !!c.freebie_code,
          },
        });
      }

      // ── SEED FAKE PENDING CREATORS (admin convenience for previews) ──
      case 'seed_test_pending': {
        const requested = parseInt(body.count) || 3;
        const count = Math.max(1, Math.min(10, requested));
        const inserted = [];
        const samples = [
          { name: 'Luna Whiskers',  email: 'luna+seed@example.com',  audience: '10,000 - 50,000', code: 'LUNAWHISK',  pitch: 'Cat content + indie boutiques', tiktok: 'https://www.tiktok.com/@lunawhiskers' },
          { name: 'Max Woofington', email: 'max+seed@example.com',   audience: '50,000 - 250,000', code: 'MAXWOOF',    pitch: 'Bulldog comedy reels',         tiktok: 'https://www.tiktok.com/@maxwoof' },
          { name: 'Oliver Pawsley', email: 'oliver+seed@example.com', audience: '1,000 - 10,000',   code: 'OLIVERPAWS', pitch: 'Rescue rabbit storytime',      tiktok: 'https://www.tiktok.com/@oliverpawsley' },
          { name: 'Bento the Cat',  email: 'bento+seed@example.com',  audience: '250,000+',         code: 'BENTOCAT',   pitch: 'Daily cat vlog with cooking',   tiktok: 'https://www.tiktok.com/@bento.cat' },
          { name: 'Dash & Dot',     email: 'dashdot+seed@example.com', audience: '10,000 - 50,000', code: 'DASHANDDOT', pitch: 'Twin shiba inus on adventures', tiktok: 'https://www.tiktok.com/@dashanddot' },
          { name: 'Captain Otter',  email: 'capt+seed@example.com',   audience: 'Under 1,000',      code: 'CAPTOTTER',  pitch: 'Otter rescue education',        tiktok: 'https://www.tiktok.com/@captainotter' },
          { name: 'Pixel the Pup',  email: 'pixel+seed@example.com',  audience: '50,000 - 250,000', code: 'PIXELPUP',   pitch: 'Mini Aussie reaction videos',   tiktok: 'https://www.tiktok.com/@pixelthepup' },
        ];
        for (let i = 0; i < count && i < samples.length; i++) {
          const s = samples[i];
          // Skip if already present so the button is idempotent.
          const dup = await db.query('SELECT id FROM affiliate_creators WHERE LOWER(email) = LOWER($1) LIMIT 1', [s.email]);
          if (dup.rows.length > 0) continue;
          const dashboardToken = generateToken();
          const notes = [
            'Source: seeded sample data (command center)',
            `Profile URL: ${s.tiktok}`,
            `Audience size: ${s.audience}`,
            `Review video commitment accepted: yes`,
            `Video usage/ad permission accepted: yes`,
            `Signup note: ${s.pitch}`,
            `Submitted at: ${new Date().toISOString()}`,
          ].join('\n');
          const r = await db.query(
            `INSERT INTO affiliate_creators
               (name, email, coupon_code, commission_rate, customer_discount_rate,
                dashboard_token, setup_status, notes)
             VALUES ($1, $2, $3, 0.20, 0.15, $4, 'pending_review', $5)
             ON CONFLICT (email) DO NOTHING
             RETURNING id`,
            [s.name, s.email, s.code, dashboardToken, notes]
          );
          if (r.rows[0]?.id) inserted.push({ id: r.rows[0].id, name: s.name, email: s.email });
        }
        return json(200, { success: true, inserted, total_requested: count });
      }

      // ── DELETE CREATOR (deactivates Stripe coupons too) ──────────────
      case 'delete_creator': {
        const id = parseInt(body.id);
        if (!id) return json(400, { error: 'Missing id' });
        const cRes = await db.query('SELECT * FROM affiliate_creators WHERE id = $1', [id]);
        if (cRes.rows.length === 0) return json(404, { error: 'Creator not found' });
        const c = cRes.rows[0];

        // Deactivate (don't delete) Stripe promo codes so historical orders
        // still resolve. Coupons can stay alive on Stripe; deactivating the
        // promotion code is enough to stop new redemptions.
        const stripe = new Stripe(env.STRIPE_SECRET_KEY);
        for (const promoId of [c.stripe_promo_code_id, c.stripe_freebie_promo_id]) {
          if (!promoId) continue;
          try { await stripe.promotionCodes.update(promoId, { active: false }); }
          catch (err) { console.error('Stripe deactivate failed:', err); }
        }

        await db.query('DELETE FROM affiliate_creators WHERE id = $1', [id]);
        return json(200, { success: true });
      }

      // ── PAYOUTS ──────────────────────────────────────────────────────
      case 'record_payout': {
        const id      = parseInt(body.id);
        const dollars = Number(body.amount);
        const method  = String(body.method || '').toLowerCase();
        const notes   = (body.notes || '').toString().slice(0, 500) || null;
        const paidAt  = body.paidAt ? new Date(body.paidAt) : new Date();

        if (!id)                                  return json(400, { error: 'Missing id' });
        if (!Number.isFinite(dollars) || dollars <= 0) return json(400, { error: 'Amount must be > 0' });
        if (!VALID_PAYOUT_METHODS.includes(method))     return json(400, { error: `Method must be one of: ${VALID_PAYOUT_METHODS.join(', ')}` });
        if (isNaN(paidAt.getTime()))              return json(400, { error: 'Invalid paidAt' });

        const cents = Math.round(dollars * 100);
        const r = await db.query(
          `INSERT INTO affiliate_payouts (creator_id, amount_cents, method, paid_at, notes)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [id, cents, method, paidAt.toISOString(), notes]
        );
        return json(200, { success: true, payout: r.rows[0] });
      }

      case 'delete_payout': {
        const id = parseInt(body.id);
        if (!id) return json(400, { error: 'Missing id' });
        await db.query('DELETE FROM affiliate_payouts WHERE id = $1', [id]);
        return json(200, { success: true });
      }

      // ── BALANCE LEDGER ────────────────────────────────────────────────
      // Manual credit/debit on a creator's balance. Used to compensate for
      // bugs, comp out-of-band promotion bonuses, or claw back over-credited
      // amounts. Positive cents = credit, negative = debit.
      case 'adjust_balance': {
        const id      = parseInt(body.id);
        const dollars = Number(body.amount);
        const note    = (body.notes || '').toString().slice(0, 500) || null;

        if (!id)                                       return json(400, { error: 'Missing id' });
        if (!Number.isFinite(dollars) || dollars === 0) return json(400, { error: 'Amount must be a non-zero number' });
        if (!note)                                     return json(400, { error: 'Notes required (audit trail)' });

        const cents = Math.round(dollars * 100);
        const r = await db.query(
          `INSERT INTO creator_balance_ledger
             (creator_id, kind, amount_cents, reference_type, reference_id, notes)
           VALUES ($1, 'manual_adjustment', $2, 'admin_adjustment', NULL, $3)
           RETURNING *`,
          [id, cents, note]
        );
        return json(200, { success: true, entry: r.rows[0] });
      }

      case 'delete_ledger_entry': {
        const id = parseInt(body.id);
        if (!id) return json(400, { error: 'Missing id' });
        // Only allow deleting manual adjustments — video bonuses are
        // protected so a re-approval of the same video can't double-credit
        // (the partial unique index would block it but the row would also
        // need the original to exist).
        const r = await db.query(
          `DELETE FROM creator_balance_ledger
           WHERE id = $1 AND kind = 'manual_adjustment'
           RETURNING id`,
          [id]
        );
        if (r.rows.length === 0) {
          return json(400, { error: 'Only manual adjustments can be deleted.' });
        }
        return json(200, { success: true });
      }

      // ── OUTREACH TEMPLATES ────────────────────────────────────────────
      case 'list_templates': {
        const r = await db.query(
          `SELECT id, name, body, notes, created_at, updated_at
           FROM affiliate_outreach_templates
           ORDER BY updated_at DESC`
        );
        return json(200, { templates: r.rows });
      }

      case 'save_template': {
        const id   = body.id ? parseInt(body.id) : null;
        const name = (body.name || '').toString().trim();
        const text = (body.body || '').toString();
        const notes = (body.notes || '').toString().slice(0, 500) || null;

        if (!name)         return json(400, { error: 'Name is required.' });
        if (name.length > 120) return json(400, { error: 'Name must be ≤ 120 chars.' });
        if (!text)         return json(400, { error: 'Body is required.' });
        if (text.length > 8000) return json(400, { error: 'Body too long (max 8000 chars).' });

        if (id) {
          const r = await db.query(
            `UPDATE affiliate_outreach_templates
             SET name = $1, body = $2, notes = $3, updated_at = NOW()
             WHERE id = $4
             RETURNING *`,
            [name, text, notes, id]
          );
          if (r.rows.length === 0) return json(404, { error: 'Template not found' });
          return json(200, { template: r.rows[0] });
        }
        const r = await db.query(
          `INSERT INTO affiliate_outreach_templates (name, body, notes)
           VALUES ($1, $2, $3) RETURNING *`,
          [name, text, notes]
        );
        return json(200, { template: r.rows[0] });
      }

      case 'delete_template': {
        const id = parseInt(body.id);
        if (!id) return json(400, { error: 'Missing id' });
        await db.query('DELETE FROM affiliate_outreach_templates WHERE id = $1', [id]);
        return json(200, { success: true });
      }

      // ── CSV EXPORT (outstanding balances for monthly payout) ─────────
      case 'export_outstanding_csv': {
        const r = await db.query(LIST_SQL);
        const rows = r.rows.map(rowToListItem)
          .filter(r => r.outstanding_cents > 0)
          .map(r => ({
            name:               r.name,
            email:              r.email,
            coupon_code:        r.coupon_code,
            orders:             r.orders_count,
            commission_earned:  (r.commission_earned_cents / 100).toFixed(2),
            commission_paid:    (r.commission_paid_cents   / 100).toFixed(2),
            outstanding_usd:    (r.outstanding_cents       / 100).toFixed(2),
          }));

        const headers = ['name', 'email', 'coupon_code', 'orders', 'commission_earned', 'commission_paid', 'outstanding_usd'];
        const csv = [
          headers.join(','),
          ...rows.map(r => headers.map(h => csvCell(r[h])).join(',')),
        ].join('\n');

        return new Response(csv, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="affiliate-outstanding-${new Date().toISOString().slice(0,10)}.csv"`,
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      default:
        return json(400, { error: `Unknown action: ${action}` });
    }

  } catch (err) {
    if (err?.status && err?.body) return json(err.status, err.body);
    console.error('Affiliate Admin API error:', err);
    return json(500, { error: err.message || 'Server error' });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function rowToListItem(row) {
  const earned = Number(row.commission_earned_cents) || 0;
  const bonus  = Number(row.bonus_cents)             || 0;
  const paid   = Number(row.commission_paid_cents)   || 0;
  // Status derivation per the brief.
  let status = 'invited';
  if (row.setup_status === 'pending_review') status = 'pending_review';
  if (row.freebie_redeemed_at)         status = 'activated';
  if (Number(row.orders_count) >= 1)   status = 'producing';
  if (Number(row.orders_count) >= 3)   status = 'performing';
  if (row.setup_status === 'failed')   status = 'setup_failed';

  return {
    id:                       Number(row.id),
    name:                     row.name,
    email:                    row.email,
    coupon_code:              row.coupon_code,
    commission_rate:          Number(row.commission_rate),
    customer_discount_rate:   Number(row.customer_discount_rate),
    notes:                    row.notes,
    setup_status:             row.setup_status,
    setup_error:              row.setup_error,
    freebie_code:             row.freebie_code,
    freebie_redeemed_at:      row.freebie_redeemed_at,
    tiktok_ad_code:           row.tiktok_ad_code,
    review_video_status:      row.review_video_status,
    review_video_submitted_at: row.review_video_submitted_at,
    review_video_bonus_cents: Number(row.review_video_bonus_cents) || 1000,
    status,
    clicks_total:             Number(row.clicks_total),
    clicks_7d:                Number(row.clicks_7d),
    orders_count:             Number(row.orders_count),
    gross_cents:              Number(row.gross_cents),
    commission_earned_cents:  earned,
    bonus_cents:              bonus,
    total_earned_cents:       earned + bonus,
    commission_paid_cents:    paid,
    outstanding_cents:        Math.max(0, earned + bonus - paid),
    last_activity_at:         row.last_activity_at,
    created_at:               row.created_at,
  };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
