// ── Pet Licence Factory — Stripe Webhook (Cloudflare Pages Function) ────────
// POST /api/stripe-webhook
// Handles: checkout.session.completed
//   1. Stripe Checkout uses capture_method: 'manual' — the card is auth'd, not charged
//   2. We verify the shipping address with USPS (via EasyPost)
//   3. If verified → capture the PaymentIntent and send confirmation email
//   4. If not verified → mark order address_invalid (auth left untouched so the
//      customer can fix the address on the success page within 5 attempts; we
//      void the auth from /api/update-address once retries are exhausted)
// ---------------------------------------------------------------------------

import Stripe from 'stripe';
import { getDb } from '../_shared/db.js';
import { sendOrderConfirmationEmail, sendAddressIssueEmail } from '../_shared/email.js';
import { verifyAddress } from '../_shared/easypost.js';
import { findCreatorByCode, normalizeCode } from '../_shared/affiliate.js';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const stripe        = new Stripe(env.STRIPE_SECRET_KEY);
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  const sig           = request.headers.get('stripe-signature');
  const db            = getDb(env);

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not set — refusing to process unverified webhook');
    return new Response('Server configuration error: webhook secret not set', { status: 500 });
  }

  // CRITICAL: Use request.text() for raw body — Stripe needs the exact string for HMAC
  let rawBody;
  try {
    rawBody = await request.text();
  } catch (err) {
    return new Response('Could not read request body', { status: 400 });
  }

  let stripeEvent;
  try {
    stripeEvent = await stripe.webhooks.constructEventAsync(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // ── Refund handling (zero out commission on the affiliate row) ───────────
  if (stripeEvent.type === 'charge.refunded') {
    return handleChargeRefunded(stripeEvent.data.object, db);
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return json(200, { received: true });
  }

  const session = stripeEvent.data.object;
  const orderId = session.metadata?.order_id;

  if (!orderId) {
    console.warn('No order_id in session metadata — skipping DB update');
    return json(200, { received: true });
  }

  // ── Determine shipping option from price (saves a Stripe API subrequest) ──
  let shippingOption = 'stamp';
  const shipAmt = session.shipping_cost?.amount_total
               ?? session.shipping_cost?.amount_subtotal
               ?? 0;
  if      (shipAmt >= 700) shippingOption = 'priority';   // $7.99
  else if (shipAmt >= 300) shippingOption = 'standard';   // $3.99
  else                     shippingOption = 'stamp';      // $0.95 or unknown

  // ── Extract customer + address from the session ──────────────────────────
  const ship         = session.shipping_details
                    || session.collected_information?.shipping_details
                    || {};
  const addr         = ship.address || {};
  const email        = session.customer_details?.email || '';
  const customerName = session.customer_details?.name  || ship.name || '';
  const paymentIntentId = session.payment_intent || '';

  console.log('[webhook] session.completed', {
    orderId, shipAmt, shippingOption, hasAddr: !!addr?.line1, email, paymentIntentId,
  });

  // ── 1. Persist what Stripe gave us (status pending verification) ─────────
  let orderRow;
  try {
    const result = await db.query(
      `UPDATE pet_orders SET
         status                = 'address_pending_verification',
         stripe_payment_id     = $1,
         stripe_payment_intent = $2,
         customer_email        = $3,
         customer_name         = $4,
         ship_addr_line1       = $5,
         ship_addr_line2       = $6,
         ship_city             = $7,
         ship_state            = $8,
         ship_zip              = $9,
         ship_country          = $10,
         shipping_option       = $11,
         updated_at            = NOW()
       WHERE order_id = $12
       RETURNING order_id, pet_first_name, pet_last_name, pack_count, add_on, chip_size,
                 shipping_option, total, customer_email, customer_name,
                 ship_addr_line1, ship_addr_line2, ship_city, ship_state, ship_zip, ship_country`,
      [
        paymentIntentId || session.id,
        paymentIntentId || '',
        email,
        customerName,
        addr.line1       || '',
        addr.line2       || '',
        addr.city        || '',
        addr.state       || '',
        addr.postal_code || '',
        addr.country     || 'US',
        shippingOption,
        orderId,
      ]
    );
    orderRow = result.rows[0];
  } catch (err) {
    console.error('Database update error:', err);
    return new Response('Database update failed', { status: 500 });
  }

  if (!orderRow) {
    console.warn(`No pet_orders row matched order_id=${orderId}`);
    return json(200, { received: true });
  }

  // ── 2. Verify the shipping address via EasyPost ──────────────────────────
  let verification;
  try {
    verification = await verifyAddress(env, {
      street1: orderRow.ship_addr_line1,
      street2: orderRow.ship_addr_line2,
      city:    orderRow.ship_city,
      state:   orderRow.ship_state,
      zip:     orderRow.ship_zip,
      country: orderRow.ship_country,
    });
  } catch (err) {
    // Hard EasyPost failure (network, auth, etc.) — leave order as
    // address_pending_verification. Stripe will retry the webhook on 5xx.
    console.error('Address verification hard-failed:', err);
    return new Response('Address verification temporarily unavailable', { status: 503 });
  }

  if (verification.ok) {
    // ── 3a. Capture the auth and finalise the order ────────────────────────
    if (paymentIntentId) {
      try {
        await stripe.paymentIntents.capture(paymentIntentId);
      } catch (err) {
        // If the auth was already captured (rare race) Stripe returns 400.
        // Anything else is an unexpected failure — log loudly but still
        // mark the order paid so we don't double-handle.
        const msg = String(err?.message || err);
        if (!/already.*captured/i.test(msg)) {
          console.error('paymentIntents.capture failed:', err);
        }
      }
    }

    try {
      await db.query(
        `UPDATE pet_orders SET
           status             = 'paid',
           verification_error = NULL,
           updated_at         = NOW()
         WHERE order_id = $1`,
        [orderId]
      );
    } catch (err) {
      console.error('Failed to flip order to paid (non-fatal):', err);
    }

    // ── Affiliate attribution ─────────────────────────────────────────────
    // Resolves the creator from (in order):
    //   1. an applied promotion code on the session
    //   2. session.metadata.affiliate_ref (set from the cookie at checkout)
    //
    // Records a row in affiliate_orders with the commission rate locked in,
    // and back-fills the matching pet_orders columns so admin views can see
    // attribution without joining. Always non-fatal.
    try {
      await attributeOrder(env, db, stripe, session, orderId);
    } catch (err) {
      console.error('Affiliate attribution failed (non-fatal):', err);
    }

    // Confirmation email — same template as before
    try {
      await sendOrderConfirmationEmail(env, {
        orderId:        orderRow.order_id,
        customerEmail:  orderRow.customer_email,
        customerName:   orderRow.customer_name,
        petFirstName:   orderRow.pet_first_name,
        petLastName:    orderRow.pet_last_name,
        packCount:      orderRow.pack_count,
        addOn:          orderRow.add_on,
        chipSize:       orderRow.chip_size,
        shippingOption: orderRow.shipping_option,
        total:          orderRow.total,
        shipAddrLine1:  orderRow.ship_addr_line1,
        shipAddrLine2:  orderRow.ship_addr_line2,
        shipCity:       orderRow.ship_city,
        shipState:      orderRow.ship_state,
        shipZip:        orderRow.ship_zip,
        shipCountry:    orderRow.ship_country,
      });
    } catch (emailErr) {
      console.error('Confirmation email failed (non-fatal):', emailErr);
    }

    return json(200, { received: true, status: 'paid' });
  }

  // ── 3b. Verification failed — mark address_invalid, leave auth open ─────
  // The auth is held for ~7 days. The customer can fix the address on the
  // success page (within 5 attempts) which will trigger the capture. If they
  // give up, the auth expires naturally and no charge is ever made.
  try {
    await db.query(
      `UPDATE pet_orders SET
         status             = 'address_invalid',
         verification_error = $1,
         updated_at         = NOW()
       WHERE order_id = $2`,
      [verification.error || 'Address could not be verified.', orderId]
    );
  } catch (err) {
    console.error('Failed to flag address_invalid:', err);
  }

  // Email the customer with a link back to the success page so they can fix
  // the address even if they closed the tab.
  try {
    await sendAddressIssueEmail(env, {
      orderId:       orderRow.order_id,
      customerEmail: orderRow.customer_email,
      petFirstName:  orderRow.pet_first_name,
      petLastName:   orderRow.pet_last_name,
      sessionId:     session.id,
      reason:        verification.error || 'USPS could not verify the address.',
      siteOrigin:    env.URL || 'https://petlicensefactory.com',
    });
  } catch (emailErr) {
    console.error('Address-issue email failed (non-fatal):', emailErr);
  }

  return json(200, { received: true, status: 'address_invalid' });
}


// ── Affiliate attribution ──────────────────────────────────────────────────
// Called once per checkout.session.completed (after the order is paid).
//
// Tries promotion code first (path 2 in the brief), then the cookie ref
// (path 1). If we find a creator, write the affiliate_orders row with
// commission rate locked in and back-fill pet_orders.
async function attributeOrder(env, db, stripe, session, orderId) {
  // Re-fetch the session with the discount + line item totals expanded so
  // we can resolve which promotion code was applied. The original webhook
  // event payload doesn't always include enough detail.
  let full;
  try {
    full = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['total_details.breakdown', 'line_items'],
    });
  } catch (err) {
    console.warn('session retrieve failed, falling back to event payload:', err);
    full = session;
  }

  // ── Path 2: promo code on the session ──
  let creator = null;
  let attribution = null;
  let isFreebie = false;

  const discounts = full?.total_details?.breakdown?.discounts || [];
  const promoIds  = (full?.discounts || []).map(d => d.promotion_code).filter(Boolean);

  // The session's `discounts` array carries the applied promo code id(s).
  // The breakdown carries the coupon id+amount. Try both.
  if (promoIds.length) {
    for (const promoId of promoIds) {
      try {
        const pc = await stripe.promotionCodes.retrieve(promoId);

        // Store-credit redemptions: the creator already earned (and cashed
        // out) commission on whatever produced this balance. The redemption
        // itself is not a new attributable order — bailing out here also
        // suppresses path 1 (cookie ref), which would otherwise let a
        // creator re-commission themselves by spending their own credit.
        if (pc.coupon?.metadata?.kind === 'store_credit') {
          return;
        }

        const code = normalizeCode(pc.code);
        const c = await findCreatorByCode(db, code);
        if (c) {
          creator     = c;
          attribution = 'coupon';
          // Welcome freebie code = 100% off. Mark non-commissionable.
          if (code === c.coupon_code.toUpperCase() + '-WELCOME-' + code.slice(-4) ||
              (pc.coupon?.percent_off === 100)) {
            isFreebie = true;
          }
          break;
        }
      } catch (err) {
        console.warn('promo retrieve failed:', err);
      }
    }
  }

  // ── Path 1: cookie-supplied affiliate_ref in metadata ──
  if (!creator) {
    const ref = normalizeCode(full?.metadata?.affiliate_ref || '');
    if (ref) {
      const c = await findCreatorByCode(db, ref);
      if (c) {
        creator     = c;
        attribution = 'cookie';
      }
    }
  }

  if (!creator) return; // unattributed — totally fine

  // ── Compute money fields ────────────────────────────────────────────────
  // Stripe gives us amount_subtotal (pre-discount), amount_total (post),
  // total_details.amount_discount.
  const subtotal     = Number(full?.amount_subtotal) || 0;
  const total        = Number(full?.amount_total)    || 0;
  const discountCents = Number(full?.total_details?.amount_discount) || 0;
  const shippingCents = Number(full?.total_details?.amount_shipping) || 0;
  // Commissionable gross = post-discount, pre-shipping/tax (≈ subtotal − discount).
  const grossCents = Math.max(0, subtotal - discountCents);

  // If the freebie wasn't already detected via promo type, infer from total.
  if (!isFreebie && total === shippingCents && grossCents === 0) {
    isFreebie = true;
  }

  const commissionRate  = Number(creator.commission_rate);
  const commissionCents = isFreebie ? 0 : Math.round(grossCents * commissionRate);

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
}


