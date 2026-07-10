// ── Pet Licence Factory — Pixel ID Endpoint ─────────────────────────────────
// GET /api/pixels-config  →  { meta: 'XXXX', tiktok: 'YYYY' }
//
// Lets us drive Meta + TikTok pixel IDs from env vars without rebuilding the
// static site. Cached briefly (5 min) so toggling an ID on/off propagates fast
// — a longer TTL strands stale (often empty) responses on edge PoPs for an hour.
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
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
