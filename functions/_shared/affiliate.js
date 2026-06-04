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


// ── Standalone comp / gift code ──────────────────────────────────────────────
// A 100%-off, single-use, 30-day code that behaves EXACTLY like a creator
// welcome freebie at checkout (free 1-pack + free stamp shipping) because it
// carries the same kind:'freebie' / source:'plf_affiliate' coupon metadata the
// create-checkout-session detection looks for. There is no creator row, so
// attributeOrder skips it and no commission is ever recorded. Minted on demand
// from the Command Station — e.g. gifting the product to a friend.
export async function createCompCoupon(env, { label } = {}) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const cleanLabel = (label || '').toString().slice(0, 80);
  const expiresAt  = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  const meta = {
    source: 'plf_affiliate',          // matches the checkout freebie detection
    kind:   'freebie',
    comp:   'true',                   // marks it as a gift, not a real creator
    label:  cleanLabel,
    creator_name: cleanLabel || 'Gift code',
  };

  // Pick a code that isn't already taken (random 5-char suffix; collisions are
  // astronomically rare, but check first so we never orphan a coupon).
  let code = null;
  for (let attempt = 0; attempt < 6 && !code; attempt++) {
    const candidate = `GIFT-${generateShortSuffix(5)}`;
    const taken = await stripe.promotionCodes.list({ code: candidate, limit: 1 });
    if (!taken.data.length) code = candidate;
  }
  if (!code) throw new Error('Could not generate a unique code — please try again.');

  const coupon = await stripe.coupons.create({
    name:            `gift 100% ${code}`.slice(0, 40),
    percent_off:     100,
    duration:        'once',
    redeem_by:       expiresAt,
    max_redemptions: 1,
    metadata:        meta,
  });
  const promo = await stripe.promotionCodes.create({
    coupon:          coupon.id,
    code,
    active:          true,
    max_redemptions: 1,
    expires_at:      expiresAt,
    metadata:        meta,
  });

  return { code, couponId: coupon.id, promoId: promo.id, expiresAt };
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

// Resolve a creator by the single-use welcome FREEBIE code (e.g.
// "MYCODE-WELCOME-X7K2"). Distinct from coupon_code, so attribution must check
// both — otherwise freebie redemptions never attribute to the creator.
export async function findCreatorByFreebieCode(db, code) {
  if (!code) return null;
  const res = await db.query(
    'SELECT * FROM affiliate_creators WHERE UPPER(freebie_code) = UPPER($1) LIMIT 1',
    [code]
  );
  return res.rows[0] || null;
}


// ── Order attribution ───────────────────────────────────────────────────────
// Resolve which creator (if any) a Checkout Session belongs to, by inspecting
// the applied promotion code(s) first, then the cookie-supplied affiliate_ref
// in metadata. Returns a structured result the callers use to (a) back-fill the
// pet_orders display columns and (b) commit the commission-bearing
// affiliate_orders row.
//
// Returns:
//   null                       — no affiliate association
//   { storeCredit: true }      — store-credit redemption, not a new attributable order
//   { full, creator, ... }     — resolved attribution + money fields (in cents)
export async function resolveAttribution(stripe, db, session) {
  // Re-fetch with discount + line-item totals expanded — the raw webhook event
  // payload doesn't always carry enough detail to resolve the promo code.
  let full;
  try {
    full = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['total_details.breakdown', 'line_items'],
    });
  } catch (err) {
    console.warn('resolveAttribution: session retrieve failed, using payload:', err);
    full = session;
  }

  let creator = null;
  let attribution = null;
  let isFreebie = false;

  const promoIds = (full?.discounts || []).map(d => d.promotion_code).filter(Boolean);

  // ── Path 2: promo code on the session ──
  if (promoIds.length) {
    for (const promoId of promoIds) {
      try {
        const pc = await stripe.promotionCodes.retrieve(promoId);

        // Store-credit redemptions: commission was already earned (and cashed
        // out) on whatever produced the balance. Not a new attributable order.
        if (pc.coupon?.metadata?.kind === 'store_credit') {
          return { storeCredit: true };
        }

        const code = normalizeCode(pc.code);
        // Match the regular affiliate code first, then the welcome freebie code
        // (which is "<coupon_code>-WELCOME-XXXX", a different string).
        let c = await findCreatorByCode(db, code);
        let viaFreebie = false;
        if (!c) { c = await findCreatorByFreebieCode(db, code); viaFreebie = !!c; }
        if (c) {
          creator     = c;
          attribution = 'coupon';
          // A welcome freebie (matched by freebie_code, or a 100%-off coupon) is
          // a non-commissionable sample.
          if (viaFreebie || pc.coupon?.percent_off === 100 ||
              code === c.coupon_code.toUpperCase() + '-WELCOME-' + code.slice(-4)) {
            isFreebie = true;
          }
          break;
        }
      } catch (err) {
        console.warn('resolveAttribution: promo retrieve failed:', err);
      }
    }
  }

  // ── Path 1: cookie-supplied affiliate_ref in metadata ──
  if (!creator) {
    const ref = normalizeCode(full?.metadata?.affiliate_ref || '');
    if (ref) {
      const c = await findCreatorByCode(db, ref);
      if (c) { creator = c; attribution = 'cookie'; }
    }
  }

  if (!creator) return null;

  // ── Money fields (cents) ──
  const subtotal      = Number(full?.amount_subtotal) || 0;
  const total         = Number(full?.amount_total)    || 0;
  const discountCents = Number(full?.total_details?.amount_discount) || 0;
  const shippingCents = Number(full?.total_details?.amount_shipping) || 0;
  // Commissionable gross = post-discount, pre-shipping/tax (≈ subtotal − discount).
  const grossCents    = Math.max(0, subtotal - discountCents);

  // Infer a freebie from the totals if the promo type didn't already flag it
  // (e.g. the whole order nets to just shipping, gross is zero).
  if (!isFreebie && total === shippingCents && grossCents === 0) {
    isFreebie = true;
  }

  const commissionRate  = Number(creator.commission_rate);
  const commissionCents = isFreebie ? 0 : Math.round(grossCents * commissionRate);

  return {
    full, creator, attribution, isFreebie,
    subtotal, total, discountCents, shippingCents, grossCents,
    commissionRate, commissionCents,
  };
}

