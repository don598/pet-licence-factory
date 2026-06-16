// ── Pet License Factory — Creator Cashout ───────────────────────────────────
// POST /api/creator-payout
// Body: { token, method, amountCents, recipientEmail? }
// Auth: creator dashboard_token (creator-facing, NOT admin JWT)
//
// Methods:
//   gift_card_manual — reserves the balance and queues a fulfillment task for
//                      the admin. Admin manually buys an Amazon/Visa/etc. gift
//                      card, then pastes the code in via the admin dashboard,
//                      which sends the delivery email and flips the payout to
//                      `delivered`.
//   store_credit     — generates a one-time Stripe promo, +10% bonus
//   stripe_connect   — direct deposit (requires onboarded Connect account)
//
// Why manual: Tremendous denied production API access and Tango Card RaaS
// requires a separate sales-approved tier we don't have yet. At our launch
// volume (sub-$200/creator), manual fulfillment costs ~10min per request and
// avoids the third-party compliance dependency. See commits c580323 (the
// original Tremendous-backed path) for what to restore if a provider approves
// us later — most of that handler is gone now but the schema columns
// (external_id, external_status, recipient_email) are still in use.
//
// The flow:
//   1. Open a transaction; lock the creator row (FOR UPDATE).
//   2. Recompute available balance from orders + ledger − non-failed payouts.
//   3. Validate the requested amount against balance + per-method minimum.
//   4. Insert affiliate_payouts row with external_status='requested'.
//   5. Commit. (Lock released; balance is reserved.)
//   6. Dispatch to the per-method handler. For gift_card_manual: flip the row
//      to 'pending_manual' and email the admin so they can fulfill it. For
//      store_credit and stripe_connect: call Stripe (which is the external
//      rail). On any failure, mark the row external_status='failed' (excluded
//      from "paid" → balance becomes available again).
// ---------------------------------------------------------------------------

import Stripe from 'stripe';
import { getDb } from '../_shared/db.js';
import { findCreatorByDashboardToken } from '../_shared/affiliate.js';
import { createTransfer, getAccount, isAccountReady } from '../_shared/stripe-connect.js';
import { syncAccountStatus } from './creator-connect-onboard.js';
import { sendEmail, esc } from '../_shared/email.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PAYOUT_RULES = {
  gift_card_manual:     { minCents: 1000 },   // $10 minimum — admin fulfills manually
  store_credit:         { minCents:    0 },   // any amount, +10% bonus when redeemed
  stripe_connect:       { minCents: 2500 },   // $25 minimum (direct deposit)
};

const STORE_CREDIT_BONUS_RATE = 0.10;          // +10% bonus on top of cashout amount
const STORE_CREDIT_EXPIRY_DAYS = 90;

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
  if (method === 'gift_card_manual' && !recipientEmail) {
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
      // the per-method handler fills it in (Stripe transfer id, promo id, or
      // null for manual gift cards). external_status='requested' already
      // counts toward "paid" so the balance is reserved on commit.
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
  const siteOrigin = env.URL || 'https://petlicensefactory.com';
  try {
    if (method === 'gift_card_manual') {
      return await handleGiftCardManual({
        env, db, creator, payoutRow, amountCents, recipientEmail,
      });
    }
    if (method === 'store_credit') {
      return await handleStoreCredit({
        env, db, creator, payoutRow, amountCents, recipientEmail, siteOrigin,
      });
    }
    if (method === 'stripe_connect') {
      return await handleStripeConnect({
        env, db, creator, payoutRow, amountCents,
      });
    }
    // Unreachable — PAYOUT_RULES gate above prevents other methods.
    await markPayoutFailed(db, payoutRow.id, 'Method handler not implemented');
    return json(500, { error: 'Method handler not implemented' });
  } catch (err) {
    console.error('Payout dispatch failed:', err);
    await markPayoutFailed(db, payoutRow.id, err?.message || 'Unknown error');
    return json(500, { error: 'Payout failed' });
  }
}

// ── Per-method handlers ─────────────────────────────────────────────────────

