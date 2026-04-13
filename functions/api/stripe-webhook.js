// ── Pet Licence Factory — Stripe Webhook (Cloudflare Pages Function) ────────
// POST /api/stripe-webhook
// Handles: checkout.session.completed
//   → Updates order with payment status, email, shipping address
// ---------------------------------------------------------------------------

import Stripe from 'stripe';
import { getDb } from '../_shared/db.js';

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

  // ── Verify Stripe webhook signature (mandatory) ──────────────────────────
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
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // ── Handle checkout.session.completed ────────────────────────────────────
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const orderId = session.metadata?.order_id;

    if (!orderId) {
      console.warn('No order_id in session metadata — skipping DB update');
      return json(200, { received: true });
    }

    // ── Determine which shipping option was selected ──────────────────────
    let shippingOption = 'stamp';
    try {
      if (session.shipping_cost?.shipping_rate) {
        const rate = await stripe.shippingRates.retrieve(session.shipping_cost.shipping_rate);
        const name = (rate.display_name || '').toLowerCase();
        if      (name.includes('priority')) shippingOption = 'priority';
        else if (name.includes('standard')) shippingOption = 'standard';
        else                                shippingOption = 'stamp';
      }
    } catch (e) {
      console.warn('Could not retrieve shipping rate:', e.message);
    }

    // ── Extract customer and address data ─────────────────────────────────
    const addr         = session.shipping_details?.address   || {};
    const email        = session.customer_details?.email     || '';
    const customerName = session.customer_details?.name      || '';

    try {
      await db.query(
        `UPDATE pet_orders SET
           status = $1, stripe_payment_id = $2, customer_email = $3, customer_name = $4,
           ship_addr_line1 = $5, ship_addr_line2 = $6, ship_city = $7, ship_state = $8,
           ship_zip = $9, ship_country = $10, shipping_option = $11, updated_at = NOW()
         WHERE order_id = $12`,
        [
          'paid',
          session.payment_intent || session.id,
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
      console.log(`Order ${orderId} marked as paid — customer: ${email}`);
    } catch (err) {
      console.error('Database update error:', err);
      return new Response('Database update failed', { status: 500 });
    }
  }

  return json(200, { received: true });
}