// Back-fill the pet_orders affiliate_* columns for at-a-glance visibility in the
// Command Station. Safe to call for ANY order state (including unpaid /
// address_invalid) — it writes display fields only and never inserts a
// commission-bearing affiliate_orders row or marks a freebie redeemed.
// Returns the resolved attribution (or null) so callers can reuse it.
export async function backfillOrderAttribution(env, db, stripe, session, orderId) {
  const r = await resolveAttribution(stripe, db, session);
  if (!r || r.storeCredit || !r.creator) return r || null;
  await db.query(
    `UPDATE pet_orders SET
       affiliate_creator_id       = $1,
       affiliate_coupon_code      = $2,
       affiliate_commission_rate  = $3,
       affiliate_commission_cents = $4,
       affiliate_is_freebie       = $5
     WHERE order_id = $6`,
    [r.creator.id, r.creator.coupon_code, r.commissionRate, r.commissionCents, r.isFreebie, orderId]
  );
  return r;
}

// Commit the commission-bearing affiliate_orders row for a PAID / fulfilled
// order. Idempotent on order_id_text. Also back-fills pet_orders and marks the
// creator's freebie redeemed. Call ONLY once the order is actually paid
// (webhook capture, success-page recovery, or admin override) — never for an
// order that may still fall through.
export async function attributeOrder(env, db, stripe, session, orderId) {
  const r = await resolveAttribution(stripe, db, session);
  if (!r || r.storeCredit || !r.creator) return;

  const { full, creator, attribution, isFreebie,
          grossCents, discountCents, commissionRate, commissionCents } = r;

  // Look up pet_orders.id for the FK
  const po = await db.query('SELECT id FROM pet_orders WHERE order_id = $1 LIMIT 1', [orderId]);
  const petOrderPK = po.rows[0]?.id || null;

  // Insert (idempotent on order_id_text)
  await db.query(
    `INSERT INTO affiliate_orders
       (creator_id, pet_order_id, order_id_text, stripe_session_id, stripe_payment_intent,
        attribution_method, is_freebie, gross_cents, discount_cents,
        commission_rate, commission_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (order_id_text) DO NOTHING`,
    [
      creator.id, petOrderPK, orderId,
      full?.id || session.id, full?.payment_intent || session.payment_intent || '',
      attribution, isFreebie, grossCents, discountCents,
      commissionRate, commissionCents,
    ]
  );

  // Back-fill pet_orders for at-a-glance visibility
  await db.query(
    `UPDATE pet_orders SET
       affiliate_creator_id      = $1,
       affiliate_coupon_code     = $2,
       affiliate_commission_rate = $3,
       affiliate_commission_cents = $4,
       affiliate_is_freebie      = $5
     WHERE order_id = $6`,
    [creator.id, creator.coupon_code, commissionRate, commissionCents, isFreebie, orderId]
  );

  // If this was a freebie redemption, mark it on the creator row.
  if (isFreebie && !creator.freebie_redeemed_at) {
    await db.query(
      `UPDATE affiliate_creators
       SET freebie_redeemed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND freebie_redeemed_at IS NULL`,
      [creator.id]
    );
  }

  // Hand the resolved attribution back so callers can tailor follow-ups
  // (e.g. show "Free" instead of the full price on a freebie confirmation).
  return r;
}

// Resolve the capturable PaymentIntent id for an order. Prefers the stored
// stripe_payment_intent, falling back to retrieving the Checkout Session when
// the webhook never persisted it (older orders, races, or a session whose PI
// only materialised later). Returns '' when there is genuinely no PaymentIntent
// — e.g. a 100%-off freebie whose total was $0 (nothing to capture).
export async function getPaymentIntentId(stripe, order) {
  if (order?.stripe_payment_intent) return order.stripe_payment_intent;
  const sessionId = order?.stripe_session_id;
  if (!sessionId) return '';
  try {
    const s = await stripe.checkout.sessions.retrieve(sessionId);
    return s?.payment_intent || '';
  } catch (err) {
    console.warn('getPaymentIntentId: session retrieve failed:', err);
    return '';
  }
}
