// ── Pet Licence Factory — Public Creator Signup ────────────────────────────
// POST /api/affiliate-signup
//
// Creates a self-service affiliate creator using server-controlled program
// terms, creates Stripe promo codes, and sends the standard onboarding email.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import {
  createCreatorInvite,
  clampRate,
  siteOrigin,
} from '../_shared/affiliate-onboarding.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, ...extraHeaders },
  });
}

function cleanText(value, maxLen) {
  return String(value || '').trim().slice(0, maxLen);
}

function enabled(env) {
  const value = String(env.AFFILIATE_SELF_SIGNUP_ENABLED || 'true').toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(value);
}

function creatorNotes(body, request) {
  const lines = [
    'Source: self-service creator signup',
    cleanText(body.profileUrl, 240) && `Profile URL: ${cleanText(body.profileUrl, 240)}`,
    cleanText(body.primaryChannel, 80) && `Primary channel: ${cleanText(body.primaryChannel, 80)}`,
    cleanText(body.audienceSize, 80) && `Audience size: ${cleanText(body.audienceSize, 80)}`,
    cleanText(body.pitch, 500) && `Signup note: ${cleanText(body.pitch, 500)}`,
    `Submitted at: ${new Date().toISOString()}`,
    `Signup IP: ${request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'}`,
  ];
  return lines.filter(Boolean).join('\n').slice(0, 1000);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }
  if (!enabled(env)) {
    return json(503, { error: 'Creator signup is temporarily closed.' });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  // Honeypot: real users never fill this hidden field.
  if (cleanText(body.companyWebsite, 200)) {
    return json(200, { success: true, queued: true });
  }

  const termsAccepted = body.termsAccepted === true || body.termsAccepted === 'true' || body.termsAccepted === 'on';
  if (!termsAccepted) {
    return json(400, { error: 'Please accept the creator program terms.' });
  }
  if (!cleanText(body.profileUrl, 240)) {
    return json(400, { error: 'Public profile is required.' });
  }

  const db = getDb(env);
  try {
    const result = await createCreatorInvite(env, db, {
      name: cleanText(body.name, 100),
      email: cleanText(body.email, 200),
      couponCode: cleanText(body.couponCode, 32),
      commissionRate: clampRate(env.AFFILIATE_SELF_SIGNUP_COMMISSION_RATE, 0.20),
      customerDiscountRate: clampRate(env.AFFILIATE_SELF_SIGNUP_DISCOUNT_RATE, 0.15),
      notes: creatorNotes(body, request),
      skipEmail: false,
    });

    return json(200, {
      success: true,
      creator_id: result.creator_id,
      creator: result.creator,
      codes: result.codes,
      urls: {
        affiliate: result.urls.affiliate,
        freebie: result.urls.freebie,
        dashboard: `${siteOrigin(env)}/dashboard.html`,
      },
      email: {
        sent: !!result.email?.success,
        skipped: !!result.email?.skipped,
      },
    });
  } catch (err) {
    if (err?.status && err?.body) return json(err.status, err.body);
    console.error('Affiliate public signup error:', err);
    return json(500, { error: err.message || 'Server error' });
  }
}