// Manual gift card flow:
//   1. Mark the reserved payout row as `pending_manual` so it shows up in the
//      admin Fulfillment queue. (Balance was already reserved in the txn above
//      — pending_manual is NOT excluded from the "paid" sum, so the creator's
//      balance is held until either delivery or failure.)
//   2. Email the creator a "request received" confirmation.
//   3. Email the admin a "new request pending" notification. Non-fatal — the
//      row also appears in the admin dashboard so the admin will see it on
//      their next visit.
//   The admin completes fulfillment in command-station: they buy the gift
//   card externally, then click "Fulfill" on the row, paste the code, and the
//   `fulfill_gift_card` admin action flips the row to `delivered` and emails
//   the creator the code.
async function handleGiftCardManual({ env, db, creator, payoutRow, amountCents, recipientEmail }) {
  const amountUsd = (amountCents / 100).toFixed(2);

  await db.query(
    `UPDATE affiliate_payouts
     SET external_status = 'pending_manual',
         recipient_email = $1,
         notes           = $2
     WHERE id = $3`,
    [
      recipientEmail,
      `Manual gift card fulfillment requested. Recipient: ${recipientEmail}. Awaiting admin to purchase + send code.`,
      payoutRow.id,
    ]
  );

  // Creator confirmation (non-fatal).
  try {
    await sendEmail(env, {
      to: recipientEmail,
      subject: `Your $${amountUsd} gift card request was received`,
      html: renderGiftCardRequestEmail({
        creatorName: creator.name,
        amountUsd,
        recipientEmail,
      }),
    });
  } catch (mailErr) {
    console.error('Gift card request email to creator failed (non-fatal):', mailErr);
  }

  // Admin notification (non-fatal).
  try {
    const adminEmail = env.ADMIN_NOTIFICATION_EMAIL
      || env.SENDGRID_FROM_EMAIL
      || 'contact@creditcardart.com';
    await sendEmail(env, {
      to: adminEmail,
      subject: `[PLF] New gift card request: ${creator.name} — $${amountUsd}`,
      html: renderAdminGiftCardNotice({
        creatorName:  creator.name,
        creatorEmail: creator.email,
        amountUsd,
        recipientEmail,
        payoutId:     payoutRow.id,
      }),
    });
  } catch (mailErr) {
    console.error('Admin gift card notification failed (non-fatal):', mailErr);
  }

  return json(200, {
    success:         true,
    payout_id:       payoutRow.id,
    method:          'gift_card_manual',
    amount_cents:    amountCents,
    recipient_email: recipientEmail,
    external_status: 'pending_manual',
  });
}

async function handleStoreCredit({ env, db, creator, payoutRow, amountCents, recipientEmail, siteOrigin }) {
  // Bonus: the redemption code is worth +10% on top of the cashout amount.
  const bonusCents      = Math.round(amountCents * STORE_CREDIT_BONUS_RATE);
  const redemptionCents = amountCents + bonusCents;
  const expiresAt       = Math.floor(Date.now() / 1000) + STORE_CREDIT_EXPIRY_DAYS * 24 * 60 * 60;
  const code            = generateCreditCode();

  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);

    const coupon = await stripe.coupons.create({
      amount_off: redemptionCents,
      currency:   'usd',
      duration:   'once',
      name:       `PLF Credit ($${(amountCents / 100).toFixed(2)} + 10% bonus)`,
      metadata: {
        kind:        'store_credit',
        creator_id:  String(creator.id),
        payout_id:   String(payoutRow.id),
        base_cents:  String(amountCents),
        bonus_cents: String(bonusCents),
      },
    });

    const promo = await stripe.promotionCodes.create({
      coupon:          coupon.id,
      code,
      max_redemptions: 1,
      expires_at:      expiresAt,
      active:          true,
      metadata: {
        kind:       'store_credit',
        creator_id: String(creator.id),
        payout_id:  String(payoutRow.id),
      },
    });

    // Mark delivered immediately — the code is live and emailed; we treat
    // delivery as complete the moment Stripe accepts it. Actual redemption
    // is a separate event tracked by Stripe usage stats.
    await db.query(
      `UPDATE affiliate_payouts
       SET external_id      = $1,
           external_status  = 'delivered',
           redemption_code  = $2,
           recipient_email  = $3,
           notes            = $4
       WHERE id = $5`,
      [
        promo.id,
        code,
        recipientEmail,
        `Store credit code ${code} ($${(redemptionCents / 100).toFixed(2)} value, expires ${new Date(expiresAt * 1000).toISOString().slice(0, 10)}).`,
        payoutRow.id,
      ]
    );

    // Email the creator the code. Non-fatal if SendGrid hiccups — the code
    // is also visible on the dashboard payout history.
    try {
      const link = `${siteOrigin}/game.html?promo=${encodeURIComponent(code)}`;
      const subject = `Your $${(redemptionCents / 100).toFixed(2)} Pet License Factory credit (code ${code})`;
      const html = renderStoreCreditEmail({
        creatorName:    creator.name,
        baseCents:      amountCents,
        bonusCents,
        redemptionCents,
        code,
        link,
        expiresAt,
      });
      await sendEmail(env, { to: recipientEmail, subject, html });
    } catch (mailErr) {
      console.error('Store credit email failed (non-fatal):', mailErr);
    }

    return json(200, {
      success:          true,
      payout_id:        payoutRow.id,
      method:           'store_credit',
      amount_cents:     amountCents,
      bonus_cents:      bonusCents,
      redemption_cents: redemptionCents,
      redemption_code:  code,
      redemption_url:   `${siteOrigin}/game.html?promo=${encodeURIComponent(code)}`,
      expires_at:       new Date(expiresAt * 1000).toISOString(),
      recipient_email:  recipientEmail,
      external_status:  'delivered',
    });
  } catch (err) {
    const reason = err?.message || 'Stripe coupon creation failed';
    await markPayoutFailed(db, payoutRow.id, reason);
    console.error('Store credit creation failed:', err);
    return json(502, { error: `Could not generate store credit: ${reason}` });
  }
}

