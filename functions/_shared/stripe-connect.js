// ── Pet Licence Factory — Stripe Connect Express helpers ────────────────────
// Thin wrappers around Stripe's Connect API for Express accounts. Used to
// onboard creators for direct-deposit cash payouts ($25+ tier) and to push
// money to them via stripe.transfers.create.
//
// Express accounts: Stripe-hosted onboarding, Stripe owns the dashboard,
// Stripe issues 1099-NECs to creators automatically. We just need to:
//   1. Create the account.
//   2. Send the creator to a Stripe-hosted onboarding URL (account link).
//   3. Wait for `account.updated` to flip payouts_enabled = true.
//   4. Once enabled, transfer funds into the connected account; Stripe
//      handles the ACH payout to the creator's bank.
// ---------------------------------------------------------------------------

import Stripe from 'stripe';

function stripeClient(env) {
  if (!env.STRIPE_SECRET_KEY) {
    const err = new Error('STRIPE_SECRET_KEY is not configured.');
    err.status = 500;
    throw err;
  }
  return new Stripe(env.STRIPE_SECRET_KEY);
}

// Create an Express account for a creator. Stripe collects identity, bank
// details, and tax info during the hosted onboarding step (next call).
export async function createExpressAccount(env, creator) {
  const stripe = stripeClient(env);
  const account = await stripe.accounts.create({
    type:    'express',
    country: 'US',
    email:   creator.email,
    capabilities: {
      transfers:    { requested: true },
    },
    business_type: 'individual',
    metadata: {
      plf_creator_id:   String(creator.id),
      plf_coupon_code:  creator.coupon_code,
    },
  });
  return account;
}

// Generate a one-time onboarding URL the creator clicks through. Stripe's
// hosted form collects everything needed for verification + payouts.
//   refreshUrl: where Stripe redirects if the link expires mid-flow
//   returnUrl:  where Stripe redirects on completion (success or otherwise)
export async function createOnboardingLink(env, accountId, { refreshUrl, returnUrl }) {
  const stripe = stripeClient(env);
  const link = await stripe.accountLinks.create({
    account:     accountId,
    refresh_url: refreshUrl,
    return_url:  returnUrl,
    type:        'account_onboarding',
  });
  return link;
}

// Re-fetch the connected account so we can sync verification state.
export async function getAccount(env, accountId) {
  const stripe = stripeClient(env);
  return stripe.accounts.retrieve(accountId);
}

// Push funds from the platform balance to the connected account. Stripe then
// runs its own ACH payout from there to the creator's bank.
//   amountCents:   integer cents
//   accountId:     destination connected account
//   transferGroup: optional grouping label for reconciliation
//   metadata:      arbitrary key/value pairs (we set plf_payout_id)
export async function createTransfer(env, { amountCents, accountId, transferGroup, metadata }) {
  const stripe = stripeClient(env);
  const tx = await stripe.transfers.create({
    amount:         amountCents,
    currency:       'usd',
    destination:    accountId,
    transfer_group: transferGroup || undefined,
    metadata:       metadata || {},
  });
  return tx;
}

// Determine whether an account is ready to receive transfers. Stripe sets
// payouts_enabled and charges_enabled once verification clears. We require
// both so the funds will actually land in the creator's bank rather than
// piling up on the connected account.
export function isAccountReady(account) {
  if (!account) return false;
  return Boolean(account.payouts_enabled) && Boolean(account.charges_enabled);
}

// Verify a Stripe Connect webhook signature. This uses the existing Stripe
// SDK helper (different secret from the main Stripe webhook — Connect events
// go to a separate endpoint).
export function constructConnectEvent(env, rawBody, sigHeader) {
  const stripe = stripeClient(env);
  if (!env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    const err = new Error('STRIPE_CONNECT_WEBHOOK_SECRET is not configured.');
    err.status = 500;
    throw err;
  }
  return stripe.webhooks.constructEvent(rawBody, sigHeader, env.STRIPE_CONNECT_WEBHOOK_SECRET);
}
