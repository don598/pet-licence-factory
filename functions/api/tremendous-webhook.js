// ── Pet Licence Factory — Tremendous Webhook ────────────────────────────────
// POST /api/tremendous-webhook
//
// Tremendous calls this endpoint when reward orders/rewards change state.
// We use it to keep affiliate_payouts.external_status in sync — particularly
// to flip 'requested'/'processing' → 'delivered' once the recipient claims
// their gift card, or → 'failed' if delivery fails.
//
// Configure the endpoint URL + signing secret in Tremendous → Settings →
// API & Webhooks → Webhook Endpoints. Save the secret as
// TREMENDOUS_WEBHOOK_SECRET.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { verifyWebhookSignature, mapDeliveryStatus, getOrder } from '../_shared/tremendous.js';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const rawBody  = await request.text();
  const sig      = request.headers.get('Tremendous-Webhook-Signature') || '';

  let valid = false;
  try { valid = await verifyWebhookSignature(env, rawBody, sig); }
  catch (err) {
    console.error('Webhook signature verification error:', err);
    return json(500, { error: 'Signature verification failed' });
  }
  if (!valid) {
    return json(401, { error: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  // Tremendous wraps the actual event under `event` or sends it flat.
  // Normalize so we have a stable shape: { event, payload }.
  const eventName = event?.event || event?.type || event?.name || '';
  const payload   = event?.payload || event?.data || event;

  const db = getDb(env);

  try {
    // Pull the order id from wherever it lives in the payload.
    const orderId =
      payload?.order_id        ||
      payload?.order?.id       ||
      payload?.reward?.order_id||
      payload?.id              ||
      null;

    if (!orderId) {
      console.warn('Tremendous webhook with no order id:', eventName, payload);
      return json(200, { received: true, skipped: 'no order id' });
    }

    // Find the matching payout row by external_id.
    const row = await db.query(
      `SELECT id, external_status FROM affiliate_payouts WHERE external_id = $1 LIMIT 1`,
      [orderId]
    );
    if (row.rows.length === 0) {
      // Either pre-launch test events, or a race where the webhook fires
      // before the creator-payout function persisted the order id.
      console.warn(`No payout row for Tremendous order ${orderId} — event ${eventName}`);
      return json(200, { received: true, skipped: 'no matching payout' });
    }
    const payoutId = row.rows[0].id;

    // Resolve a status from the event. Some events include status inline;
    // otherwise we re-fetch the order to be sure.
    const inlineStatus = payload?.reward?.delivery?.status
                      || payload?.delivery?.status
                      || payload?.status;
    let mapped = inlineStatus ? mapDeliveryStatus(inlineStatus) : null;

    if (!mapped) {
      try {
        const fresh = await getOrder(env, orderId);
        const rewards = Array.isArray(fresh?.rewards) ? fresh.rewards : [];
        const status = rewards[0]?.delivery?.status || fresh?.status;
        mapped = mapDeliveryStatus(status);
      } catch (err) {
        console.error(`Could not refetch Tremendous order ${orderId}:`, err);
        return json(200, { received: true, skipped: 'fetch failed' });
      }
    }

    const failureReason = mapped === 'failed'
      ? (payload?.reward?.delivery?.error || payload?.error || `Tremendous event: ${eventName}`)
      : null;

    await db.query(
      `UPDATE affiliate_payouts
       SET external_status = $1,
           failure_reason  = COALESCE($2, failure_reason)
       WHERE id = $3`,
      [mapped, failureReason ? String(failureReason).slice(0, 500) : null, payoutId]
    );

    return json(200, {
      received: true,
      event:    eventName,
      payout_id: payoutId,
      external_status: mapped,
    });
  } catch (err) {
    console.error('Tremendous webhook handler error:', err);
    return json(500, { error: 'Webhook handler error' });
  }
}
