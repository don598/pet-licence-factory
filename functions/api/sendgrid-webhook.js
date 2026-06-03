// ── Pet Licence Factory — SendGrid Event Webhook (Cloudflare Pages Function) ─
// POST /api/sendgrid-webhook?token=<SENDGRID_WEBHOOK_TOKEN>
//
// SendGrid POSTs a JSON array of delivery events (processed/delivered/open/
// click/bounce/dropped/spamreport/deferred). We store each one in email_events
// and refresh a denormalised summary on the matching pet_orders row, joined via
// the `order_id` custom_arg we attach in _shared/email.js.
//
// Auth: a shared secret in the query string (SendGrid lets you append params to
// the webhook URL). The payload is non-sensitive delivery metadata; the token
// gates writes. Set SENDGRID_WEBHOOK_TOKEN in Cloudflare env to a long random
// string and use the same value in the SendGrid webhook URL.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Recompute the pet_orders email summary for one order from its events.
// Idempotent — derives everything from email_events, so out-of-order or
// retried webhook deliveries always converge to the same result.
async function refreshOrderSummary(db, orderId) {
  await db.query(
    `UPDATE pet_orders p SET
        email_opens = COALESCE(
          (SELECT count(*) FROM email_events e
            WHERE e.order_id = p.order_id AND e.event = 'open'), 0),
        email_status = sub.event,
        email_status_at = sub.occurred_at,
        email_last_type = sub.email_type,
        email_bounce_reason = (
          SELECT e.reason FROM email_events e
           WHERE e.order_id = p.order_id
             AND e.event IN ('bounce','dropped','spamreport')
             AND e.reason IS NOT NULL
           ORDER BY e.occurred_at DESC NULLS LAST, e.id DESC LIMIT 1)
      FROM (
        SELECT event, occurred_at, email_type FROM email_events
         WHERE order_id = $1
         ORDER BY occurred_at DESC NULLS LAST, id DESC LIMIT 1
      ) sub
     WHERE p.order_id = $1`,
    [orderId]
  );
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // ── Shared-secret auth ──
  const expected = env.SENDGRID_WEBHOOK_TOKEN;
  if (!expected) {
    console.error('[sg-webhook] SENDGRID_WEBHOOK_TOKEN not set — refusing');
    return json(500, { error: 'Webhook not configured' });
  }
  const token = new URL(request.url).searchParams.get('token');
  if (token !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }

  let events;
  try {
    events = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (!Array.isArray(events)) {
    return json(400, { error: 'Expected an array of events' });
  }

  const db = getDb(env);
  const touchedOrders = new Set();
  let stored = 0;

  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const orderId = e.order_id || null;            // custom_arg echoed back
    const emailType = e.email_type || null;        // custom_arg echoed back
    const reason = e.reason || e.response || null; // bounce/drop/defer detail
    const occurredAt = Number.isFinite(e.timestamp) ? e.timestamp : null;

    try {
      await db.query(
        `INSERT INTO email_events
           (order_id, email, event, email_type, reason, sg_message_id, sg_event_id, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::bigint IS NULL THEN NULL ELSE to_timestamp($8::bigint) END)
         ON CONFLICT (sg_event_id) DO NOTHING`,
        [
          orderId,
          e.email || null,
          e.event || 'unknown',
          emailType,
          reason,
          e.sg_message_id || null,
          e.sg_event_id || null,
          occurredAt,
        ]
      );
      stored++;
      if (orderId) touchedOrders.add(orderId);
    } catch (err) {
      // Never fail the whole batch on one bad event — SendGrid would retry the
      // entire payload and duplicate work. Log and move on.
      console.error('[sg-webhook] insert failed (non-fatal):', err?.message || err);
    }
  }

  for (const orderId of touchedOrders) {
    try {
      await refreshOrderSummary(db, orderId);
    } catch (err) {
      console.error('[sg-webhook] summary refresh failed (non-fatal):', orderId, err?.message || err);
    }
  }

  return json(200, { received: events.length, stored, orders: touchedOrders.size });
}
