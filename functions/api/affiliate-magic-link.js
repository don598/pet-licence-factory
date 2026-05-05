// ── Pet Licence Factory — Affiliate Magic-Link ──────────────────────────────
// POST /api/affiliate-magic-link   { action: 'request' | 'verify', ... }
//
// Auth flow for the creator dashboard. No passwords.
//   request → { email }                    → emails a one-time link
//   verify  → { token }                    → returns the dashboard token
//
// The magic-link token is single-use and expires in 30 minutes. Once
// verified it returns the long-lived dashboard token — the same token that
// goes in the onboarding email's "Open dashboard" button.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import {
  generateToken,
  findCreatorByEmail,
} from '../_shared/affiliate.js';
import { sendCreatorMagicLinkEmail } from '../_shared/email.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAGIC_LINK_TTL_MIN = 30;

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

  const db = getDb(env);
  const action = body.action;

  if (action === 'request') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) return json(400, { error: 'Email is required.' });

    const creator = await findCreatorByEmail(db, email);

    // Always 200 to avoid leaking which emails are creators. Silently skip
    // when no match.
    if (!creator) return json(200, { sent: true });

    // Invalidate any unused tokens for this creator to keep things tidy.
    await db.query(
      `UPDATE affiliate_magic_links SET used_at = NOW()
       WHERE creator_id = $1 AND used_at IS NULL`,
      [creator.id]
    );

    const token     = generateToken();
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MIN * 60 * 1000);
    await db.query(
      `INSERT INTO affiliate_magic_links (creator_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [creator.id, token, expiresAt.toISOString()]
    );

    const siteOrigin = env.URL || 'https://pet-licence-factory.pages.dev';
    const magicUrl   = `${siteOrigin}/dashboard.html?magic=${encodeURIComponent(token)}`;

    const result = await sendCreatorMagicLinkEmail(env, {
      creatorEmail: creator.email,
      creatorName:  creator.name,
      magicUrl,
      expiresMinutes: MAGIC_LINK_TTL_MIN,
    });

    try {
      await db.query(
        `INSERT INTO affiliate_email_log
           (creator_id, template, to_email, subject, sendgrid_message_id, success, error)
         VALUES ($1, 'magic_link', $2, $3, $4, $5, $6)`,
        [
          creator.id,
          creator.email,
          '🔑 Sign in to your Pet Licence Factory dashboard',
          result?.messageId || null,
          !!result?.success,
          result?.error ? String(result.error).slice(0, 500) : null,
        ]
      );
    } catch (err) {
      console.error('email log insert failed:', err);
    }

    return json(200, { sent: true });
  }

  if (action === 'verify') {
    const token = String(body.token || '').trim();
    if (!token) return json(400, { error: 'Missing token' });

    const res = await db.query(
      `SELECT m.id, m.creator_id, m.expires_at, m.used_at,
              c.dashboard_token, c.name, c.email
       FROM affiliate_magic_links m
       JOIN affiliate_creators    c ON c.id = m.creator_id
       WHERE m.token = $1 LIMIT 1`,
      [token]
    );
    if (res.rows.length === 0) return json(400, { error: 'Invalid or expired link.' });
    const row = res.rows[0];

    if (row.used_at)                         return json(400, { error: 'This link has already been used.' });
    if (new Date(row.expires_at) < new Date()) return json(400, { error: 'This link has expired.' });

    await db.query(
      'UPDATE affiliate_magic_links SET used_at = NOW() WHERE id = $1',
      [row.id]
    );

    return json(200, {
      success: true,
      dashboard_token: row.dashboard_token,
      creator: { name: row.name, email: row.email },
    });
  }

  return json(400, { error: 'Unknown action' });
}
