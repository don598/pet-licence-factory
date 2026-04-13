'use strict';
// ── Pet Licence Factory — Stripe Webhook Handler ───────────────────────────
// POST /.netlify/functions/stripe-webhook
// Handles: checkout.session.completed
//   → Updates order with payment status, email, shipping address
// ---------------------------------------------------------------------------
// IMPORTANT: Set STRIPE_WEBHOOK_SECRET in your Netlify environment variables.
//   In Stripe Dashboard → Developers → Webhooks → Add endpoint:
//   URL: https://YOUR_SITE.netlify.app/.netlify/functions/stripe-webhook
//   Events: checkout.session.completed
// ---------------------------------------------------------------------------

const Stripe = require('stripe');
const db     = require('./db');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const stripe         = new Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;
  const sig            = event.headers['stripe-signature'];

  // ── Verify Stripe webhook signature (mandatory) ──────────────────────────
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not set — refusing to process unverified webhook');
    return { statusCode: 500, body: 'Server configuration error: webhook secret not set' };
  }

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // ── Handle checkout.session.completed ────────────────────────────────────
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const orderId = session.metadata?.order_id;

    if (!orderId) {
      console.warn('No order_id in session metadata — skipping DB update');
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
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
      return { statusCode: 500, body: 'Database update failed' };
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ received: true }),
  };
};
