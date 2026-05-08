// ── Pet Licence Factory — Creator Cashout ───────────────────────────────────
// POST /api/creator-payout
// Body: { token, method, amountCents, recipientEmail? }
// Auth: creator dashboard_token (creator-facing, NOT admin JWT)
//
// Methods (Phase 2):
//   gift_card_tremendous — creates a Tremendous reward order
//
// Future methods (later phases):
//   store_credit         — generates a one-time Stripe promo, +10% bonus
//   stripe_connect       — direct deposit (requires onboarded Connect account)
//
// The flow:
//   1. Open a transaction; lock the creator row (FOR UPDATE).
//   2. Recompute available balance from orders + ledger − non-failed payouts.
//   3. Validate the requested amount against balance + per-method minimum.
//   4. Insert affiliate_payouts row with external_status='requested'.
//   5. Commit. (Lock released; balance is reserved.)
//   6. Call Tremendous outside the transaction. On failure, mark the row
//      external_status='failed' (which excludes it from "paid" → balance
//      becomes available again).
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { findCreatorByDashboardToken } from '../_shared/affiliate.js';
import { createRewardOrder, TremendousError } from '../_shared/tremendous.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PAYOUT_RULES = {
  gift_card_tremendous: { minCents: 1000 },  // $10 minimum
  // store_credit:      { minCents:    0 },  // Phase 3
  // stripe_connect:    { minCents: 2500 },  // Phase 4 ($25)
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

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const token = String(body.token || '').trim();
  if (!token) return json(401, { error: 'Missing token' });

  const method      = String(body.method || '').trim();
  const amountCents = Math.round(Number(body.amountCents));
  const rawEmail    = String(body.recipientEmail || '').trim();

  if (!PAYOUT_RULES[method]) {
    return json(400, { error: `Unsupported method: ${method}` });
  }
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return json(400, { error: 'amountCents must be a positive integer' });
  }
  const rule = PAYOUT_RULES[method];
  if (amountCents < rule.minCents) {
    return json(400, {
      error: `Minimum cashout for ${method} is $${(rule.minCents / 100).toFixed(2)}.`,
    });
  }

  const db = getDb(env);
  const creator = await findCreatorByDashboardToken(db, token);
  if (!creator) return json(401, { error: 'Invalid token' });

  const recipientEmail = rawEmail || creator.email;
  if (method === 'gift_card_tremendous' && !recipientEmail) {
    return json(400, { error: 'Recipient email required for gift card delivery' });
  }

  // ── Step 1–4: reserve balance atomically ──────────────────────────────
  let payoutRow;
  try {
    payoutRow = await db.withTransaction(async (client) => {
      // Lock the creator to serialize concurrent cashouts for this creator.
      const locked = await client.query(
        'SELECT id FROM affiliate_creators WHERE id = $1 FOR UPDATE',
        [creator.id]
      );
      if (locked.rows.length === 0) {
        const err = new Error('Creator not found');
        err.status = 404;
        throw err;
      }

      const balRes = await client.query(
        `SELECT
           COALESCE((SELECT SUM(commission_cents) FROM affiliate_orders
                     WHERE creator_id = $1 AND is_freebie = FALSE AND commission_zeroed = FALSE), 0)::bigint
         + COALESCE((SELECT SUM(amount_cents) FROM creator_balance_ledger
                     WHERE creator_id = $1), 0)::bigint
         - COALESCE((SELECT SUM(amount_cents) FROM affiliate_payouts
                     WHERE creator_id = $1
                       AND external_status IS DISTINCT FROM 'failed'), 0)::bigint
           AS available`,
        [creator.id]
      );
      const available = Number(balRes.rows[0]?.available || 0);

      if (amountCents > available) {
        const err = new Error(`Insufficient balance. Available: $${(available / 100).toFixed(2)}.`);
        err.status = 400;
        err.code   = 'INSUFFICIENT_BALANCE';
        err.available_cents = available;
        throw err;
      }

      // Insert payout row reserving the funds. external_id stays NULL until
      // Tremendous returns a reward order id. external_status='requested'
      // already counts toward "paid" so the balance is reserved on commit.
      const ins = await client.query(
        `INSERT INTO affiliate_payouts
           (creator_id, amount_cents, method, paid_at, notes,
            external_status, recipient_email)
         VALUES ($1, $2, $3, NOW(), $4, 'requested', $5)
         RETURNING *`,
        [
          creator.id,
          amountCents,
          method,
          `Cashout requested by creator (${method}).`,
          recipientEmail,
        ]
      );
      return ins.rows[0];
    });
  } catch (err) {
    if (err?.status) return json(err.status, { error: err.message, code: err.code, available_cents: err.available_cents });
    console.error('Payout reservation failed:', err);
    return json(500, { error: 'Could not reserve payout' });
  }

  // ── Step 5–6: external call after commit ──────────────────────────────
  if (method === 'gift_card_tremendous') {
    try {
      const externalId = `plf-payout-${payoutRow.id}-${Date.now()}`;
      const order = await createRewardOrder(env, {
        amountCents,
        recipientName:  creator.name,
        recipientEmail,
        externalId,
        message: `Thanks for promoting Pet Licence Factory! Your $${(amountCents / 100).toFixed(2)} reward.`,
      });

      const orderId = order?.id || null;
      // Tremendous orders may transition to EXECUTED immediately or sit in
      // PENDING_APPROVAL. The webhook handler will reconcile final state.
      const initialStatus = order?.status === 'EXECUTED' ? 'processing' : 'requested';

      await db.query(
        `UPDATE affiliate_payouts
         SET external_id = $1, external_status = $2
         WHERE id = $3`,
        [orderId, initialStatus, payoutRow.id]
      );

      return json(200, {
        success:        true,
        payout_id:      payoutRow.id,
        method,
        amount_cents:   amountCents,
        recipient_email: recipientEmail,
        external_id:    orderId,
        external_status: initialStatus,
      });
    } catch (err) {
      const reason = err instanceof TremendousError ? err.message : (err?.message || 'Tremendous call failed');
      // Mark the reservation failed so the balance is restored.
      try {
        await db.query(
          `UPDATE affiliate_payouts
           SET external_status = 'failed', failure_reason = $1
           WHERE id = $2`,
          [String(reason).slice(0, 500), payoutRow.id]
        );
      } catch (markErr) {
        console.error('Failed to mark payout failed:', markErr);
      }
      console.error('Tremendous order failed:', err);
      return json(502, { error: `Could not send gift card: ${reason}` });
    }
  }

  // Unreachable today — PAYOUT_RULES gate above prevents other methods.
  return json(500, { error: 'Method handler not implemented' });
}
