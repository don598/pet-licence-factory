// ── Pet Licence Factory — Affiliate Creator Onboarding ─────────────────────
// Shared creator setup flow used by the admin invite action and public
// self-service signup. Keeps DB reservation, approval-gated Stripe coupon
// creation, and onboarding email logging in one place.
// ---------------------------------------------------------------------------

import {
  generateToken,
  validateCodeShape,
  ensureCodeUnique,
  createCreatorCoupons,
} from './affiliate.js';
import { sendCreatorOnboardingEmail } from './email.js';

const DEFAULT_SITE_ORIGIN = 'https://petlicensefactory.com';

export class AffiliateOnboardingError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'AffiliateOnboardingError';
    this.status = status;
    this.body = { error: message, ...extra };
  }
}

export function siteOrigin(env) {
  return env.URL || DEFAULT_SITE_ORIGIN;
}

export function clampRate(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  // Accept either 0-1 (0.2) or 0-100 (20). Anything >= 1.5 is a percent.
  const rate = n >= 1.5 ? n / 100 : n;
  return Math.max(0, Math.min(1, rate));
}

function fail(status, message, extra) {
  throw new AffiliateOnboardingError(message, status, extra);
}

function cleanEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function cleanText(value, maxLen) {
  return String(value || '').trim().slice(0, maxLen);
}

export async function createCreatorInvite(env, db, opts = {}) {
  const name                 = cleanText(opts.name, 100);
  const email                = cleanEmail(opts.email);
  const codeShape            = validateCodeShape(opts.couponCode);
  const commissionRate       = clampRate(opts.commissionRate, 0.20);
  const customerDiscountRate = clampRate(opts.customerDiscountRate, 0.15);
  const notes                = cleanText(opts.notes, 1000) || null;
  const skipEmail            = !!opts.skipEmail;

  if (!name) fail(400, 'Name is required.');
  if (!email) fail(400, 'Email is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Invalid email.');
  if (!codeShape.ok) fail(400, codeShape.error);

  const dupEmail = await db.query(
    'SELECT id FROM affiliate_creators WHERE LOWER(email) = $1 LIMIT 1',
    [email]
  );
  if (dupEmail.rows.length > 0) {
    fail(400, `${email} is already a creator.`);
  }

  const codeCheck = await ensureCodeUnique(env, db, codeShape.code);
  if (!codeCheck.ok) fail(400, codeCheck.error);

  // Reserve first so a partial Stripe failure is visible in the command
  // center and can be repaired with retry_creator_setup.
  const dashboardToken = generateToken();
  const insertRes = await db.query(
    `INSERT INTO affiliate_creators
       (name, email, coupon_code, commission_rate, customer_discount_rate,
        dashboard_token, setup_status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     RETURNING id`,
    [name, email, codeShape.code, commissionRate, customerDiscountRate, dashboardToken, notes]
  );
  const creatorId = insertRes.rows[0].id;

  return activateReservedCreator(env, db, {
    id: creatorId,
    name,
    email,
    coupon_code: codeShape.code,
    commission_rate: commissionRate,
    customer_discount_rate: customerDiscountRate,
    dashboard_token: dashboardToken,
    setup_status: 'pending',
  }, { skipEmail });
}

export async function createCreatorApplication(env, db, opts = {}) {
  const name                 = cleanText(opts.name, 100);
  const email                = cleanEmail(opts.email);
  const codeShape            = validateCodeShape(opts.couponCode);
  const commissionRate       = clampRate(opts.commissionRate, 0.20);
  const customerDiscountRate = clampRate(opts.customerDiscountRate, 0.15);
  const notes                = cleanText(opts.notes, 1000) || null;

  if (!name) fail(400, 'Name is required.');
  if (!email) fail(400, 'Email is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Invalid email.');
  if (!codeShape.ok) fail(400, codeShape.error);

  const dupEmail = await db.query(
    'SELECT id FROM affiliate_creators WHERE LOWER(email) = $1 LIMIT 1',
    [email]
  );
  if (dupEmail.rows.length > 0) {
    fail(400, `${email} is already a creator.`);
  }

  const codeCheck = await ensureCodeUnique(env, db, codeShape.code);
  if (!codeCheck.ok) fail(400, codeCheck.error);

  const dashboardToken = generateToken();
  const insertRes = await db.query(
    `INSERT INTO affiliate_creators
       (name, email, coupon_code, commission_rate, customer_discount_rate,
        dashboard_token, setup_status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending_review', $7)
     RETURNING id`,
    [name, email, codeShape.code, commissionRate, customerDiscountRate, dashboardToken, notes]
  );
  const creatorId = insertRes.rows[0].id;

  return {
    success: true,
    pending_review: true,
    creator_id: creatorId,
    creator: {
      name,
      email,
      coupon_code: codeShape.code,
      commission_rate: commissionRate,
      customer_discount_rate: customerDiscountRate,
      setup_status: 'pending_review',
    },
  };
}

