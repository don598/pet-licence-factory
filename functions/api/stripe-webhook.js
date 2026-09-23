// ── Pet Licence Factory — Stripe Webhook (Cloudflare Pages Function) ────────
// POST /api/stripe-webhook
// Handles: checkout.session.completed, checkout.session.expired, charge.refunded
//   Stripe Checkout uses automatic capture, so the card is charged on checkout.
//   We record the order as paid, attribute any affiliate, ship the address
//   Stripe collected, and send the confirmation email. There is NO USPS/
//   deliverability gate — we ship exactly what the customer entered.
//   checkout.session.expired = abandoned checkout: back-fill any captured
//   email onto the pending order and send a one-time recovery nudge.
// ---------------------------------------------------------------------------

import Stripe from 'stripe';
import { getDb } from '../_shared/db.js';
import { sendOrderConfirmationEmail, sendCheckoutRecoveryEmail, sendGoofyConfirmationEmail, sendGoofyRecoveryEmail } from '../_shared/email.js';
import { attributeOrder } from '../_shared/affiliate.js';
import { lineOfBrand } from '../_shared/lines.js';

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

  // ── Abandoned-checkout recovery (session expired unpaid) ─────────────────
  if (stripeEvent.type === 'checkout.session.expired') {
    return handleSessionExpired(stripeEvent.data.object, db, env);
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

  // ── Dual-brand columns (additive; PLC rows default to 'plc') ─────────────
  // Lazy, idempotent DDL. Non-fatal: the main order UPDATE below doesn't
  // touch these columns (brand persistence happens in a separate best-effort
  // UPDATE), so PLC fulfilment is unaffected even if DDL fails.
  try {
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS brand TEXT DEFAULT 'plc'`);
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS src TEXT`);
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS variant TEXT`);
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS recipient_name TEXT`);
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS giver_name TEXT`);
  } catch (ddlErr) {
    console.warn('webhook: brand-column DDL failed (non-fatal):', ddlErr);
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
  // G.O.A.T. checkouts don't collect a shipping address (the builder already
  // has the nominee's); create-checkout-session puts it in metadata instead.
  const md           = session.metadata || {};
  const addr         = ship.address?.line1 ? ship.address
                     : md.ship_line1 ? { line1: md.ship_line1, line2: md.ship_line2 || '', city: md.ship_city || '',
                                         state: md.ship_state || '', postal_code: md.ship_zip || '', country: 'US' }
                     : {};
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

  // Idempotency: Stripe delivers webhooks at least once, so a re-delivered
  // checkout.session.completed must not re-send the confirmation email or re-run
  // affiliate attribution. Capture the order status BEFORE we flip it; if it was
  // already paid (or further along), those one-time side effects already ran.
  let wasAlreadyPaid = false;
  try {
    const prevRes = await db.query(`SELECT status FROM pet_orders WHERE order_id = $1`, [orderId]);
    wasAlreadyPaid = ['paid', 'processed', 'shipped', 'complete'].includes((prevRes.rows[0]?.status || '').trim());
  } catch (err) {
    console.error('Prior-status read failed (treating as new):', err);
  }

  // ── 1. Persist what Stripe gave us and mark the order paid ───────────────
  // Batch note: a Goofy multi-nominee checkout carries its sibling row ids
  // in metadata.order_ids. The extras ride along in $14 (empty for every
  // PLC order, so the PLC path matches exactly one row, as before).
  const isGoatSession = lineOfBrand(session.metadata?.brand) === 'goat';
  const batchExtraIds = (isGoatSession && session.metadata?.order_ids
    ? String(session.metadata.order_ids).split(',')
    : []).map((s) => s.trim()).filter((s) => /^GOOFY-/i.test(s) && s !== orderId).slice(0, 4);
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
       WHERE order_id = $13 OR order_id = ANY($14::text[])
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
        batchExtraIds,
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

  // ── Brand persistence (separate best-effort UPDATE; main UPDATE above is
  // byte-identical to the PLC flow). submit-order already stored these, but
  // the webhook re-asserts from session metadata (the Stripe-side source of
  // truth, incl. the ?src= QR tracker). COALESCE/NULLIF keep existing values
  // whenever metadata is empty (e.g. legacy in-flight PLC sessions).
  try {
    await db.query(
      `UPDATE pet_orders SET
         brand          = COALESCE(NULLIF($1, ''), brand, 'plc'),
         src            = COALESCE(NULLIF($2, ''), src),
         variant        = COALESCE(NULLIF($3, ''), variant),
         recipient_name = COALESCE(NULLIF($4, ''), recipient_name),
         giver_name     = COALESCE(NULLIF($5, ''), giver_name),
         updated_at     = NOW()
       WHERE order_id = $6`,
      [
        isGoatSession ? 'goat' : '',
        (session.metadata?.src || '').slice(0, 120),
        (session.metadata?.variant || '').slice(0, 40),
        (session.metadata?.recipient_name || '').slice(0, 100),
        (session.metadata?.giver_name || '').slice(0, 100),
        orderId,
      ]
    );
  } catch (brandErr) {
    console.error('Brand persist failed (non-fatal):', brandErr);
  }

  // Re-delivered webhook: the order was already paid before this event, so the
  // capture, affiliate attribution, and confirmation email already ran. Stop
  // here so none of them fire twice. (Re-applying the UPDATE above is harmless.)
  if (wasAlreadyPaid) {
    return json(200, { received: true, status: 'already_processed' });
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
  // Brand branch: Goofy nominators get the Council template — never PLC
  // pet-license copy. Brand comes from session metadata (always present on
  // new sessions); the PLC call below is unchanged.
  // For a 100%-off creator freebie, show "Free" rather than the client total.
  try {
    if (isGoatSession) {
      await sendGoofyConfirmationEmail(env, {
        orderId:        orderRow.order_id,
        customerEmail:  orderRow.customer_email,
        customerName:   orderRow.customer_name,
        recipientName:  session.metadata?.recipient_name || orderRow.pet_first_name,
        giverName:      session.metadata?.giver_name || '',
        variant:        session.metadata?.variant || '',
        recipientCount: parseInt(session.metadata?.recipient_count) || batchExtraIds.length + 1 || 1,
        shippingOption: orderRow.shipping_option,
        total:          orderRow.total,
        shipAddrLine1:  orderRow.ship_addr_line1,
        shipAddrLine2:  orderRow.ship_addr_line2,
        shipCity:       orderRow.ship_city,
        shipState:      orderRow.ship_state,
        shipZip:        orderRow.ship_zip,
        shipCountry:    orderRow.ship_country,
      });
    } else {
    await sendOrderConfirmationEmail(env, {
      orderId:        orderRow.order_id,
      customerEmail:  orderRow.customer_email,
      customerName:   orderRow.customer_name,
      petFirstName:   orderRow.pet_first_name,
      petLastName:    orderRow.pet_last_name,
      packCount:      orderRow.pack_count,
      format:         session.metadata?.variant || '',
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
    }
  } catch (emailErr) {
    console.error('Confirmation email failed (non-fatal):', emailErr);
  }

  return json(200, { received: true, status: 'paid' });
}


// ── Affiliate attribution ──────────────────────────────────────────────────
// attributeOrder / backfillOrderAttribution now live in _shared/affiliate.js so
// the success-page recovery (update-address) and the admin override
// (admin-api force_fulfill) can reuse the exact same logic. Imported above.



// ── Abandoned-checkout recovery ────────────────────────────────────────────
// checkout.session.expired fires when a session created with after_expiration
// recovery expires unpaid (create-checkout-session.js sets expires_at to 2h).
// If Stripe captured an email before the customer bailed, back-fill it onto
// the pending pet_orders row and send a one-time finish-your-order nudge with
// Stripe's 30-day recovery URL. The recovery_email_sent_at column is claimed
// atomically BEFORE sending so at-least-once webhook delivery can never
// double-email (same mark-then-send philosophy as send-abandonment.js).
async function handleSessionExpired(session, db, env) {
  const orderId     = session.metadata?.order_id;
  const email       = session.customer_details?.email || '';
  const recoveryUrl = session.after_expiration?.recovery?.url || '';

  // Nothing to recover without an order, an email, or a link. $0 sessions are
  // creator welcome freebies with their own onboarding flow — never nudge.
  if (!orderId || !email || !recoveryUrl || session.amount_total === 0) {
    return json(200, { received: true, recovery: 'skipped' });
  }

  // Lazy, idempotent schema self-heal (matches the plf_leads pattern).
  try {
    await db.query(`ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS recovery_email_sent_at TIMESTAMPTZ`);
  } catch (err) {
    console.error('recovery: ensure column failed:', err && err.message);
    return json(200, { received: true, recovery: 'schema_error' });
  }

  let claimed;
  try {
    const r = await db.query(
      `UPDATE pet_orders SET
         customer_email         = COALESCE(NULLIF(customer_email, ''), $1),
         recovery_email_sent_at = NOW(),
         updated_at             = NOW()
       WHERE order_id = $2
         AND status = 'pending'
         AND recovery_email_sent_at IS NULL
       RETURNING order_id, pet_first_name`,
      [email, orderId]
    );
    claimed = r.rows[0];
  } catch (err) {
    console.error('recovery: claim update failed:', err && err.message);
    return json(200, { received: true, recovery: 'db_error' });
  }

  // Already nudged, already paid, or unknown order — nothing more to do.
  if (!claimed) {
    return json(200, { received: true, recovery: 'not_eligible' });
  }

  try {
    // Brand lookup (best-effort, separate SELECT so the claim UPDATE above
    // stays byte-identical: if the brand columns don't exist yet this throws,
    // is caught, and the order is treated as PLC — PLC behaviour preserved).
    let goofyRecipient = null;
    try {
      const b = await db.query(
        `SELECT brand, recipient_name FROM pet_orders WHERE order_id = $1 LIMIT 1`,
        [orderId]
      );
      if (lineOfBrand(b.rows[0]?.brand) === 'goat') {
        goofyRecipient = b.rows[0]?.recipient_name || claimed.pet_first_name || '';
      }
    } catch (brandErr) {
      console.warn('recovery: brand lookup failed (treating as PLC, non-fatal):', brandErr && brandErr.message);
    }
    if (goofyRecipient !== null) {
      await sendGoofyRecoveryEmail(env, {
        to: email,
        recipientName: goofyRecipient,
        recoveryUrl,
        orderId,
      });
    } else {
    await sendCheckoutRecoveryEmail(env, {
      to: email,
      petName: claimed.pet_first_name,
      recoveryUrl,
      orderId,
    });
    }
    console.log('[webhook] session.expired — recovery email sent', { orderId, email });
  } catch (err) {
    // Row is already marked; better to occasionally lose one nudge than to
    // retry-storm a customer on webhook redelivery.
    console.error('recovery: send failed (marked anyway):', err && err.message);
  }

  return json(200, { received: true, recovery: 'sent' });
}

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
