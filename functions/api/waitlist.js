// ── Goofy Licenses — Coming-soon Waitlist (Cloudflare Pages Function) ───────
// POST /api/waitlist
// Body: { line, email?, idea?, source?, website? }
//
// Collects "tell me when it's ready" signups for coming-soon lines (the
// homepage tiles and the /forklift, /clown pages) plus the free-text
// "suggest a license" box. Signups are the demand test that decides which
// line gets built next; the Command Station "Waitlists" view reads them via
// admin-api list_waitlist. Nothing is emailed from here.
//
// - line:  a coming-soon line id from functions/_shared/lines.js, or 'suggest'
// - email: required for a line signup, optional for a suggestion
// - idea:  required for a suggestion
// - website: honeypot; bots fill it, humans never see it
//
// The `plf_waitlist` table is created lazily on the first request (same
// self-sufficient DDL pattern as free-licence.js). Duplicate signups for the
// same line + email are ignored, and each visitor is capped per hour.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { WAITLIST_LINES } from '../_shared/lines.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_BODY_BYTES = 8 * 1024;
const MAX_EMAIL      = 200;
const MAX_IDEA       = 120;
const MAX_SOURCE     = 120;
const MAX_PER_HOUR   = 10;     // abuse guard: rows per visitor (hashed IP) / hour
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function str(v, max) {
  if (v === undefined || v === null) return null;
  const s = ('' + v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// Hash the visitor IP so the rate limit works without storing raw IPs.
async function visitorHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
  if (!ip) return null;
  const data = new TextEncoder().encode(ip + '|' + (env.ADMIN_JWT_SECRET || 'plf-waitlist'));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Create the table (+ indexes) at most once per isolate.
let ensureTablePromise = null;
async function ensureTable(db) {
  if (ensureTablePromise === true) return;
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS plf_waitlist (
          id          BIGSERIAL PRIMARY KEY,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          line        TEXT NOT NULL,
          email       TEXT,
          idea        TEXT,
          source      TEXT,
          ip_hash     TEXT
        )`);
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS plf_waitlist_line_email
          ON plf_waitlist (line, lower(email))
          WHERE email IS NOT NULL AND line <> 'suggest'`);
      await db.query(`CREATE INDEX IF NOT EXISTS plf_waitlist_ip_time ON plf_waitlist (ip_hash, created_at)`);
    })().then(() => { ensureTablePromise = true; }, (err) => { ensureTablePromise = null; throw err; });
  }
  await ensureTablePromise;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  const len = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (len > MAX_BODY_BYTES) return json(413, { error: 'Request too large.' });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'Invalid JSON.' }); }
  if (!body || typeof body !== 'object') return json(400, { error: 'Invalid request.' });

  // Honeypot: pretend it worked so bots don't retry.
  if (str(body.website, 200)) return json(200, { ok: true });

  const line = str(body.line, 40);
  if (!line || !WAITLIST_LINES.includes(line)) return json(400, { error: 'Unknown license.' });

  const email = str(body.email, MAX_EMAIL);
  const idea = str(body.idea, MAX_IDEA);
  const source = str(body.source, MAX_SOURCE);
  if (email && !EMAIL_RE.test(email)) return json(400, { error: 'Please enter a valid email address.' });
  if (line === 'suggest') {
    if (!idea) return json(400, { error: 'Tell us your idea first.' });
  } else if (!email) {
    return json(400, { error: 'Please enter your email.' });
  }

  const db = getDb(env);
  try {
    await ensureTable(db);
    const ipHash = await visitorHash(request, env);
    if (ipHash) {
      const recent = await db.query(
        `SELECT COUNT(*)::int AS n FROM plf_waitlist
          WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'`,
        [ipHash]
      );
      if ((recent.rows[0]?.n || 0) >= MAX_PER_HOUR) {
        return json(429, { error: 'Thanks, we have your signups. Try again later.' });
      }
    }
    await db.query(
      `INSERT INTO plf_waitlist (line, email, idea, source, ip_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [line, email, line === 'suggest' ? idea : null, source, ipHash]
    );
    return json(200, { ok: true });
  } catch (err) {
    console.error('waitlist insert failed:', err);
    return json(500, { error: 'Could not save that. Please try again.' });
  }
}
