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
      siteOrigin:    env.URL || 'https://pet-licence-factory.pages.dev',
    });
  } catch (emailErr) {
    console.error('Address-issue email failed (non-fatal):', emailErr);
  }

  return json(200, { received: true, status: 'address_invalid' });
}
