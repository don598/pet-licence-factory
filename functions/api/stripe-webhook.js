// ── Pet Licence Factory — Stripe Webhook (Cloudflare Pages Function) ────────
// POST /api/stripe-webhook
// Handles: checkout.session.completed
//   → Updates order with payment status, email, shipping address
// ---------------------------------------------------------------------------

import Stripe from 'stripe';
import { getDb } from '../_shared/db.js';
import { sendOrderConfirmationEmail } from '../_shared/email.js';

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
    stripeEvent = await stripe.webhooks.constructEventAsync(rawBody, sig, webhookSecret);
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
    // Match by amount instead of calling stripe.shippingRates.retrieve() —
    // saves a Stripe API subrequest (Cloudflare Workers free plan has a 10ms
    // CPU ceiling that TLS handshakes eat into quickly).
    // Prices must match PRICES in create-checkout-session.js.
    let shippingOption = 'stamp';
    const shipAmt = session.shipping_cost?.amount_total
                 ?? session.shipping_cost?.amount_subtotal
                 ?? 0;
    if      (shipAmt >= 700) shippingOption = 'priority';   // $7.99
    else if (shipAmt >= 300) shippingOption = 'standard';   // $3.99
    else                     shippingOption = 'stamp';      // $0.95 or unknown

    // ── Extract customer and address data ─────────────────────────────────
    // Handle both the legacy `session.shipping_details` and the newer
    // `session.collected_information.shipping_details` path — Stripe is in
    // the middle of that migration depending on API version.
    const ship         = session.shipping_details
                      || session.collected_information?.shipping_details
                      || {};
    const addr         = ship.address || {};
    const email        = session.customer_details?.email     || '';
    const customerName = session.customer_details?.name      || ship.name || '';

    console.log('[webhook] session.completed', {
      orderId,
      shipAmt, shippingOption,
      hasShipping: !!ship,
      hasAddr:     !!addr?.line1,
      email,
    });

    try {
      const result = await db.query(
        `UPDATE pet_orders SET
           status = $1, stripe_payment_id = $2, customer_email = $3, customer_name = $4,
           ship_addr_line1 = $5, ship_addr_line2 = $6, ship_city = $7, ship_state = $8,
           ship_zip = $9, ship_country = $10, shipping_option = $11, updated_at = NOW()
         WHERE order_id = $12
         RETURNING order_id, pet_first_name, pet_last_name, pack_count, add_on, chip_size,
                   shipping_option, total, customer_email, customer_name,
                   ship_addr_line1, ship_addr_line2, ship_city, ship_state, ship_zip, ship_country`,
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

      // Fire confirmation email for non-stamp orders only.
      // Stamp mail orders are emailed when the admin prints/processes them.
      const row = result.rows[0];
      if (row && row.shipping_option !== 'stamp') {
        try {
          await sendOrderConfirmationEmail(env, {
            orderId:        row.order_id,
            customerEmail:  row.customer_email,
            customerName:   row.customer_name,
            petFirstName:   row.pet_first_name,
            petLastName:    row.pet_last_name,
            packCount:      row.pack_count,
            addOn:          row.add_on,
            chipSize:       row.chip_size,
            shippingOption: row.shipping_option,
            total:          row.total,
            shipAddrLine1:  row.ship_addr_line1,
            shipAddrLine2:  row.ship_addr_line2,
            shipCity:       row.ship_city,
            shipState:      row.ship_state,
            shipZip:        row.ship_zip,
            shipCountry:    row.ship_country,
          });
        } catch (emailErr) {
          console.error('Confirmation email failed (non-fatal):', emailErr);
        }
      }
    } catch (err) {
      console.error('Database update error:', err);
      return new Response('Database update failed', { status: 500 });
    }
  }

  return json(200, { received: true });
}
