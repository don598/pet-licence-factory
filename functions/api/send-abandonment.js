// ── Pet Licence Factory — Card-Abandonment Email (Cloudflare Function) ──────
// POST /api/send-abandonment
// Auth: shared-secret header  x-cron-secret: <ABANDON_CRON_SECRET>
// Body (optional): { "dryRun": true }  → run selection only, send nothing.
//
// Emails a one-time "your pet's licence is still waiting" nudge (with 15% off)
// to leads who grabbed the free digital licence 2–72h ago but never bought the
// physical card skin. One send per lead, ever, enforced by abandon_sent_at.
//
// Designed to be poked hourly by the workers/abandon-cron Worker (which holds
// the shared secret). No public surface: without the secret it returns 401.
//
// Selection (a lead is eligible when ALL hold):
//   • created_at is between 72h and 2h ago (old enough to have "abandoned",
//     fresh enough to still care)
//   • abandon_sent_at IS NULL          (never nudged before)
//   • licence_image_key IS NOT NULL    (we have their rendered card to re-send)
//   • no plf_events purchase_success for the same visitor_id
//   • their email is not on a paid-ish pet_orders row
//
// The plf_leads columns (licence_image_key, abandon_sent_at) are created by
// functions/api/free-licence.js on its first request; we also self-heal them
// here so this endpoint works even if free-licence hasn't run this isolate.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { sendAbandonmentEmail } from '../_shared/email.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Statuses that mean "this person paid" — mirrors stripe-webhook.js's
// wasAlreadyPaid set, widened to the full lifecycle used across the codebase.
const PAID_STATUSES = ['paid', 'processed', 'shipped', 'complete', 'completed', 'printed'];

// Safety valve: never blast more than this in one run.
const MAX_PER_RUN = 20;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Ensure the abandonment columns exist (idempotent, self-healing).
let ensureColsPromise = null;
async function ensureCols(db) {
  if (ensureColsPromise === true) return;
  if (!ensureColsPromise) {
    ensureColsPromise = (async () => {
      await db.query(`ALTER TABLE plf_leads ADD COLUMN IF NOT EXISTS licence_image_key TEXT`);
      await db.query(`ALTER TABLE plf_leads ADD COLUMN IF NOT EXISTS abandon_sent_at TIMESTAMPTZ`);
    })().then(
      () => { ensureColsPromise = true; },
      (err) => { ensureColsPromise = null; throw err; }
    );
  }
  await ensureColsPromise;
}

// Convert an R2 object's bytes to base64 for a SendGrid attachment.
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  // ── Shared-secret guard ──
  const secret = env.ABANDON_CRON_SECRET;
  if (!secret) {
    console.error('send-abandonment: ABANDON_CRON_SECRET not configured');
    return json(500, { error: 'Not configured' });
  }
  if (request.headers.get('x-cron-secret') !== secret) {
    return json(401, { error: 'Unauthorized' });
  }

  // ── Parse optional body (dryRun flag) ──
  let dryRun = false;
  try {
    const raw = await request.text();
    if (raw) {
      const body = JSON.parse(raw);
      dryRun = body && body.dryRun === true;
    }
  } catch {
    // ignore a malformed body — default to a real run
  }

  const db = getDb(env);

  try {
    await ensureCols(db);
  } catch (err) {
    console.error('send-abandonment: ensureCols failed:', err && err.message);
    return json(500, { error: 'Schema check failed' });
  }

  // ── Select eligible leads ──
  let leads;
  try {
    const res = await db.query(
      `SELECT l.id, l.email, l.pet_name, l.licence_image_key
         FROM plf_leads l
        WHERE l.created_at BETWEEN now() - interval '72 hours' AND now() - interval '2 hours'
          AND l.abandon_sent_at IS NULL
          AND l.licence_image_key IS NOT NULL
          AND l.email IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM plf_events e
             WHERE e.event_type = 'purchase_success'
               AND e.visitor_id = l.visitor_id
               AND l.visitor_id IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM pet_orders o
             WHERE lower(o.customer_email) = lower(l.email)
               AND o.status = ANY($1)
          )
        ORDER BY l.created_at ASC
        LIMIT $2`,
      [PAID_STATUSES, MAX_PER_RUN]
    );
    leads = res.rows;
  } catch (err) {
    console.error('send-abandonment: selection query failed:', err && err.message);
    return json(500, { error: 'Selection failed' });
  }

  // ── Dry run: report who WOULD be emailed, send/mark nothing ──
  if (dryRun) {
    return json(200, {
      dryRun: true,
      candidates: leads.length,
      leads: leads.map((l) => ({ id: l.id, email: l.email, pet_name: l.pet_name })),
    });
  }

  // ── Real run: for each lead, fetch image, send, then mark sent ──
  const results = { attempted: leads.length, sent: 0, skipped: 0, failed: 0, details: [] };

  for (const lead of leads) {
    let imageBase64 = null;
    let mimeType = 'image/png';
    try {
      if (env.CREATOR_UPLOADS) {
        const obj = await env.CREATOR_UPLOADS.get(lead.licence_image_key);
        if (obj) {
          const buf = new Uint8Array(await obj.arrayBuffer());
          imageBase64 = bytesToBase64(buf);
          mimeType = (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/png';
        }
      }
    } catch (err) {
      console.error(`send-abandonment: R2 fetch failed for lead ${lead.id}:`, err && err.message);
    }

    if (!imageBase64) {
      // No image to re-attach — skip WITHOUT marking, so a later run (once the
      // object exists) can still pick it up.
      results.skipped++;
      results.details.push({ id: lead.id, status: 'skipped_no_image' });
      continue;
    }

    let sendOk = false;
    try {
      const r = await sendAbandonmentEmail(env, {
        to: lead.email,
        petName: lead.pet_name,
        imageBase64,
        mimeType,
        leadId: lead.id,
      });
      // Treat anything that isn't an explicit failure as sent. A "skipped"
      // (e.g. no API key locally) still marks so we never retry-storm.
      sendOk = !(r && r.success === false);
    } catch (err) {
      console.error(`send-abandonment: send threw for lead ${lead.id}:`, err && err.message);
      sendOk = false;
    }

    if (!sendOk) {
      results.failed++;
      results.details.push({ id: lead.id, status: 'send_failed' });
      // Do NOT mark — let the next run retry this lead.
      continue;
    }

    // Mark sent even though we can't confirm final delivery, so retries never
    // double-send the same lead.
    try {
      await db.query(
        `UPDATE plf_leads SET abandon_sent_at = now() WHERE id = $1`,
        [lead.id]
      );
    } catch (err) {
      console.error(`send-abandonment: mark-sent failed for lead ${lead.id}:`, err && err.message);
    }

    results.sent++;
    results.details.push({ id: lead.id, status: 'sent' });
  }

  return json(200, results);
}
