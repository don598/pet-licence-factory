// ── Pet Licence Factory — Order Submission (Cloudflare Pages Function) ──────
// POST /api/submit-order
// Body: { petFirstName, petLastName, dlNumber, dob, expDate, issDate,
//         addrLine1, addrLine2, sex, height, weight, eyeColor,
//         photo, packQty, chipSize, wantsDecal, total }
// Returns: { orderId }
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const db = getDb(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  // Generate order ID server-side
  const orderId = 'PLF-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

  // Validate photo size (750KB limit for base64 data URLs)
  const photoUrl = body.photo || null;
  if (photoUrl && photoUrl.length > 750 * 1024) {
    return json(400, { error: 'Photo too large. Please use a smaller image.' });
  }

  // Sanitize string fields (max 500 chars each)
  const s = (val, fallback) => (val || fallback || '').toString().slice(0, 500);

  try {
    await db.query(
      `INSERT INTO pet_orders (
        order_id, status, pet_first_name, pet_last_name, dl_number, dob, exp_date, iss_date,
        addr_line1, addr_line2, sex, height, weight, eyes, lic_class, restrict, signature,
        photo_url, pack_count, total, chip_size, add_on, pet_species
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16, $17,
        $18, $19, $20, $21, $22, $23
      )`,
      [
        orderId,
        'pending',
        s(body.petFirstName),
        s(body.petLastName),
        s(body.dlNumber),
        s(body.dob),
        s(body.expDate),
        s(body.issDate),
        s(body.addrLine1, '456 Woofington Drive'),
        s(body.addrLine2, 'Tailwag, TX 76543'),
        s(body.sex),
        s(body.height),
        s(body.weight),
        s(body.eyeColor),
        'A',
        'NONE',
        (s(body.petFirstName) + ' ' + s(body.petLastName)).trim(),
        photoUrl,
        parseInt(body.packQty) || 1,
        '$' + (parseFloat(body.total) || 0).toFixed(2),
        s(body.chipSize, 'mini'),
        body.wantsDecal ? 'car_decal' : null,
        s(body.species).toLowerCase() || null,
      ]
    );

    return json(200, { orderId });

  } catch (err) {
    console.error('Order submission error:', err);
    return json(500, { error: 'Failed to save order' });
  }
}
