// ── Pet Licence Factory — Order Submission (Cloudflare Pages Function) ──────
// POST /api/submit-order
// Body: { petFirstName, petLastName, dlNumber, dob, expDate, issDate,
//         addrLine1, addrLine2, sex, height, weight, eyeColor,
//         photo, packQty, chipSize, wantsDecal, total }
// Returns: { orderId }
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { GOOFY_PRICES, plcFormat, plcItem } from '../_shared/pricing.js';
import { lineOfBrand } from '../_shared/lines.js';

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

  // Opportunistic cleanup: prune abandoned-cart shells that never reached
  // Stripe checkout. We create the order row before redirecting to Stripe so
  // we have an order_id to hand to checkout; if the customer never pays, the
  // row sits as `pending` forever. Stripe Checkout sessions themselves expire
  // after 24 h, so anything still `pending` with no payment after a few days
  // is definitively abandoned. Window is generous to leave room for slow
  // customers returning to finish checkout via a re-issued link.
  //
  // Fire-and-forget — never block (or fail) order submission on cleanup.
  const ABANDONED_PENDING_TTL = "72 hours";
  try {
    const r = await db.query(
      `DELETE FROM pet_orders
        WHERE status = 'pending'
          AND stripe_payment_id IS NULL
          AND created_at < NOW() - INTERVAL '${ABANDONED_PENDING_TTL}'`
    );
    if (r.rowCount) {
      console.log(`submit-order: pruned ${r.rowCount} abandoned-cart shell(s) older than ${ABANDONED_PENDING_TTL}.`);
    }
  } catch (cleanupErr) {
    console.warn('submit-order: abandoned-cart cleanup failed (non-fatal):', cleanupErr);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  // ── Dual-brand columns (additive; PLC rows default to 'plc') ─────────────
  // Lazy, idempotent DDL — same self-heal pattern used elsewhere
  // (stripe-webhook recovery_email_sent_at). Fire-and-forget: a DDL failure
  // must never block order submission. (The PLC INSERT below writes
  // `variant` too, for the pet format: skin | card | bundle. Every column
  // here already exists in production.)
  try {
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS brand TEXT DEFAULT 'plc'`);
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS src TEXT`);
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS variant TEXT`);
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS recipient_name TEXT`);
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS giver_name TEXT`);
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS batch_id TEXT`);
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS self_nominate BOOLEAN DEFAULT FALSE`);
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS photo_crop TEXT`);
  } catch (ddlErr) {
    console.warn('submit-order: brand-column DDL failed (non-fatal):', ddlErr);
  }

  // Brand gate: ONLY the G.O.A.T. line ('goat', or the legacy 'goofy' the
  // builder still sends) takes the Goofy path. Everything else (including
  // missing) is PLC, unchanged. Stored as the line id: 'goat'.
  const brand = body.brand && lineOfBrand(body.brand) === 'goat' ? 'goat' : 'plc';

  // Generate order ID server-side (brand-prefixed so the two are
  // distinguishable at a glance in the dashboard and inboxes).
  const orderId = (brand === 'goat' ? 'GOOFY-' : 'PLF-') + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

  // Validate photo size (750KB limit for base64 data URLs)
  const photoUrl = body.photo || null;
  if (photoUrl && photoUrl.length > 750 * 1024) {
    return json(400, { error: 'Photo too large. Please use a smaller image.' });
  }

  // Sanitize string fields (max 500 chars each)
  const s = (val, fallback) => (val || fallback || '').toString().slice(0, 500);

  // ── Goofy Licenses nomination path (new; PLC block below untouched) ──────
  // Multi-nominee: one shipment, same variant + address. The client sends
  // recipients[] (one entry per kit); each becomes its own row sharing a
  // batch_id so the webhook/fulfilment can treat them as one checkout.
  // Legacy single shape {recipientName, photo} is wrapped automatically.
  if (brand === 'goat') {
    const GOOFY_VARIANTS = ['standard', 'custom-giver', 'custom-anon'];
    const variant = GOOFY_VARIANTS.includes(body.variant) ? body.variant : 'standard';
    const isCustom = variant !== 'standard';
    const giverName = variant === 'custom-giver' ? s(body.giverName) : '';
    const street = s(body.addrStreet);
    const city = s(body.addrCity);
    const addrState = s(body.addrState);
    const addrZip = s(body.addrZip);
    const addrUnit = s(body.addrLine2);
    const cityLine = [city, addrState, addrZip].filter(Boolean).join(' ').replace(/^(.+) ([A-Z]{2}) (.+)$/, '$1, $2 $3');

    let recips = Array.isArray(body.recipients) && body.recipients.length
      ? body.recipients
      : [{ name: body.recipientName, photo: body.photo }];
    // Cap the headcount so one checkout can't bloat the table or the body.
    // crop: the builder's { cx, cy, zoom } for the photo box, kept (clamped)
    // so Command Station re-prints frame the photo as the customer did.
    const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
    recips = recips.slice(0, 5).map((r) => ({
      name: s(r && r.name),
      photo: (r && r.photo) || null,
      crop: r && r.photo && r.crop && typeof r.crop === 'object'
        ? JSON.stringify({ cx: num(r.crop.cx, 0, 1, 0.5), cy: num(r.crop.cy, 0, 1, 0.5), zoom: num(r.crop.zoom, 0.2, 8, 1) })
        : null,
    }));

    // Mandatory address collection: every nomination is a new lead.
    if (!street || !city || !addrState || !addrZip) {
      return json(400, { error: 'Complete recipient mailing address is required.' });
    }
    if (variant === 'custom-giver' && !giverName) {
      return json(400, { error: 'Giver name is required for a with-giver nomination.' });
    }
    for (const r of recips) {
      if (!r.name) return json(400, { error: 'Every nominee needs a name.' });
      if (r.photo && r.photo.length > 750 * 1024) {
        return json(400, { error: 'A photo is too large. Please use smaller images.' });
      }
      if (isCustom && !r.photo) {
        return json(400, { error: 'Photo is required for every Custom nominee.' });
      }
    }

    // Server-side per-kit fee (never trust the client total).
    const kitFee = '$' + ((isCustom ? GOOFY_PRICES.custom : GOOFY_PRICES.standard) / 100).toFixed(2);
    const selfNom = body.selfNominate === true;
    const stamp = () => 'GOOFY-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

    try {
      const orderIds = [];
      for (const r of recips) {
        const oid = stamp();
        orderIds.push(oid);
      }
      const batchId = orderIds[0];
      for (let i = 0; i < recips.length; i++) {
        const r = recips[i];
        await db.query(
          `INSERT INTO pet_orders (
            order_id, status, brand, src, variant, recipient_name, giver_name, batch_id, self_nominate,
            pet_first_name, pet_last_name, dl_number, dob, exp_date, iss_date,
            addr_line1, addr_line2, sex, height, weight, eyes, lic_class, restrict, signature,
            photo_url, pack_count, total, chip_size, add_on, pet_species, photo_crop
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19, $20, $21, $22, $23, $24,
            $25, $26, $27, $28, $29, $30, $31
          )`,
          [
            orderIds[i],
            'pending',
            'goat',
            s(body.src),
            variant,
            r.name,
            giverName,
            batchId,
            selfNom,
            r.name,
            '',
            'GOAT-0001',
            '', '', '',
            street,
            addrUnit ? `${addrUnit}, ${cityLine}` : cityLine,
            '', '', '', '',
            'G',
            'NONE',
            r.name,
            r.photo,
            1,
            kitFee,
            null,
            null,
            'goat',
            r.crop,
          ]
        );
      }

      return json(200, { orderId: orderIds[0], orderIds });
    } catch (err) {
      console.error('Goofy nomination submission error:', err);
      return json(500, { error: 'Failed to save nomination' });
    }
  }

  try {
    await db.query(
      `INSERT INTO pet_orders (
        order_id, status, pet_first_name, pet_last_name, dl_number, dob, exp_date, iss_date,
        addr_line1, addr_line2, sex, height, weight, eyes, lic_class, restrict, signature,
        photo_url, pack_count, total, chip_size, add_on, pet_species, variant
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16, $17,
        $18, $19, $20, $21, $22, $23, $24
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
        'ALL',
        (s(body.petFirstName) + ' ' + s(body.petLastName)).trim(),
        photoUrl,
        plcItem(body.format, body.packQty).packQty,
        '$' + (parseFloat(body.total) || 0).toFixed(2),
        s(body.chipSize, 'mini'),
        body.wantsDecal ? 'car_decal' : null,
        s(body.species).toLowerCase() || null,
        plcFormat(body.format),                 // skin | card | bundle
      ]
    );

    return json(200, { orderId });

  } catch (err) {
    console.error('Order submission error:', err);
    return json(500, { error: 'Failed to save order' });
  }
}
