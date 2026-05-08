// ── Pet Licence Factory — Public Creator Signup ────────────────────────────
// POST /api/affiliate-signup
//
// Creates a self-service creator application using server-controlled program
// terms. Coupon/freebie creation is approval-gated in the command center.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import {
  createCreatorApplication,
  clampRate,
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
    cleanText(body.phone, 40) && `Phone: ${cleanText(body.phone, 40)}`,
    `Review video commitment accepted: ${accepted(body.reviewCommitmentAccepted) ? 'yes' : 'no'}`,
    `Video usage/ad permission accepted: ${accepted(body.usagePermissionAccepted) ? 'yes' : 'no'}`,
    cleanText(body.pitch, 500) && `Signup note: ${cleanText(body.pitch, 500)}`,
    `Submitted at: ${new Date().toISOString()}`,
    `Signup IP: ${request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'}`,
  ];
  return lines.filter(Boolean).join('\n').slice(0, 1000);
}

function accepted(value) {
  return value === true || value === 'true' || value === 'on';
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

  const termsAccepted = accepted(body.termsAccepted);
  if (!termsAccepted) {
    return json(400, { error: 'Please accept the creator program terms.' });
  }
  if (!accepted(body.reviewCommitmentAccepted)) {
    return json(400, { error: 'Please agree to post an authentic TikTok review video within 14 days of receiving your product.' });
  }
  if (!accepted(body.usagePermissionAccepted)) {
    return json(400, { error: 'Please grant permission for Credit Card Art to feature, repost, or promote your video.' });
  }
  if (!cleanText(body.profileUrl, 240)) {
    return json(400, { error: 'TikTok or public profile is required.' });
  }

  const db = getDb(env);
  try {
    const result = await createCreatorApplication(env, db, {
      name: cleanText(body.name, 100),
      email: cleanText(body.email, 200),
      couponCode: cleanText(body.couponCode, 32),
      commissionRate: clampRate(env.AFFILIATE_SELF_SIGNUP_COMMISSION_RATE, 0.20),
      customerDiscountRate: clampRate(env.AFFILIATE_SELF_SIGNUP_DISCOUNT_RATE, 0.15),
      notes: creatorNotes(body, request),
    });

    return json(200, {
      success: true,
      pending_review: true,
      creator_id: result.creator_id,
      creator: result.creator,
    });
  } catch (err) {
    if (err?.status && err?.body) return json(err.status, err.body);
    console.error('Affiliate public signup error:', err);
    return json(500, { error: err.message || 'Server error' });
  }
}
