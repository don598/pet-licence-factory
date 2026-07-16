// ── Pet Licence Factory — Free Digital Licence (Cloudflare Pages Function) ──
// POST /api/free-licence
// Body: { email, petName, image (data:image/... base64 URL), v, s,
//         utm_source, utm_campaign }
//
// Emails the visitor a free, watermarked digital copy of their pet's licence
// and records them as a marketing lead in `plf_leads`. This is a secondary,
// non-purchase path off the Step 5 review screen — it must never touch the
// order/checkout flow. Returns { ok:true } on success.
//
// The `plf_leads` table (+ email index) is created lazily on first request,
// same self-sufficient DDL pattern as functions/api/track.js, because we
// can't run migrations from the dev machine.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { sendFreeLicenceEmail } from '../_shared/email.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Guards
const MAX_BODY_BYTES  = 2.2 * 1024 * 1024;   // whole request cap (~image + fields)
const MAX_IMAGE_B64   = 1.5 * 1024 * 1024;   // base64 payload cap (~1.5MB)
const MAX_EMAIL       = 200;
const MAX_PETNAME     = 80;
const MAX_UTM         = 120;
const MAX_ID          = 80;
const MAX_PER_DAY      = 3;                    // abuse guard: sends per email / 24h
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IMAGE_RE = /^data:image\/(jpeg|jpg|webp|png);base64,([A-Za-z0-9+/=]+)$/;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function str(v, max) {
  if (v === undefined || v === null) return null;
  const s = ('' + v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// Create the leads table (+ email index) at most once per isolate.
let ensureTablePromise = null;
async function ensureTable(db) {
  if (ensureTablePromise === true) return;
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS plf_leads (
          id           BIGSERIAL PRIMARY KEY,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          email        TEXT,
          pet_name     TEXT,
          source       TEXT,
          visitor_id   TEXT,
          session_id   TEXT,
          utm_source   TEXT,
          utm_campaign TEXT,
          emails_sent  INT DEFAULT 1
        )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_plf_leads_email ON plf_leads (email)`);
      // Card-abandonment feature: the R2 key of the rendered licence image
      // (so the follow-up cron can re-attach it), and the one-per-lead dedupe
      // marker. Added lazily on existing deployments — safe to re-run.
      await db.query(`ALTER TABLE plf_leads ADD COLUMN IF NOT EXISTS licence_image_key TEXT`);
      await db.query(`ALTER TABLE plf_leads ADD COLUMN IF NOT EXISTS abandon_sent_at TIMESTAMPTZ`);
    })().then(
      () => { ensureTablePromise = true; },
      (err) => { ensureTablePromise = null; throw err; }   // allow a later retry
    );
  }
  await ensureTablePromise;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  // ── Size-guard the raw body before parsing ──
  let raw;
  try {
    raw = await request.text();
  } catch {
    return json(400, { error: 'Invalid request' });
  }
  if (!raw || raw.length > MAX_BODY_BYTES) {
    return json(413, { error: 'Request too large' });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Invalid request' });
  }
  if (!body || typeof body !== 'object') {
    return json(400, { error: 'Invalid request' });
  }

  // ── Validate email ──
  const email = (str(body.email, MAX_EMAIL) || '').toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return json(400, { error: 'Please enter a valid email address.' });
  }

  // ── Validate image (data URL, allowed types, size) ──
  const image = typeof body.image === 'string' ? body.image : '';
  const m = image.match(IMAGE_RE);
  if (!m) {
    return json(400, { error: 'Invalid image.' });
  }
  const b64 = m[2];
  if (b64.length > MAX_IMAGE_B64) {
    return json(413, { error: 'Image too large.' });
  }
  const mimeType = m[1] === 'jpg' ? 'image/jpeg' : `image/${m[1]}`;

  // ── Normalise the rest ──
  const petName    = str(body.petName, MAX_PETNAME) || 'your pet';
  const visitorId  = str(body.v, MAX_ID);
  const sessionId  = str(body.s, MAX_ID);
  const utmSource  = str(body.utm_source, MAX_UTM);
  const utmCampaign = str(body.utm_campaign, MAX_UTM);

  const db = getDb(env);

  // ── Abuse guard: max MAX_PER_DAY emails per address per rolling 24h ──
  // We keep one row per email per day and increment emails_sent on repeats,
  // so a recent row's counter is the day's tally.
  let recentRow = null;
  try {
    await ensureTable(db);
    const r = await db.query(
      `SELECT id, emails_sent FROM plf_leads
        WHERE email = $1 AND created_at > now() - INTERVAL '24 hours'
        ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    recentRow = r.rows[0] || null;
    if (recentRow && recentRow.emails_sent >= MAX_PER_DAY) {
      return json(429, { error: "You've already been sent this a few times today. Check your inbox (and spam)." });
    }
  } catch (err) {
    console.error('free-licence: pre-send check failed:', err && err.message);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }

  // ── Send the email (with the licence attached) ──
  let sendResult;
  try {
    sendResult = await sendFreeLicenceEmail(env, { to: email, petName, imageBase64: b64, mimeType });
  } catch (err) {
    console.error('free-licence: send threw:', err && err.message);
    return json(502, { error: "We couldn't send the email just now. Please try again." });
  }
  if (sendResult && sendResult.success === false) {
    console.error('free-licence: SendGrid rejected:', sendResult.status);
    return json(502, { error: "We couldn't send the email just now. Please try again." });
  }

  // ── Record the lead (insert new, or bump today's counter) ──
  let leadId = null;
  try {
    if (recentRow) {
      await db.query(
        `UPDATE plf_leads
            SET emails_sent = emails_sent + 1,
                pet_name = COALESCE($2, pet_name),
                utm_source = COALESCE($3, utm_source),
                utm_campaign = COALESCE($4, utm_campaign)
          WHERE id = $1`,
        [recentRow.id, petName, utmSource, utmCampaign]
      );
      leadId = recentRow.id;
    } else {
      const ins = await db.query(
        `INSERT INTO plf_leads
           (email, pet_name, source, visitor_id, session_id, utm_source, utm_campaign)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [email, petName, 'homepage_builder', visitorId, sessionId, utmSource, utmCampaign]
      );
      leadId = ins.rows[0] && ins.rows[0].id;
    }
  } catch (err) {
    // Email already went out — don't fail the user over a logging miss.
    console.error('free-licence: lead upsert failed (non-fatal):', err && err.message);
  }

  // ── Persist the rendered licence image to R2 for the abandonment cron ──
  // Non-fatal: the freebie email already shipped, so an R2 or DB miss here
  // must never surface to the visitor. The abandonment cron only targets
  // leads that actually have an image key, so a miss just skips that lead.
  if (leadId && env.CREATOR_UPLOADS) {
    try {
      const key = `abandon/lead-${leadId}.png`;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await env.CREATOR_UPLOADS.put(key, bytes, {
        httpMetadata: { contentType: mimeType },
        customMetadata: { leadId: String(leadId), email, petName },
      });
      await db.query(
        `UPDATE plf_leads SET licence_image_key = $1 WHERE id = $2`,
        [key, leadId]
      );
    } catch (err) {
      console.error('free-licence: licence image persist failed (non-fatal):', err && err.message);
    }
  }

  return json(200, { ok: true });
}
