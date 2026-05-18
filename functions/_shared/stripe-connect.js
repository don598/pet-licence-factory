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
//
// We pre-fill `business_profile.url` with the creator's affiliate landing
// page on petlicensefactory.com. Stripe REQUIRES a website OR a product
// description from every connected account for KYC — affiliate creators
// rarely have their own websites (they sell on TikTok/IG), so without a
// pre-fill they get stuck asking "what should I put here?". Their affiliate
// page is a real merchant URL describing the products they promote, which
// is what Stripe actually wants.
export async function createExpressAccount(env, creator) {
  const stripe = stripeClient(env);
  const siteOrigin = env.URL || 'https://petlicensefactory.com';
  const affiliateUrl = `${siteOrigin}/?ref=${encodeURIComponent(creator.coupon_code)}`;

  const account = await stripe.accounts.create({
    type:    'express',
    country: 'US',
    email:   creator.email,
    capabilities: {
      transfers:    { requested: true },
    },
    business_type: 'individual',
    business_profile: {
      url:                  affiliateUrl,
      product_description:  'Affiliate / creator commission for promoting Pet Licence Factory products (custom printed pet licence card skins).',
      mcc:                  '5732', // "Electronics Stores" — closest match for printed novelty goods sold via affiliate marketing
    },
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

// Verify a Stripe Connect webhook signature. Uses the ASYNC variant because
// this runs on Cloudflare Workers, which provide Web Crypto (SubtleCrypto)
// but not Node's `crypto` module. The synchronous `constructEvent` fails on
// Workers; only `constructEventAsync` works. The main stripe-webhook.js
// already uses the async variant — this matches.
export async function constructConnectEvent(env, rawBody, sigHeader) {
  const stripe = stripeClient(env);
  if (!env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    const err = new Error('STRIPE_CONNECT_WEBHOOK_SECRET is not configured.');
    err.status = 500;
    throw err;
  }
  return stripe.webhooks.constructEventAsync(rawBody, sigHeader, env.STRIPE_CONNECT_WEBHOOK_SECRET);
}
