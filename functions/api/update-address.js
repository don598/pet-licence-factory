// ── Pet Licence Factory — Update Address (Cloudflare Pages Function) ────────
// POST /api/update-address
// Body: { session_id, line1, line2, city, state, zip, country }
//
// Public endpoint used by success.html when the customer fixes a bad address.
// Authorisation is the Stripe session id (long random string, not enumerable).
//
// Defence-in-depth (no Cloudflare-level rate limit on purpose — the user
// declined that for now):
//   1. session_id must match an existing order
//   2. order status must be address_invalid or address_pending_verification
//      (anything else returns 400 — caps abuse to in-flight orders only)
//   3. verification_attempts is capped at 5 — beyond that the order is
//      permanently locked and the auth is voided
//
// On success: re-verify via EasyPost → capture the Stripe auth → mark paid →
// fire confirmation email.
// ---------------------------------------------------------------------------

import Stripe from 'stripe';
import { getDb } from '../_shared/db.js';
import { verifyAddress } from '../_shared/easypost.js';
import { sendOrderConfirmationEmail } from '../_shared/email.js';

const MAX_ATTEMPTS = 5;

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

// Strip control chars, cap length — prevents log injection / SQL bloat
function clean(v, max = 200) {
  return String(v ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const sessionId = clean(body.session_id, 200);
  if (!sessionId || !/^cs_[a-zA-Z0-9_]{20,}$/.test(sessionId)) {
    return json(400, { error: 'Invalid session_id' });
  }

  const newAddress = {
    street1: clean(body.line1, 200),
    street2: clean(body.line2, 200),
    city:    clean(body.city,  100),
    state:   clean(body.state, 50),
    zip:     clean(body.zip,   20),
    country: clean(body.country, 2) || 'US',
  };

  if (!newAddress.street1 || !newAddress.city || !newAddress.state || !newAddress.zip) {
    return json(400, { error: 'Missing required address fields (street, city, state, ZIP).' });
  }

  const db = getDb(env);

  // ── Look up the order, enforce state machine + retry cap ────────────────
  let order;
  try {
    const result = await db.query(
      `SELECT id, order_id, status, verification_attempts, stripe_payment_intent,
              customer_email, customer_name, pet_first_name, pet_last_name,
              pack_count, add_on, chip_size, shipping_option, total
       FROM pet_orders WHERE stripe_session_id = $1 LIMIT 1`,
      [sessionId]
    );
    order = result.rows[0];
  } catch (err) {
    console.error('update-address DB lookup error:', err);
    return json(500, { error: 'Database error' });
  }

  if (!order) {
    return json(404, { error: 'Order not found.' });
  }

  if (order.status !== 'address_invalid' && order.status !== 'address_pending_verification') {
    return json(400, {
      error: `This order is no longer accepting address changes (status: ${order.status}).`,
      status: order.status,
    });
  }

  const attempts = order.verification_attempts || 0;
  if (attempts >= MAX_ATTEMPTS) {
    return json(400, {
      error: 'Too many verification attempts. Please email contact@creditcardart.com so we can sort this out manually.',
      attemptsRemaining: 0,
    });
  }

  // ── Verify via EasyPost ─────────────────────────────────────────────────
  let verification;
  try {
    verification = await verifyAddress(env, newAddress);
  } catch (err) {
    console.error('update-address verifyAddress hard-failed:', err);
    return json(503, { error: 'Address verification is temporarily unavailable. Please try again in a moment.' });
  }

  // ── Verification failed ─────────────────────────────────────────────────
  if (!verification.ok) {
    const newAttempts = attempts + 1;
    const exhausted   = newAttempts >= MAX_ATTEMPTS;
    const reason      = verification.error || 'USPS could not verify this address.';

    try {
      await db.query(
        `UPDATE pet_orders SET
           ship_addr_line1       = $1,
           ship_addr_line2       = $2,
           ship_city             = $3,
           ship_state            = $4,
           ship_zip              = $5,
           ship_country          = $6,
           verification_attempts = $7,
           verification_error    = $8,
           updated_at            = NOW()
         WHERE id = $9`,
        [newAddress.street1, newAddress.street2, newAddress.city, newAddress.state,
         newAddress.zip, newAddress.country, newAttempts, reason, order.id]
      );
    } catch (err) {
      console.error('Failed to record verification failure (non-fatal):', err);
    }

    // If retries are exhausted, void the Stripe auth so the customer is never
    // charged. Auths normally drop in ~7 days but voiding now is cleaner.
    if (exhausted && order.stripe_payment_intent) {
      try {
        const stripe = new Stripe(env.STRIPE_SECRET_KEY);
        await stripe.paymentIntents.cancel(order.stripe_payment_intent);
      } catch (err) {
        console.error('Failed to void Stripe auth (non-fatal):', err);
      }
    }

    return json(400, {
      error: reason,
      attemptsRemaining: Math.max(0, MAX_ATTEMPTS - newAttempts),
      locked: exhausted,
    });
  }

  // ── Verification passed — persist, capture, email ────────────────────────
  const normalized = verification.normalized;

  try {
    await db.query(
      `UPDATE pet_orders SET
         ship_addr_line1    = $1,
         ship_addr_line2    = $2,
         ship_city          = $3,
         ship_state         = $4,
         ship_zip           = $5,
         ship_country       = $6,
         status             = 'paid',
         verification_error = NULL,
         updated_at         = NOW()
       WHERE id = $7`,
      [normalized.street1, normalized.street2, normalized.city, normalized.state,
       normalized.zip, normalized.country, order.id]
    );
  } catch (err) {
    console.error('Failed to persist verified address:', err);
    return json(500, { error: 'Database error while saving the verified address.' });
  }

  // Capture the held Stripe auth.
  if (order.stripe_payment_intent) {
    try {
      const stripe = new Stripe(env.STRIPE_SECRET_KEY);
      await stripe.paymentIntents.capture(order.stripe_payment_intent);
    } catch (err) {
      const msg = String(err?.message || err);
      if (!/already.*captured/i.test(msg)) {
        console.error('Failed to capture Stripe auth after address fix:', err);
      }
    }
  }

  // Send the confirmation email (delayed-but-now-real).
  try {
    await sendOrderConfirmationEmail(env, {
      orderId:        order.order_id,
      customerEmail:  order.customer_email,
      customerName:   order.customer_name,
      petFirstName:   order.pet_first_name,
      petLastName:    order.pet_last_name,
      packCount:      order.pack_count,
      addOn:          order.add_on,
      chipSize:       order.chip_size,
      shippingOption: order.shipping_option,
      total:          order.total,
      shipAddrLine1:  normalized.street1,
      shipAddrLine2:  normalized.street2,
      shipCity:       normalized.city,
      shipState:      normalized.state,
      shipZip:        normalized.zip,
      shipCountry:    normalized.country,
    });
  } catch (err) {
    console.error('Confirmation email failed (non-fatal):', err);
  }

  return json(200, {
    ok: true,
    orderId: order.order_id,
    status: 'paid',
  });
}
