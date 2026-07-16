// ── Pet Licence Factory — Card-Abandonment Cron Worker ─────────────────────
// A tiny scheduled Worker whose only job is to POST to the Pages Function
// /api/send-abandonment once an hour, carrying the shared secret so the
// endpoint accepts the call. All the real logic (selection, image fetch,
// send, dedupe) lives in that Function — this is just the trigger.
//
// NOT deployed automatically. See README.md for the manual deploy steps.
// ---------------------------------------------------------------------------

const ENDPOINT = 'https://petlicensefactory.com/api/send-abandonment';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  // Manual trigger for testing: `wrangler dev` then hit the worker URL.
  // Guarded by the same secret so a stray request can't fire real sends.
  async fetch(request, env) {
    if (request.headers.get('x-cron-secret') !== env.ABANDON_CRON_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
    const body = await run(env);
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
};

async function run(env) {
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': env.ABANDON_CRON_SECRET || '',
      },
      body: JSON.stringify({}),
    });
    const text = await resp.text();
    console.log(`abandon-cron: ${resp.status} ${text}`);
    return text;
  } catch (err) {
    console.error('abandon-cron: request failed:', err && err.message);
    return JSON.stringify({ error: 'request_failed' });
  }
}
