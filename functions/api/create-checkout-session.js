// ── Pet License Factory — Stripe Checkout (Cloudflare Pages Function) ───────
// POST /api/create-checkout-session
// Body: { orderId, packQty, format, wantsDecal, discountEarned, petData, origin, cancelUrl,
//         promoCode?, affiliateRef? }
// Returns: { url, sessionId }
// ---------------------------------------------------------------------------

import Stripe from 'stripe';
import { getDb } from '../_shared/db.js';
import { readRefCookie, normalizeCode } from '../_shared/affiliate.js';
import { PRICES, GOOFY_PRICES, plcItem } from '../_shared/pricing.js';
import { lineOfBrand } from '../_shared/lines.js';

// PRICES (US cents) is the canonical source of truth — see
// functions/_shared/pricing.js. The client mirror is public/pricing.js.

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
    // Pet format: 'skin' (default) | 'card' | 'bundle'. See plcItem().
    format         = 'skin',
    wantsDecal     = false,
    discountEarned = false,
    petData        = {},
    origin         = '',
    cancelUrl      = '',
    promoCode      = '',
    affiliateRef   = '',
    // ── Goofy Licenses (additive; absent/anything-else ⇒ PLC path) ──
    brand          = '',
    variant        = '',
    src            = '',
    recipientName  = '',
    giverName      = '',
    // Multi-nominee batch: every id belongs to one checkout (one shipment).
    orderIds       = [],
    recipientCount = 0,
    // G.O.A.T.: the nominee's mailing address from the builder
    // { name, line1, line2, city, state, zip }. When present, Stripe doesn't
    // collect a shipping address; the webhook fills the order from metadata.
    shipTo         = null,
  } = body;

  // Brand gate: ONLY the G.O.A.T. line ('goat', or the legacy 'goofy' the
  // builder still sends) takes the Goofy path. Everything else is PLC.
  const isGoofy = !!brand && lineOfBrand(brand) === 'goat';
  const GOOFY_VARIANTS = ['standard', 'custom-giver', 'custom-anon'];
  const gVariant = GOOFY_VARIANTS.includes(variant) ? variant : 'standard';
  // Headcount: explicit ids win, then the count hint. Clamped 1–5 (matches
  // submit-order's cap). The fee is charged PER nominee via quantity.
  const gIds = (Array.isArray(orderIds) ? orderIds : []).filter((id) => typeof id === 'string' && /^GOOFY-/i.test(id)).slice(0, 5);
  const gCount = isGoofy ? Math.min(5, Math.max(1, gIds.length || parseInt(recipientCount) || 1)) : 1;

  // Affiliate ref resolution priority: explicit body → first-party cookie.
  const refFromCookie = readRefCookie(request);
  const ref = normalizeCode(affiliateRef || refFromCookie);

  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const st = isGoofy && shipTo && typeof shipTo === 'object' ? shipTo : null;
  const goatShipTo = st && clip(st.line1, 200) && clip(st.city, 100) && clip(st.state, 40) && clip(st.zip, 20)
    ? { name: clip(st.name, 100), line1: clip(st.line1, 200), line2: clip(st.line2, 200),
        city: clip(st.city, 100), state: clip(st.state, 40), zip: clip(st.zip, 20) }
    : null;

  // ── Calculate line item amounts in cents ──────────────────────────────────
  const item = plcItem(format, packQty);
  let packAmount  = item.amount;
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
          name: item.name,
          description: ({
            skin:   'Custom pet license card skin sticker with your pet\'s photo and info',
            card:   'Custom pet license printed on a real PVC card with your pet\'s photo and info',
            bundle: 'Your pet\'s license as a card skin sticker AND a real PVC license card',
          })[item.format] + (discountEarned ? ' (15% mini-game discount applied!)' : ''),
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
          name: '4×4" Vinyl Car Decal',
          description: discountEarned
            ? 'Weatherproof vinyl die-cut of your pet — 15% discount applied!'
            : 'Weatherproof vinyl die-cut sticker for your car',
        },
        unit_amount: decalAmount,
      },
      quantity: 1,
    });
  }

  // ── Goofy Licenses line items (additive branch) ──────────────────────────
  // Same Stripe account, new inline products. Every price IS a "nomination
  // processing fee" — never a fee on top. The Goofy branch rebuilds the cart
  // from GOOFY_PRICES, so PLC discount/decal math above can never leak in
  // (a forged discountEarned is ignored by construction).
  if (isGoofy) {
    const gAmount = gVariant === 'standard' ? GOOFY_PRICES.standard : GOOFY_PRICES.custom;
    const gNames = {
      'standard':     'G.O.A.T. License — Standard Nomination',
      'custom-giver': 'G.O.A.T. License — Custom Nomination (with giver credit)',
      'custom-anon':  'G.O.A.T. License — Custom Nomination (anonymous)',
    };
    const gDescs = {
      'standard':     'Certified G.O.A.T. license kit mailed to your nominee — $4.95 nomination processing fee, all-in.',
      'custom-giver': 'Custom G.O.A.T. license with nominee name & photo, presented by you — $8.95 nomination processing fee, all-in.',
      'custom-anon':  'Custom G.O.A.T. license with nominee name & photo, no giver named — $8.95 nomination processing fee, all-in.',
    };
    lineItems.length = 0;
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: gNames[gVariant], description: gDescs[gVariant] },
        unit_amount: gAmount,
      },
      // One kit per nominee, one shipment.
      quantity: gCount,
    });
  }

  // ── Build URLs ────────────────────────────────────────────────────────────
  const siteOrigin = origin || env.URL || 'http://localhost:8788';
  // Goofy nominators land on the Goofy success page — never on PLC copy.
  const successUrl = isGoofy
    ? `${siteOrigin}/goofy/success.html?session_id={CHECKOUT_SESSION_ID}&order_id=${encodeURIComponent(orderId)}`
    : `${siteOrigin}/success.html?session_id={CHECKOUT_SESSION_ID}&order_id=${encodeURIComponent(orderId)}`;
  const cancel     = cancelUrl || (isGoofy ? `${siteOrigin}/goofy/nominate.html` : `${siteOrigin}/game.html`);

  // ── Create Stripe Checkout Session ───────────────────────────────────────
  // One Stripe shipping option (fixed amount in cents, business-day window).
  const shipRate = (amount, name, minDays, maxDays) => ({
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount, currency: 'usd' },
      display_name: name,
      delivery_estimate: {
        minimum: { unit: 'business_day', value: minDays },
        maximum: { unit: 'business_day', value: maxDays },
      },
    },
  });

  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);

    // ── Resolve a `?promo=<code>` URL parameter into a Stripe promotion ──
    // code id. If the code is valid and active, we apply it via the
    // session's `discounts` array (which is mutually exclusive with
    // `allow_promotion_codes` — Stripe blocks both in the same session).
    let preAppliedPromoId = null;
    let allowPromotionCodes = true;
    let freebieFreeShipping = false;  // creator welcome freebie → free stamp shipping
    const cleanPromo = String(promoCode || '').trim();
    if (cleanPromo) {
      try {
        const list = await stripe.promotionCodes.list({
          code: cleanPromo, active: true, limit: 1,
        });
        if (list.data.length) {
          preAppliedPromoId   = list.data[0].id;
          allowPromotionCodes = false;
          // Detect creator welcome freebie (kind=freebie metadata, set at
          // promo creation time in functions/_shared/affiliate.js). Those
          // get free stamp shipping so the creator never pays anything.
          const meta = list.data[0].coupon?.metadata || {};
          if (meta.kind === 'freebie' && meta.source === 'plf_affiliate') {
            freebieFreeShipping = true;
          }
        }
      } catch (err) {
        console.warn('promo lookup failed (continuing without preapply):', err);
      }
    }

    // ── Freebie restriction: scope the 100%-off creator welcome code to a
    // single 1-pack pet license at regular price (a sticker, or a card if
    // they picked the card; a bundle gets the sticker). Without this the freebie
    // would zero out a 2-pack or a decal add-on too, which is not the deal.
    // Replace the line items with a fresh single-item cart regardless of
    // what the body asked for. The 100% coupon then zeros the cart and
    // Stripe always clamps amount_total >= 0, so no stacking can go negative.
    // (PLC-only: the Goofy branch already rebuilt the cart above.)
    if (freebieFreeShipping && !isGoofy) {
      const free = plcItem(item.format === 'card' ? 'card' : 'skin', 1);
      lineItems.length = 0;
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: free.name,
            description: 'Creator welcome freebie — custom pet ' + (free.format === 'card' ? 'license card' : 'license sticker'),
          },
          unit_amount: free.amount,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      // US-only: the Stamp shipping tier is USPS domestic mail and cannot be
      // sent internationally. A G.O.A.T. nomination already has the nominee's
      // address from the builder, so Stripe doesn't ask again (see goatShipTo).
      ...(goatShipTo ? {} : { shipping_address_collection: { allowed_countries: ['US'] } }),
      // Either pre-apply a promo, or let the customer type one in. Not both.
      ...(preAppliedPromoId
        ? { discounts: [{ promotion_code: preAppliedPromoId }] }
        : { allow_promotion_codes: true }),
      // G.O.A.T.: stamp-mail delivery is included in the processing fee ($0);
      // the tracked tiers are optional paid upgrades. Pet orders keep paid
      // stamp shipping. A creator freebie gets free stamp only. (The webhook
      // maps the charged amount back to a tier: $0 → stamp.)
      shipping_options: freebieFreeShipping
        ? [shipRate(0, 'Stamp Shipping (free)', 3, 7)]
        : isGoofy
          ? [
              shipRate(0, 'Stamp Shipping (included, no tracking)', 3, 7),
              shipRate(GOOFY_PRICES.standardShip, 'Standard Shipping (tracked)', 4, 7),
              shipRate(GOOFY_PRICES.priority, 'Priority Shipping (tracked)', 3, 5),
            ]
          : [
              shipRate(PRICES.stamp, 'Stamp Shipping', 3, 7),
              shipRate(PRICES.standard, 'Standard Shipping', 4, 7),
              shipRate(PRICES.priority, 'Priority Shipping', 3, 5),
            ],
      customer_creation: 'always',
      // Abandoned-checkout recovery: expire unfinished sessions after 2 hours
      // so Stripe fires checkout.session.expired with a 30-day recovery URL
      // (and whatever email the customer typed before bailing). The webhook
      // turns that into a finish-your-order nudge. allow_promotion_codes on
      // the recovered session conflicts with a pre-applied discount, so only
      // set it when this session takes typed promo codes too.
      expires_at: Math.floor(Date.now() / 1000) + 2 * 60 * 60,
      after_expiration: {
        recovery: {
          enabled: true,
          ...(preAppliedPromoId ? {} : { allow_promotion_codes: true }),
        },
      },
      // Charge immediately on checkout. Stripe collects + lightly validates the
      // shipping address; we ship what the customer entered (no USPS gate).
      // G.O.A.T. charges carry a short statement suffix ("<PREFIX>* GOAT") so
      // the bank line matches what they bought; kept short so prefix + suffix
      // stays inside the 22-character card statement limit.
      payment_intent_data: {
        capture_method: 'automatic',
        ...(isGoofy ? { statement_descriptor_suffix: 'GOAT' } : {}),
      },
      // The Stripe account is the Pet License Factory business; for G.O.A.T.
      // checkouts show the house brand at the top of the page instead (Stripe
      // still uses the account name on its own receipts and terms).
      ...(isGoofy ? {
        branding_settings: {
          display_name:     'Goofy Licenses',
          background_color: '#F4EFE4',
          button_color:     '#1D2140',
          border_style:     'rounded',
        },
      } : {}),
      metadata: {
        order_id:        orderId,
        pet_first_name:  (petData.petFirstName || '').slice(0, 100),
        pet_last_name:   (petData.petLastName  || '').slice(0, 100),
        pack_qty:        String(item.packQty),
        wants_decal:     String(wantsDecal),
        discount_earned: String(discountEarned),
        affiliate_ref:   ref || '',
        // ── Goofy Licenses (additive keys; empty on PLC orders) ──
        brand:           isGoofy ? 'goat' : 'plc',
        // G.O.A.T. variant, or the pet format (skin | card | bundle).
        variant:         isGoofy ? gVariant : (freebieFreeShipping ? (item.format === 'card' ? 'card' : 'skin') : item.format),
        src:             isGoofy ? String(src || '').slice(0, 120) : '',
        recipient_name:  isGoofy ? String(recipientName || '').slice(0, 100) : '',
        giver_name:      isGoofy ? String(giverName || '').slice(0, 100) : '',
        // Batch: every row id in this checkout + headcount (the webhook
        // finalises all of them; the email names the first + count).
        order_ids:       isGoofy && gIds.length > 1 ? gIds.join(',').slice(0, 500) : '',
        recipient_count: isGoofy ? String(gCount) : '',
        // Where a G.O.A.T. kit ships when Stripe didn't collect an address
        // (read by the webhook). Absent on PLC orders.
        ...(goatShipTo ? {
          ship_name: goatShipTo.name, ship_line1: goatShipTo.line1, ship_line2: goatShipTo.line2,
          ship_city: goatShipTo.city, ship_state: goatShipTo.state, ship_zip: goatShipTo.zip,
        } : {}),
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
      // Multi-nominee batch: every row shares the checkout session so the
      // success page, address-fix, and webhook can reach all of them.
      // Goofy-only, best-effort — the first row above is the source of truth.
      const gExtras = isGoofy ? gIds.filter((id) => id !== orderId) : [];
      if (gExtras.length) {
        try {
          await getDb(env).query(
            `UPDATE pet_orders
               SET stripe_session_id = $1,
                   affiliate_ref_at_submit = COALESCE(NULLIF($2, ''), affiliate_ref_at_submit)
             WHERE order_id = ANY($3::text[])`,
            [session.id, ref || '', gExtras]
          );
        } catch (err) {
          console.error('Failed to persist batch stripe_session_id (non-fatal):', err);
        }
      }
    }

    return json(200, { url: session.url, sessionId: session.id });

  } catch (err) {
    console.error('Stripe create-checkout-session error:', err);
    return json(500, { error: err.message });
  }
}
