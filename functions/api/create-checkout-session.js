// ── Pet Licence Factory — Stripe Checkout (Cloudflare Pages Function) ───────
// POST /api/create-checkout-session
// Body: { orderId, packQty, wantsDecal, discountEarned, petData, origin, cancelUrl,
//         promoCode?, affiliateRef? }
// Returns: { url, sessionId }
// ---------------------------------------------------------------------------

import Stripe from 'stripe';
import { getDb } from '../_shared/db.js';
import { readRefCookie, normalizeCode } from '../_shared/affiliate.js';

// Prices in US cents — must match PRICES in plf-shared.js
const PRICES = {
  pack1:    1395,   // 1-Pack Licence Sticker
  pack2:    1999,   // 2-Pack Licence Stickers
  decal:     499,   // 8×8" Vinyl Car Decal
  discRate:  0.15,  // 15% discount (mini-game reward)
  stamp:      95,   // Stamp Shipping
  standard:  399,   // Standard Shipping
  priority:  799,   // Priority Shipping
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const {
    orderId        = '',
    packQty        = 1,
    wantsDecal     = false,
    discountEarned = false,
    petData        = {},
    origin         = '',
    cancelUrl      = '',
    promoCode      = '',
    affiliateRef   = '',
  } = body;

  // Affiliate ref resolution priority: explicit body → first-party cookie.
  const refFromCookie = readRefCookie(request);
  const ref = normalizeCode(affiliateRef || refFromCookie);

  // ── Calculate line item amounts in cents ──────────────────────────────────
  let packAmount  = packQty === 2 ? PRICES.pack2 : PRICES.pack1;
  let decalAmount = wantsDecal ? PRICES.decal : 0;

  if (discountEarned) {
    packAmount  = Math.round(packAmount  * (1 - PRICES.discRate));
    decalAmount = decalAmount > 0 ? Math.round(decalAmount * (1 - PRICES.discRate)) : 0;
  }

  // ── Build Stripe line items ───────────────────────────────────────────────
  const lineItems = [
    {
      price_data: {
        currency: 'usd',
        product_data: {
          name: packQty === 2
            ? 'Pet Licence Sticker (2-Pack)'
            : 'Pet Licence Sticker (1-Pack)',
          description: discountEarned
            ? 'Custom pet licence sticker — 15% mini-game discount applied!'
            : 'Custom pet licence sticker with your pet\'s photo and info',
        },
        unit_amount: packAmount,
      },
      quantity: 1,
    },
  ];

  if (wantsDecal) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: '8×8" Vinyl Car Decal',
          description: discountEarned
            ? 'Weatherproof vinyl die-cut of your pet — 15% discount applied!'
            : 'Weatherproof vinyl die-cut sticker for your car',
        },
        unit_amount: decalAmount,
      },
      quantity: 1,
    });
  }

  // ── Build URLs ────────────────────────────────────────────────────────────
  const siteOrigin = origin || env.URL || 'http://localhost:8788';
  const successUrl = `${siteOrigin}/success.html?session_id={CHECKOUT_SESSION_ID}&order_id=${encodeURIComponent(orderId)}`;
  const cancel     = cancelUrl || `${siteOrigin}/game.html`;

  // ── Create Stripe Checkout Session ───────────────────────────────────────
  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);

    // ── Resolve a `?promo=<code>` URL parameter into a Stripe promotion ──
    // code id. If the code is valid and active, we apply it via the
    // session's `discounts` array (which is mutually exclusive with
    // `allow_promotion_codes` — Stripe blocks both in the same session).
    let preAppliedPromoId = null;
    let allowPromotionCodes = true;
    const cleanPromo = String(promoCode || '').trim();
    if (cleanPromo) {
      try {
        const list = await stripe.promotionCodes.list({
          code: cleanPromo, active: true, limit: 1,
        });
        if (list.data.length) {
          preAppliedPromoId   = list.data[0].id;
          allowPromotionCodes = false;
        }
      } catch (err) {
        console.warn('promo lookup failed (continuing without preapply):', err);
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'NZ'],
      },
      // Either pre-apply a promo, or let the customer type one in. Not both.
      ...(preAppliedPromoId
        ? { discounts: [{ promotion_code: preAppliedPromoId }] }
        : { allow_promotion_codes: true }),
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: PRICES.stamp, currency: 'usd' },
            display_name: 'Stamp Shipping',
            delivery_estimate: {
              minimum: { unit: 'week', value: 2 },
              maximum: { unit: 'week', value: 4 },
            },
          },
        },
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: PRICES.standard, currency: 'usd' },
            display_name: 'Standard Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 7 },
              maximum: { unit: 'business_day', value: 14 },
            },
          },
        },
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: PRICES.priority, currency: 'usd' },
            display_name: 'Priority Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 3 },
              maximum: { unit: 'business_day', value: 5 },
            },
          },
        },
      ],
      customer_creation: 'always',
      // Auth-only: we capture the funds in the webhook only after USPS
      // verifies the shipping address. If verification fails, the auth is
      // voided and the customer is never charged.
      payment_intent_data: {
        capture_method: 'manual',
      },
      metadata: {
        order_id:        orderId,
        pet_first_name:  (petData.petFirstName || '').slice(0, 100),
        pet_last_name:   (petData.petLastName  || '').slice(0, 100),
        pack_qty:        String(packQty),
        wants_decal:     String(wantsDecal),
        discount_earned: String(discountEarned),
        affiliate_ref:   ref || '',
      },
      success_url: successUrl,
      cancel_url:  cancel,
    });

    // Persist the session id on the order so the public success page can
    // poll /api/order-status?session_id=... without exposing PII via the
    // (guessable) order_id alone. Non-fatal if it fails — the webhook can
    // still find the order via metadata.order_id.
    if (orderId) {
      try {
        await getDb(env).query(
          `UPDATE pet_orders
             SET stripe_session_id = $1,
                 affiliate_ref_at_submit = COALESCE(NULLIF($2, ''), affiliate_ref_at_submit)
           WHERE order_id = $3`,
          [session.id, ref || '', orderId]
        );
      } catch (err) {
        console.error('Failed to persist stripe_session_id (non-fatal):', err);
      }
    }

    return json(200, { url: session.url, sessionId: session.id });

  } catch (err) {
    console.error('Stripe create-checkout-session error:', err);
    return json(500, { error: err.message });
  }
}
