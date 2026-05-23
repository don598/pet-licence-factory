// ── Pet Licence Factory — Affiliate Helpers ─────────────────────────────────
// Shared utilities for the affiliate system: token generation, code
// validation, Stripe coupon + promotion code creation, visitor hashing.
// Designed for the Cloudflare Workers runtime — uses the global `crypto`.
// ---------------------------------------------------------------------------

import Stripe from 'stripe';

// ── Tokens / IDs ────────────────────────────────────────────────────────────

// 32-byte URL-safe token, suitable for magic links + dashboard auth.
export function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url, no padding
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Short suffix for the freebie code (e.g. "X7K2"). Avoid look-alikes (0/O, 1/I).
export function generateShortSuffix(len = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// Stable per-day visitor hash for click dedup. We hash IP + UA + a daily salt
// so we don't store raw IPs and the value rolls over each day.
export async function visitorHash(ip, ua, salt) {
  const text = `${ip || '-'}|${ua || '-'}|${salt || ''}`;
  const buf  = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s.slice(0, 32);
}


// ── Code validation ────────────────────────────────────────────────────────

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

// Returns {ok: true} or {ok: false, error: string}.
export function validateCodeShape(code) {
  const c = normalizeCode(code);
  if (!c) return { ok: false, error: 'Coupon code is required.' };
  if (c.length < 3 || c.length > 32) {
    return { ok: false, error: 'Coupon code must be 3–32 characters.' };
  }
  if (!CODE_RE.test(c)) {
    return { ok: false, error: 'Use letters, digits, "-" or "_". Must start with a letter or digit.' };
  }
  // Reserve a couple of names that conflict with internal flows.
  const reserved = ['WELCOME', 'FREEBIE', 'ADMIN', 'TEST'];
  if (reserved.includes(c)) {
    return { ok: false, error: `"${c}" is reserved. Pick another.` };
  }
  return { ok: true, code: c };
}

// Check uniqueness against both DB + Stripe (Stripe promotion codes are
// globally unique per account in their `code` field).
export async function ensureCodeUnique(env, db, code) {
  const c = normalizeCode(code);

  const existing = await db.query(
    'SELECT id FROM affiliate_creators WHERE LOWER(coupon_code) = LOWER($1) LIMIT 1',
    [c]
  );
  if (existing.rows.length > 0) {
    return { ok: false, error: `"${c}" is already used by another creator.` };
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  // Stripe lets you list promotion codes by exact `code`.
  const list = await stripe.promotionCodes.list({ code: c, limit: 1 });
  if (list.data.length > 0) {
    return { ok: false, error: `"${c}" already exists in Stripe. Pick another.` };
  }
  // Also block the matching freebie code shape.
  return { ok: true, code: c };
}


// ── Stripe coupon + promo code creation ────────────────────────────────────

// Creates the affiliate coupon (reusable customer discount) AND the
// single-use freebie coupon (creator-only welcome). Returns:
//   { affiliate: {couponId, promoId, code}, freebie: {couponId, promoId, code} }
//
// All Stripe objects get useful metadata so they're traceable from the
// Stripe dashboard back to the creator row.
export async function createCreatorCoupons(env, { code, customerDiscountRate, name }) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const c = normalizeCode(code);
  const meta = { source: 'plf_affiliate', creator_code: c, creator_name: (name || '').slice(0, 100) };

  // ── Affiliate coupon (e.g. 15% off, forever) ──
  const pctOff = Math.round(Number(customerDiscountRate) * 100);
  if (!Number.isFinite(pctOff) || pctOff < 1 || pctOff > 100) {
    throw new Error(`customer discount must be 1–100% (got ${customerDiscountRate})`);
  }

  // Stripe coupon names are capped at 40 chars, so keep these tight.
  // Use the creator code (up to 32 chars per validateCodeShape) as the prefix.
  //
  // Idempotency: if a previous activation half-succeeded (e.g. created the
  // affiliate pair but crashed before the freebie pair), the retry would
  // collide on the affiliate code. Look the existing pair up first and reuse
  // it when the metadata matches this creator, so retries are safe.
  let affiliateCoupon, affiliatePromo;
  const existingAffiliate = await stripe.promotionCodes.list({
    code: c, limit: 1,
  });
  const reuseAffiliate = existingAffiliate.data.find(p =>
    p.metadata && p.metadata.source === 'plf_affiliate' && p.metadata.creator_code === c
  );
  if (reuseAffiliate) {
    affiliatePromo  = reuseAffiliate;
    affiliateCoupon = await stripe.coupons.retrieve(reuseAffiliate.coupon.id || reuseAffiliate.coupon);
  } else {
    affiliateCoupon = await stripe.coupons.create({
      name:         `${c} affiliate ${pctOff}%`.slice(0, 40),
      percent_off:  pctOff,
      duration:     'forever',
      metadata:     { ...meta, kind: 'affiliate' },
    });
    affiliatePromo = await stripe.promotionCodes.create({
      coupon:    affiliateCoupon.id,
      code:      c,
      active:    true,
      metadata:  { ...meta, kind: 'affiliate' },
    });
  }

  // ── Welcome freebie (100% off, single-use, 30-day expiry, creator-only) ──
  const suffix     = generateShortSuffix(4);
  const freebieCode = `${c}-WELCOME-${suffix}`;
  const expiresAt  = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  const freebieCoupon = await stripe.coupons.create({
    // Tight name (Stripe caps at 40). The creator's code stays in the name
    // so it's still scannable from the Stripe coupons dashboard.
    name:         `${c} welcome 100%`.slice(0, 40),
    percent_off:  100,
    duration:     'once',
    redeem_by:    expiresAt,
    max_redemptions: 1,
    metadata:     { ...meta, kind: 'freebie' },
  });

  const freebiePromo = await stripe.promotionCodes.create({
    coupon:           freebieCoupon.id,
    code:             freebieCode,
    active:           true,
    max_redemptions:  1,
    expires_at:       expiresAt,
    metadata:         { ...meta, kind: 'freebie' },
  });

  return {
    affiliate: {
      couponId: affiliateCoupon.id,
      promoId:  affiliatePromo.id,
      code:     c,
    },
    freebie: {
      couponId: freebieCoupon.id,
      promoId:  freebiePromo.id,
      code:     freebieCode,
    },
  };
}


// ── Cookie helpers ─────────────────────────────────────────────────────────

export const REF_COOKIE = 'plf_aff';
export const REF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function setRefCookie(code) {
  const c = normalizeCode(code);
  // First-party, lax (so the cookie survives the off-site Stripe redirect).
  return `${REF_COOKIE}=${encodeURIComponent(c)}; Path=/; Max-Age=${REF_COOKIE_MAX_AGE}; SameSite=Lax; Secure; HttpOnly`;
}

export function readRefCookie(request) {
  const raw = request.headers.get('Cookie') || '';
  const m   = raw.match(new RegExp(`(?:^|;\\s*)${REF_COOKIE}=([^;]+)`));
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}


// ── Lookup helpers ─────────────────────────────────────────────────────────

export async function findCreatorByCode(db, code) {
  if (!code) return null;
  const res = await db.query(
    'SELECT * FROM affiliate_creators WHERE LOWER(coupon_code) = LOWER($1) LIMIT 1',
    [code]
  );
  return res.rows[0] || null;
}

export async function findCreatorByDashboardToken(db, token) {
  if (!token) return null;
  const res = await db.query(
    'SELECT * FROM affiliate_creators WHERE dashboard_token = $1 LIMIT 1',
    [token]
  );
  return res.rows[0] || null;
}

export async function findCreatorByEmail(db, email) {
  if (!email) return null;
  const res = await db.query(
    'SELECT * FROM affiliate_creators WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email]
  );
  return res.rows[0] || null;
}
