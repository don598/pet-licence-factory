// ── Pet Licence Factory — Order Status (Cloudflare Pages Function) ──────────
// GET /api/order-status?session_id=cs_xxx
//
// Public endpoint polled by success.html while the webhook is processing.
// Authorisation is the Stripe session id itself — these are long random
// strings (~60 chars) that are not enumerable, so anyone holding one is
// (effectively) the buyer who just came through Checkout.
//
// Returns the minimum data needed to render the success page:
//   { status, orderId, error?, address?, attemptsRemaining? }
//
// PII guard: address is only returned for orders in `address_invalid` /
// `address_pending_verification` (the customer needs it to fix the address).
// For paid/shipped/etc. orders we return only status + orderId.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';

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

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const url = new URL(request.url);
  const sessionId = (url.searchParams.get('session_id') || '').trim();

  // Stripe session ids look like `cs_test_...` or `cs_live_...` — guard
  // against junk before hitting the DB.
  if (!sessionId || !/^cs_[a-zA-Z0-9_]{20,}$/.test(sessionId)) {
    return json(400, { error: 'Invalid session_id' });
  }

  const db = getDb(env);

  let row;
  try {
    const result = await db.query(
      `SELECT order_id, status, verification_error, verification_attempts,
              ship_addr_line1, ship_addr_line2, ship_city, ship_state, ship_zip, ship_country
       FROM pet_orders
       WHERE stripe_session_id = $1
       LIMIT 1`,
      [sessionId]
    );
    row = result.rows[0];
  } catch (err) {
    console.error('order-status DB error:', err);
    return json(500, { error: 'Database error' });
  }

  if (!row) {
    // Webhook may not have fired yet — tell the client to keep polling.
    return json(200, { status: 'pending', orderId: null });
  }

  const base = {
    orderId: row.order_id,
    status:  row.status,
  };

  if (row.status === 'address_invalid' || row.status === 'address_pending_verification') {
    return json(200, {
      ...base,
      error: row.verification_error || null,
      attemptsRemaining: Math.max(0, MAX_ATTEMPTS - (row.verification_attempts || 0)),
      address: {
        line1:    row.ship_addr_line1 || '',
        line2:    row.ship_addr_line2 || '',
        city:     row.ship_city       || '',
        state:    row.ship_state      || '',
        zip:      row.ship_zip        || '',
        country:  row.ship_country    || 'US',
      },
    });
  }

  return json(200, base);
}
