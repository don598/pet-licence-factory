// ── Pet Licence Factory — Tremendous API client ─────────────────────────────
// Thin wrapper around the Tremendous v2 API for sending gift-card rewards
// (Amazon, Visa Prepaid, PayPal cash, etc.) to creators as commission payouts.
//
// Sandbox base: https://testflight.tremendous.com   (TEST_ keys)
// Production:   https://www.tremendous.com           (PROD_ keys)
//
// Auth: Bearer <TREMENDOUS_API_KEY>
//
// Recipient choice is configured via a Tremendous campaign (whitelist of
// reward brands). Set TREMENDOUS_CAMPAIGN_ID in env after creating one in
// the Tremendous dashboard.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = 'https://testflight.tremendous.com';

export class TremendousError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name   = 'TremendousError';
    this.status = status;
    this.body   = body;
  }
}

function tremendousConfig(env) {
  const apiKey = env.TREMENDOUS_API_KEY;
  if (!apiKey) {
    throw new TremendousError('TREMENDOUS_API_KEY is not configured.', { status: 500 });
  }
  return {
    apiKey,
    base:        env.TREMENDOUS_API_BASE        || DEFAULT_BASE,
    campaignId:  env.TREMENDOUS_CAMPAIGN_ID     || null,
    fundingId:   env.TREMENDOUS_FUNDING_SOURCE_ID || null,
  };
}

async function tremendousFetch(env, method, path, body) {
  const cfg = tremendousConfig(env);
  const res = await fetch(`${cfg.base}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let parsed = null;
  try { parsed = await res.json(); } catch {}

  if (!res.ok) {
    const message = parsed?.errors?.message
      || parsed?.error
      || `Tremendous ${method} ${path} failed (${res.status})`;
    throw new TremendousError(message, { status: res.status, body: parsed });
  }
  return parsed;
}

// ── Public API ──────────────────────────────────────────────────────────────

// Create a reward order. The recipient gets an email from Tremendous with a
// link to pick their reward (within the campaign whitelist).
//
// args:
//   amountCents     — integer cents
//   recipientName   — display name
//   recipientEmail  — delivery target
//   externalId      — our id for idempotency (e.g. a unique payout ref)
//   message         — optional note shown to the recipient
//   delivery        — 'EMAIL' (default) | 'LINK' (return claim URL only)
//
// Returns the parsed Tremendous order object. On success the order id is
// available at the top level of the returned data.
export async function createRewardOrder(env, args) {
  const cfg = tremendousConfig(env);
  const {
    amountCents,
    recipientName,
    recipientEmail,
    externalId,
    message      = 'Thanks for promoting Pet Licence Factory!',
    delivery     = 'EMAIL',
  } = args;

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new TremendousError('amountCents must be a positive integer', { status: 400 });
  }
  if (!cfg.campaignId) {
    throw new TremendousError(
      'TREMENDOUS_CAMPAIGN_ID is not configured. Create a campaign in the Tremendous dashboard and set the env var.',
      { status: 500 }
    );
  }
  if (delivery === 'EMAIL' && !recipientEmail) {
    throw new TremendousError('recipientEmail required for EMAIL delivery', { status: 400 });
  }

  const denomination = (amountCents / 100).toFixed(2);

  const payload = {
    external_id: externalId,
    payment: cfg.fundingId ? { funding_source_id: cfg.fundingId } : { funding_source_id: 'BALANCE' },
    reward: {
      campaign_id: cfg.campaignId,
      value: { denomination: Number(denomination), currency_code: 'USD' },
      delivery: { method: delivery },
      recipient: {
        name:  recipientName  || 'Creator',
        email: recipientEmail || undefined,
      },
      custom_fields: [],
    },
  };
  if (message) payload.reward.message = message;

  const data = await tremendousFetch(env, 'POST', '/api/v2/orders', payload);
  return data?.order || data;
}

// Look up an order by id (used for status polling / fallback if a webhook
// is missed).
export async function getOrder(env, orderId) {
  if (!orderId) throw new TremendousError('orderId required', { status: 400 });
  const data = await tremendousFetch(env, 'GET', `/api/v2/orders/${encodeURIComponent(orderId)}`);
  return data?.order || data;
}

// Verify a Tremendous webhook signature.
// Tremendous signs request bodies with HMAC-SHA256 using the webhook secret;
// the hex digest is sent in the `Tremendous-Webhook-Signature` header.
export async function verifyWebhookSignature(env, rawBody, headerSig) {
  const secret = env.TREMENDOUS_WEBHOOK_SECRET;
  if (!secret) throw new TremendousError('TREMENDOUS_WEBHOOK_SECRET not configured', { status: 500 });
  if (!headerSig) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const expected = [...new Uint8Array(sigBuf)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time compare
  if (expected.length !== headerSig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ headerSig.charCodeAt(i);
  }
  return diff === 0;
}

// Map a Tremendous reward delivery status onto our internal external_status
// vocabulary used in affiliate_payouts.external_status.
export function mapDeliveryStatus(tremendousStatus) {
  const s = String(tremendousStatus || '').toUpperCase();
  if (s === 'SUCCEEDED' || s === 'DELIVERED') return 'delivered';
  if (s === 'PENDING'   || s === 'PROCESSING') return 'processing';
  if (s === 'FAILED'    || s === 'CANCELED' || s === 'CANCELLED') return 'failed';
  return 'requested';
}
