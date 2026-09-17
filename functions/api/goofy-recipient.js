// ── Goofy Licenses — Recipient Lookup (Cloudflare Pages Function) ───────────
// GET /api/goofy-recipient?o=GOOFY-1234567890-AB12
//
// Public endpoint for QR-scan personalization: a licence-card QR carries its
// order id (?src=license-qr&o=GOOFY-...) so the landing page can greet the
// recipient by name ("Congratulations, Greg!").
//
// Authorisation is the order id itself — timestamp + random suffix, not
// enumerable (same philosophy as order-status's session_id). Returns ONLY
// the recipient name of a goofy-brand row; never addresses, emails, or PLC
// rows. Cache disabled.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';

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
  const orderId = (url.searchParams.get('o') || '').trim();

  // GOOFY-<epoch-ms>-<4 base36 upper>. Reject junk before hitting the DB.
  if (!orderId || !/^GOOFY-\d{10,16}-[A-Z0-9]{4}$/i.test(orderId)) {
    return json(400, { error: 'Invalid order id' });
  }

  const db = getDb(env);

  let row;
  try {
    const result = await db.query(
      `SELECT recipient_name
       FROM pet_orders
       WHERE order_id = $1 AND brand = 'goofy'
       LIMIT 1`,
      [orderId]
    );
    row = result.rows[0];
  } catch (err) {
    console.error('goofy-recipient DB error:', err);
    return json(500, { error: 'Database error' });
  }

  if (!row || !row.recipient_name) {
    return json(200, { name: null });
  }

  return json(200, { name: String(row.recipient_name).slice(0, 40) });
}
