// ── Pet Licence Factory — Stripe Webhook (Cloudflare Pages Function) ────────
// POST /api/stripe-webhook
// Handles: checkout.session.completed
//   Stripe Checkout uses automatic capture, so the card is charged on checkout.
//   We record the order as paid, attribute any affiliate, ship the address
//   Stripe collected, and send the confirmation email. There is NO USPS/
//   deliverability gate — we ship exactly what the customer entered.
// ---------------------------------------------------------------------------

import Stripe from 'stripe';
import { getDb } from '../_shared/db.js';
import { sendOrderConfirmationEmail } from '../_shared/email.js';
import { attributeOrder } from '../_shared/affiliate.js';

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

  // Record what Stripe ACTUALLY charged (amount_total, in cents) as the order
  // total, so Command Station, the receipt, and the confirmation email match the
  // Stripe transaction instead of the client-submitted list price — which
  // ignores promo/gift codes and shipping. COALESCE guards a missing value.
  const paidTotal = Number.isFinite(session.amount_total)
    ? '$' + (session.amount_total / 100).toFixed(2)
    : null;

  // ── 1. Persist what Stripe gave us and mark the order paid ───────────────
  let orderRow;
  try {
    const result = await db.query(
      `UPDATE pet_orders SET
         status                = 'paid',
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
         total                 = COALESCE($12, total),
         updated_at            = NOW()
       WHERE order_id = $13
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
        paidTotal,
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

  // ── 2. Finalise the order ────────────────────────────────────────────────
  // No deliverability gate: Stripe collected (and lightly validated) the
  // shipping address, and we ship exactly what the customer entered. Checkout
  // now uses automatic capture, so the payment is already captured by the time
  // this webhook fires — we just record the order as paid.
  //
  // The capture call below is a belt-and-braces no-op: it only does anything
  // for an in-flight manual-capture order created before this change. For
  // automatic-capture (or $0 freebie) PaymentIntents it errors harmlessly.
  if (paymentIntentId) {
    try {
      await stripe.paymentIntents.capture(paymentIntentId);
    } catch (err) {
      const msg = String(err?.message || err);
      if (!/already.*captured|status of succeeded|automatic/i.test(msg)) {
        console.error('paymentIntents.capture (non-fatal):', err);
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

  // ── Affiliate attribution (non-fatal) ──
  // Resolves the creator from an applied promo code or the cookie ref, records
  // the commission row, and back-fills pet_orders for admin visibility.
  let isFreebie = false;
  try {
    const attr = await attributeOrder(env, db, stripe, session, orderId);
    isFreebie = !!attr?.isFreebie;
  } catch (err) {
    console.error('Affiliate attribution failed (non-fatal):', err);
  }
  // Any $0 order (creator freebie OR a standalone gift code with no creator)
  // should read "Free" on the confirmation, not the client-submitted price.
  if (session.amount_total === 0) isFreebie = true;

  // ── Confirmation email (non-fatal) ──
  // For a 100%-off creator freebie, show "Free" rather than the client total.
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
      total:          isFreebie ? 'Free' : orderRow.total,
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


// ── Affiliate attribution ──────────────────────────────────────────────────
// attributeOrder / backfillOrderAttribution now live in _shared/affiliate.js so
// the success-page recovery (update-address) and the admin override
// (admin-api force_fulfill) can reuse the exact same logic. Imported above.



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
