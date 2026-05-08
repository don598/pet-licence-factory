// ── Pet Licence Factory — Stripe Connect webhook ────────────────────────────
// POST /api/connect-webhook
//
// Receives events for connected accounts (separate endpoint and signing
// secret from the main Stripe webhook). The most important ones:
//
//   account.updated     → flip stripe_connect_payouts_enabled when the
//                          account finishes verification.
//   transfer.paid       → mark the matching affiliate_payouts row as
//                          'delivered' (Stripe paid the connected account
//                          and the connected account's bank received it).
//   transfer.failed     → mark the row 'failed' so the balance is restored.
//   payout.paid/failed  → optional: subsequent ACH leg from connected
//                          account to creator's bank. Logged for observability.
//
// Configure the endpoint URL + signing secret in Stripe Dashboard →
// Developers → Webhooks → Add endpoint → "Events on Connected accounts".
// Save the signing secret as STRIPE_CONNECT_WEBHOOK_SECRET.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { constructConnectEvent } from '../_shared/stripe-connect.js';
import { syncAccountStatus } from './creator-connect-onboard.js';

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

  const rawBody = await request.text();
  const sig     = request.headers.get('stripe-signature') || '';

  let event;
  try {
    event = constructConnectEvent(env, rawBody, sig);
  } catch (err) {
    console.error('Connect webhook signature verification failed:', err);
    return json(400, { error: 'Invalid signature' });
  }

  const db = getDb(env);

  try {
    switch (event.type) {
      // Account verification + capability state changed.
      case 'account.updated': {
        const account = event.data?.object;
        if (!account?.id) return json(200, { received: true, skipped: 'no account id' });

        // Look up our creator by the connected account id.
        const r = await db.query(
          `SELECT id FROM affiliate_creators WHERE stripe_connect_account_id = $1 LIMIT 1`,
          [account.id]
        );
        if (r.rows.length === 0) {
          return json(200, { received: true, skipped: 'no matching creator' });
        }
        await syncAccountStatus(db, r.rows[0].id, account);
        return json(200, { received: true, account: account.id });
      }

      // Platform → connected account transfer succeeded. The funds are now
      // queued on Stripe to ACH out to the creator's bank (handled
      // separately by Stripe based on connected-account payout schedule).
      case 'transfer.paid': {
        const tx = event.data?.object;
        await markTransfer(db, tx?.id, 'delivered', null);
        return json(200, { received: true, transfer: tx?.id });
      }

      case 'transfer.failed': {
        const tx = event.data?.object;
        const reason = tx?.failure_message || tx?.failure_code || 'transfer.failed';
        await markTransfer(db, tx?.id, 'failed', reason);
        return json(200, { received: true, transfer: tx?.id, reason });
      }

      // Optional: log subsequent ACH leg events (connected-account → bank).
      // These don't change our balance math; the platform→connected leg
      // already determined success.
      case 'payout.paid':
      case 'payout.failed':
        return json(200, { received: true, type: event.type, skipped: 'not tracked' });

      default:
        return json(200, { received: true, type: event.type, skipped: 'unhandled' });
    }
  } catch (err) {
    console.error('Connect webhook handler error:', err);
    return json(500, { error: 'Webhook handler error' });
  }
}

async function markTransfer(db, transferId, status, reason) {
  if (!transferId) return;
  const r = await db.query(
    `UPDATE affiliate_payouts
     SET external_status = $1,
         failure_reason  = COALESCE($2, failure_reason)
     WHERE external_id = $3 AND method = 'stripe_connect'`,
    [status, reason ? String(reason).slice(0, 500) : null, transferId]
  );
  if (r.rowCount === 0) {
    console.warn(`No payout row for Stripe transfer ${transferId} (status=${status})`);
  }
}