// ── Refund handling ────────────────────────────────────────────────────────
// charge.refunded fires whenever a refund is created on the charge. We zero
// out commission on full refunds; on partial refunds we keep things simple
// and zero the whole row (the payment for the order is gone).
async function handleChargeRefunded(charge, db) {
  const piId   = charge.payment_intent;
  const refund = Number(charge.amount_refunded) || 0;
  const total  = Number(charge.amount) || 0;

  // Refund must reference our affiliate order. Match on payment_intent.
  const r = await db.query(
    `SELECT id, commission_cents, commission_zeroed
     FROM affiliate_orders WHERE stripe_payment_intent = $1 LIMIT 1`,
    [piId]
  );
  if (r.rows.length === 0) {
    return new Response(JSON.stringify({ received: true, no_match: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  const ao = r.rows[0];

  if (ao.commission_zeroed) {
    return new Response(JSON.stringify({ received: true, already_zeroed: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  await db.query(
    `UPDATE affiliate_orders SET
       commission_cents  = 0,
       commission_zeroed = TRUE,
       refunded_at       = NOW(),
       refund_cents      = $1,
       updated_at        = NOW()
     WHERE id = $2`,
    [refund, ao.id]
  );
  // Also zero on pet_orders for the at-a-glance view
  await db.query(
    `UPDATE pet_orders SET affiliate_commission_cents = 0
     WHERE stripe_payment_intent = $1`,
    [piId]
  );

  return new Response(JSON.stringify({ received: true, zeroed: true, refund_cents: refund }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
