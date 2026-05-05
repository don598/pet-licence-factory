// ── Pet Licence Factory — Pixel ID Endpoint ─────────────────────────────────
// GET /api/pixels-config  →  { meta: 'XXXX', tiktok: 'YYYY' }
//
// Lets us drive Meta + TikTok pixel IDs from env vars without rebuilding the
// static site. Cached at the edge for an hour because pixel IDs change very
// rarely.
// ---------------------------------------------------------------------------

export async function onRequest(context) {
  const { env } = context;
  const body = JSON.stringify({
    meta:   env.META_PIXEL_ID   || '',
    tiktok: env.TIKTOK_PIXEL_ID || '',
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
