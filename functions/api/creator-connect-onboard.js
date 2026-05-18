// ── Pet Licence Factory — Stripe Connect Express onboarding ─────────────────
// POST /api/creator-connect-onboard
// Body: { token, action? }   action: 'start' (default) | 'refresh' | 'status'
// Auth: creator dashboard_token (creator-facing)
//
// Flow:
//   action='start'   → create the Express account if one doesn't exist yet,
//                      then return a Stripe-hosted onboarding URL.
//   action='refresh' → regenerate the onboarding URL for an existing account
//                      (used when a previous link expired).
//   action='status'  → re-fetch the account from Stripe and sync our DB
//                      (called when the creator returns from onboarding so
//                      payouts_enabled flips immediately, without waiting
//                      for the account.updated webhook).
//
// Response: { url, account_id, payouts_enabled, charges_enabled, requirements }
//
// The actual gating ($25 minimum to use this rail) is enforced in
// /api/creator-payout — onboarding can happen at any balance.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { findCreatorByDashboardToken } from '../_shared/affiliate.js';
import {
  createExpressAccount,
  createOnboardingLink,
  getAccount,
  isAccountReady,
} from '../_shared/stripe-connect.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

  const token  = String(body.token || '').trim();
  if (!token) return json(401, { error: 'Missing token' });
  const action = String(body.action || 'start').trim();

  const db      = getDb(env);
  const creator = await findCreatorByDashboardToken(db, token);
  if (!creator) return json(401, { error: 'Invalid token' });

  const siteOrigin  = env.URL || 'https://petlicensefactory.com';
  // Always append the creator's dashboard token to the return/refresh URLs
  // so the creator can be authenticated when Stripe redirects them back —
  // critical when onboarding is opened in a new tab (no sessionStorage).
  // Env-var overrides set the base URL; the token is appended on top.
  const baseRefreshUrl = env.STRIPE_CONNECT_REFRESH_URL || `${siteOrigin}/dashboard.html?connect=refresh`;
  const baseReturnUrl  = env.STRIPE_CONNECT_RETURN_URL  || `${siteOrigin}/dashboard.html?connect=ok`;
  const refreshUrl     = appendQueryParam(baseRefreshUrl, 'token', token);
  const returnUrl      = appendQueryParam(baseReturnUrl,  'token', token);

  try {
    let accountId = creator.stripe_connect_account_id;

    // ── status: just re-fetch and sync (no link generation) ──
    if (action === 'status') {
      if (!accountId) {
        return json(200, {
          account_id: null,
          payouts_enabled: false,
          charges_enabled: false,
          ready: false,
        });
      }
      const account = await getAccount(env, accountId);
      await syncAccountStatus(db, creator.id, account);
      return json(200, {
        account_id:      account.id,
        payouts_enabled: !!account.payouts_enabled,
        charges_enabled: !!account.charges_enabled,
        requirements:    account.requirements || {},
        ready:           isAccountReady(account),
      });
    }

    // ── start / refresh: ensure account, then build a fresh link ──
    if (!accountId) {
      const account = await createExpressAccount(env, creator);
      accountId = account.id;
      await db.query(
        `UPDATE affiliate_creators
         SET stripe_connect_account_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [accountId, creator.id]
      );
    }

    const link = await createOnboardingLink(env, accountId, { refreshUrl, returnUrl });

    // Sync current state so the response reflects what Stripe knows right now
    // (e.g., for refresh after partial completion).
    let payoutsEnabled = false, chargesEnabled = false, requirements = {};
    try {
      const fresh = await getAccount(env, accountId);
      payoutsEnabled = !!fresh.payouts_enabled;
      chargesEnabled = !!fresh.charges_enabled;
      requirements   = fresh.requirements || {};
      await syncAccountStatus(db, creator.id, fresh);
    } catch (err) {
      console.warn('Account refetch failed (non-fatal):', err);
    }

    return json(200, {
      url:             link.url,
      account_id:      accountId,
      payouts_enabled: payoutsEnabled,
      charges_enabled: chargesEnabled,
      requirements,
      ready:           payoutsEnabled && chargesEnabled,
    });
  } catch (err) {
    if (err?.status) return json(err.status, { error: err.message });
    console.error('Connect onboarding error:', err);
    return json(500, { error: err.message || 'Onboarding failed' });
  }
}

// Persist Stripe Connect status flags onto affiliate_creators. Used both
// here (after the creator returns) and in the connect-webhook handler.
// Also snapshots `requirements` and `disabled_reason` so the dashboard can
// tell the creator what's still needed without a live Stripe API call.
export async function syncAccountStatus(db, creatorId, account) {
  const enabled = !!account?.payouts_enabled && !!account?.charges_enabled;
  const requirements = account?.requirements ? JSON.stringify({
    currently_due:   account.requirements.currently_due   || [],
    past_due:        account.requirements.past_due        || [],
    eventually_due:  account.requirements.eventually_due  || [],
    errors:          account.requirements.errors          || [],
    pending_verification: account.requirements.pending_verification || [],
    current_deadline:     account.requirements.current_deadline     || null,
  }) : null;
  const disabledReason = account?.requirements?.disabled_reason || null;

  await db.query(
    `UPDATE affiliate_creators
     SET stripe_connect_payouts_enabled = $1,
         stripe_connect_onboarded_at    = COALESCE(
           CASE WHEN $1 THEN COALESCE(stripe_connect_onboarded_at, NOW()) ELSE stripe_connect_onboarded_at END,
           stripe_connect_onboarded_at
         ),
         stripe_connect_requirements    = $3::jsonb,
         stripe_connect_disabled_reason = $4,
         updated_at = NOW()
     WHERE id = $2`,
    [enabled, creatorId, requirements, disabledReason]
  );
}

// Stamp a query string param onto a URL, preserving anything that's already
// there (including hash fragments). Used for the Stripe return/refresh URLs
// so we can attach the creator dashboard token without clobbering admin
// overrides set via env vars.
function appendQueryParam(url, key, value) {
  try {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    // Fallback for unparseable strings: best-effort string concat.
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}