async function handleStripeConnect({ env, db, creator, payoutRow, amountCents }) {
  // Gating: must have an onboarded Connect account that Stripe has marked
  // ready for transfers. We re-fetch the account in case the cached flag
  // is stale (e.g., a webhook hasn't landed yet).
  if (!creator.stripe_connect_account_id) {
    await markPayoutFailed(db, payoutRow.id, 'No Stripe Connect account on file.');
    return json(400, {
      error: 'Direct deposit requires connecting a Stripe account first.',
      code:  'CONNECT_NOT_ONBOARDED',
    });
  }

  let account;
  try {
    account = await getAccount(env, creator.stripe_connect_account_id);
    await syncAccountStatus(db, creator.id, account);
  } catch (err) {
    await markPayoutFailed(db, payoutRow.id, err?.message || 'Account fetch failed');
    return json(502, { error: 'Could not verify Stripe Connect account.' });
  }
  if (!isAccountReady(account)) {
    await markPayoutFailed(db, payoutRow.id, 'Stripe Connect account not ready (verification pending).');
    return json(400, {
      error: 'Your Stripe account is still being verified. Try again once Stripe finishes the review.',
      code:  'CONNECT_NOT_READY',
      requirements: account.requirements || {},
    });
  }

  try {
    const transfer = await createTransfer(env, {
      amountCents,
      accountId:     account.id,
      transferGroup: `plf-payout-${payoutRow.id}`,
      metadata: {
        plf_payout_id:  String(payoutRow.id),
        plf_creator_id: String(creator.id),
        plf_coupon:     creator.coupon_code,
      },
    });

    await db.query(
      `UPDATE affiliate_payouts
       SET external_id     = $1,
           external_status = 'processing',
           recipient_email = $2,
           notes           = $3
       WHERE id = $4`,
      [
        transfer.id,
        creator.email,
        `Stripe Connect transfer ${transfer.id} → ${account.id}.`,
        payoutRow.id,
      ]
    );

    return json(200, {
      success:         true,
      payout_id:       payoutRow.id,
      method:          'stripe_connect',
      amount_cents:    amountCents,
      external_id:     transfer.id,
      external_status: 'processing',
      account_id:      account.id,
    });
  } catch (err) {
    const reason = err?.raw?.message || err?.message || 'Stripe transfer failed';
    await markPayoutFailed(db, payoutRow.id, reason);
    console.error('Stripe Connect transfer failed:', err);
    return json(502, { error: `Could not transfer funds: ${reason}` });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function markPayoutFailed(db, payoutId, reason) {
  try {
    await db.query(
      `UPDATE affiliate_payouts
       SET external_status = 'failed', failure_reason = $1
       WHERE id = $2`,
      [String(reason).slice(0, 500), payoutId]
    );
  } catch (err) {
    console.error('Failed to mark payout failed:', err);
  }
}

// 8 chars from an unambiguous alphabet → 30^8 ≈ 6.5e11 codes. Collisions in
// practice are negligible; if Stripe rejects on duplicate we'd surface the
// error and the caller can retry.
function generateCreditCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRTUVWXY346789';
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += alphabet[buf[i] % alphabet.length];
  return `PLFCR-${suffix}`;
}

// Sent to the creator the moment they submit a manual-gift-card request, so
// they know we got it and roughly when to expect the code.
function renderGiftCardRequestEmail({ creatorName, amountUsd, recipientEmail }) {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#f6f6f8;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e7e7ee;">
    <h1 style="margin:0 0 8px;font-size:22px;color:#1a1a1f;">Gift card request received</h1>
    <p style="margin:0 0 16px;color:#444;">Hi ${esc(creatorName || 'Creator')} — we got your request for a <b>$${esc(amountUsd)}</b> gift card. We'll email the code to <b>${esc(recipientEmail)}</b> within one business day.</p>
    <p style="margin:0 0 16px;color:#444;">You'll be able to pick from Amazon, Visa Prepaid, Target, and most other major brands when you redeem the code.</p>
    <p style="margin:0;color:#888;font-size:13px;">Questions? Just reply to this email.</p>
  </div>
</body></html>`;
}

// Sent to the admin on every new manual-gift-card request so they don't have
// to poll the dashboard. The body is intentionally short — the dashboard has
// the rest of the context.
function renderAdminGiftCardNotice({ creatorName, creatorEmail, amountUsd, recipientEmail, payoutId }) {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#f6f6f8;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #e7e7ee;">
    <h1 style="margin:0 0 12px;font-size:18px;color:#1a1a1f;">New gift card request</h1>
    <table style="border-collapse:collapse;font-size:14px;color:#222;">
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Creator</td><td><b>${esc(creatorName)}</b> &lt;${esc(creatorEmail)}&gt;</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Amount</td><td><b>$${esc(amountUsd)}</b></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Deliver to</td><td>${esc(recipientEmail)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;">Payout #</td><td>${esc(String(payoutId))}</td></tr>
    </table>
    <p style="margin:16px 0 0;color:#444;font-size:13px;">Open the creator's drawer in command-station, scroll to Payout history, and click <b>Fulfill</b> on the pending row to enter the gift card code.</p>
  </div>
</body></html>`;
}

function renderStoreCreditEmail({ creatorName, baseCents, bonusCents, redemptionCents, code, link, expiresAt }) {
  const baseUsd      = (baseCents / 100).toFixed(2);
  const bonusUsd     = (bonusCents / 100).toFixed(2);
  const redeemUsd    = (redemptionCents / 100).toFixed(2);
  const expiresHuman = new Date(expiresAt * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#f6f6f8;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e7e7ee;">
    <h1 style="margin:0 0 8px;font-size:22px;color:#1a1a1f;">Your PLF credit is ready</h1>
    <p style="margin:0 0 16px;color:#444;">Hi ${esc(creatorName || 'Creator')} — you cashed out $${esc(baseUsd)} as Pet License Factory store credit. We added a 10% bonus on top, so your code is worth <b>$${esc(redeemUsd)}</b> when you check out.</p>
    <div style="background:#fff8e1;border:2px dashed #f6c343;border-radius:10px;padding:18px;text-align:center;margin:20px 0;">
      <div style="font-family:monospace;font-size:24px;letter-spacing:2px;font-weight:bold;color:#1a1a1f;">${esc(code)}</div>
      <div style="font-size:13px;color:#777;margin-top:6px;">$${esc(baseUsd)} cashout + $${esc(bonusUsd)} bonus = $${esc(redeemUsd)} redeemable</div>
    </div>
    <p style="margin:0 0 16px;color:#444;">Tap the button below to start a new license with the credit pre-applied:</p>
    <p style="text-align:center;margin:0 0 24px;">
      <a href="${esc(link)}" style="display:inline-block;background:#ff6b6b;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Use my credit →</a>
    </p>
    <p style="margin:0;color:#888;font-size:13px;">Single-use code, expires ${esc(expiresHuman)}. If your order is smaller than the credit value, the unused portion is forfeited — so cash out an amount that matches what you plan to buy.</p>
  </div>
</body></html>`;
}
