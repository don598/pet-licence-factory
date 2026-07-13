// ── Pet Licence Factory — First-Party Event Tracking (Cloudflare Function) ──
// POST /api/track
// Body (small JSON, sendBeacon or fetch): { v, s, page, type, label, step, meta }
//   v     = visitor_id  (localStorage UUID)
//   s     = session_id  (sessionStorage UUID)
//   page  = pathname
//   type  = event_type  (page_view | click | step | purchase_success | other)
//   label = element label / step label (no PII — id/data-track/trimmed text only)
//   step  = funnel step name (optional)
//   meta  = small object (utm_source/utm_medium/utm_campaign/ttclid/href/etc.)
//
// Inserts into `plf_events`. Always returns 204 fast — tracking must never
// surface an error into the customer flow. Table + indexes are created lazily
// (once per isolate) because migrations can't run from the dev machine.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';

// ── Config / guards ──────────────────────────────────────────────────────
const MAX_BODY_BYTES = 2048;        // reject anything larger than ~2KB
const MAX_STR        = 200;         // generic string cap
const MAX_LABEL      = 200;         // label cap (client also trims to ~60)
const MAX_META_KEYS  = 20;          // meta object key cap
const KNOWN_TYPES = new Set(['page_view', 'click', 'step', 'purchase_success', 'other']);

// Runs the DDL at most once per isolate. `null` = not yet attempted;
// a Promise while in-flight; `true` once it has succeeded.
let ensureTablePromise = null;

const NO_CONTENT = { status: 204, headers: {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
} };

function noContent() { return new Response(null, NO_CONTENT); }

async function ensureTable(db) {
  if (ensureTablePromise === true) return;
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS plf_events (
          id           BIGSERIAL PRIMARY KEY,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          visitor_id   TEXT,
          session_id   TEXT,
          page         TEXT,
          event_type   TEXT,
          label        TEXT,
          step         TEXT,
          utm_source   TEXT,
          utm_campaign TEXT,
          meta         JSONB
        )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_plf_events_created_at ON plf_events (created_at)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_plf_events_event_type ON plf_events (event_type)`);
    })().then(
      () => { ensureTablePromise = true; },
      (err) => { ensureTablePromise = null; throw err; }   // allow a later retry
    );
  }
  await ensureTablePromise;
}

// Truncate + coerce to string (or null).
function str(v, max = MAX_STR) {
  if (v === undefined || v === null) return null;
  const s = ('' + v);
  return s.length > max ? s.slice(0, max) : s;
}

// Keep meta small + JSON-serialisable-primitive. Drops nested objects/arrays,
// caps key count, truncates string values. Never throws.
function sanitizeMeta(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(m)) {
    if (n >= MAX_META_KEYS) break;
    const val = m[k];
    const t = typeof val;
    if (val === null) continue;
    if (t === 'string')       out[str(k, 40)] = str(val, MAX_STR);
    else if (t === 'number' && isFinite(val)) out[str(k, 40)] = val;
    else if (t === 'boolean') out[str(k, 40)] = val;
    else continue;   // skip objects/arrays/functions/undefined
    n++;
  }
  return Object.keys(out).length ? out : null;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return noContent();
  if (request.method !== 'POST')   return noContent();   // 204, never leak

  // ── Read + size-guard the raw body (sendBeacon sends text/plain) ──
  let raw;
  try {
    raw = await request.text();
  } catch {
    return noContent();
  }
  if (!raw || raw.length > MAX_BODY_BYTES) return noContent();

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return noContent();
  }
  if (!body || typeof body !== 'object') return noContent();

  // ── Whitelist + normalise fields ──
  let type = str(body.type, 40) || 'other';
  if (!KNOWN_TYPES.has(type)) type = 'other';

  const meta = sanitizeMeta(body.meta);
  const utmSource   = meta ? str(meta.utm_source, 120)   : null;
  const utmCampaign = meta ? str(meta.utm_campaign, 120) : null;

  const row = {
    visitor_id:   str(body.v, 80),
    session_id:   str(body.s, 80),
    page:         str(body.page, 300),
    event_type:   type,
    label:        str(body.label, MAX_LABEL),
    step:         str(body.step, 80),
    utm_source:   utmSource,
    utm_campaign: utmCampaign,
    meta:         meta ? JSON.stringify(meta) : null,
  };

  // ── Persist — swallow every error so the client flow is never affected ──
  try {
    const db = getDb(env);
    await ensureTable(db);
    await db.query(
      `INSERT INTO plf_events
         (visitor_id, session_id, page, event_type, label, step, utm_source, utm_campaign, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [row.visitor_id, row.session_id, row.page, row.event_type, row.label,
       row.step, row.utm_source, row.utm_campaign, row.meta]
    );
  } catch (err) {
    // Never surface tracking failures. Log for our own diagnostics only.
    console.warn('track: insert failed (non-fatal):', err && err.message);
  }

  return noContent();
}