export async function activateReservedCreator(env, db, creator, opts = {}) {
  const creatorId            = Number(creator?.id);
  const name                 = cleanText(creator?.name, 100);
  const email                = cleanEmail(creator?.email);
  const codeShape            = validateCodeShape(creator?.coupon_code);
  const commissionRate       = clampRate(creator?.commission_rate, 0.20);
  const customerDiscountRate = clampRate(creator?.customer_discount_rate, 0.15);
  const dashboardToken       = cleanText(creator?.dashboard_token, 200);
  const skipEmail            = !!opts.skipEmail;
  const origin               = siteOrigin(env);

  if (!creatorId) fail(400, 'Creator id is required.');
  if (!name) fail(400, 'Name is required.');
  if (!email) fail(400, 'Email is required.');
  if (!codeShape.ok) fail(400, codeShape.error);
  if (!dashboardToken) fail(400, 'Dashboard token is required.');
  if (creator.freebie_code || creator.setup_status === 'invited' || creator.setup_status === 'activated') {
    fail(400, `Creator setup already complete (status=${creator.setup_status || 'ready'}).`);
  }

  let coupons;
  try {
    coupons = await createCreatorCoupons(env, {
      code: codeShape.code,
      customerDiscountRate,
      name,
    });
  } catch (err) {
    console.error('Stripe coupon creation failed:', err);
    await db.query(
      `UPDATE affiliate_creators
       SET setup_status = 'failed', setup_error = $1, updated_at = NOW()
       WHERE id = $2`,
      [String(err.message || err).slice(0, 500), creatorId]
    );
    fail(500, `Coupon creation failed: ${err.message || err}`, {
      creator_id: creatorId,
      recoverable: true,
    });
  }

  await db.query(
    `UPDATE affiliate_creators SET
       stripe_coupon_id         = $1,
       stripe_promo_code_id     = $2,
       stripe_freebie_coupon_id = $3,
       stripe_freebie_promo_id  = $4,
       freebie_code             = $5,
       setup_status             = 'invited',
       setup_error              = NULL,
       updated_at               = NOW()
     WHERE id = $6`,
    [
      coupons.affiliate.couponId, coupons.affiliate.promoId,
      coupons.freebie.couponId,   coupons.freebie.promoId,
      coupons.freebie.code,       creatorId,
    ]
  );

  let emailResult = null;
  if (!skipEmail) {
    emailResult = await sendOnboardingAndLog(env, db, {
      creatorId,
      creatorName: name,
      creatorEmail: email,
      affiliateCode: coupons.affiliate.code,
      freebieCode: coupons.freebie.code,
      customerDiscountPct: Math.round(customerDiscountRate * 100),
      commissionPct: Math.round(commissionRate * 100),
      dashboardToken,
      siteOrigin: origin,
    });
  }

  return {
    success: true,
    creator_id: creatorId,
    creator: {
      name,
      email,
      coupon_code: codeShape.code,
      commission_rate: commissionRate,
      customer_discount_rate: customerDiscountRate,
      setup_status: 'invited',
    },
    codes: {
      affiliate: coupons.affiliate.code,
      freebie: coupons.freebie.code,
    },
    urls: {
      affiliate: `${origin}/?ref=${encodeURIComponent(coupons.affiliate.code)}`,
      freebie: `${origin}/game.html?promo=${encodeURIComponent(coupons.freebie.code)}`,
      dashboard: `${origin}/dashboard.html?token=${encodeURIComponent(dashboardToken)}`,
    },
    email: emailResult,
  };
}

export async function sendOnboardingAndLog(env, db, opts) {
  const result = await sendCreatorOnboardingEmail(env, opts);
  try {
    await db.query(
      `INSERT INTO affiliate_email_log
         (creator_id, template, to_email, subject, sendgrid_message_id, success, error)
       VALUES ($1, 'onboarding', $2, $3, $4, $5, $6)`,
      [
        opts.creatorId,
        opts.creatorEmail,
        `🎉 You're in — your Pet Licence Factory creator kit`,
        result?.messageId || null,
        !!result?.success,
        result?.error ? String(result.error).slice(0, 500) : null,
      ]
    );
  } catch (err) {
    console.error('email log insert failed:', err);
  }
  return result;
}
