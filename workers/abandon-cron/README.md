# plf-abandon-cron

A tiny scheduled Cloudflare Worker that pokes the Pages Function
`/api/send-abandonment` once an hour. That Function does all the work
(selects abandoned free-licence leads, re-attaches their rendered card,
sends the 15%-off nudge, marks `abandon_sent_at` so nobody is emailed twice).

This Worker is **deliberately not auto-deployed**. It lives outside the Pages
project and must be deployed by hand with the steps below.

## What it does

- `scheduled` (cron `0 * * * *`): POSTs to
  `https://petlicensefactory.com/api/send-abandonment` with the
  `x-cron-secret` header.
- `fetch` (manual test trigger): same POST, but only if you pass the matching
  `x-cron-secret` header, so it can't be fired by a stray request.

## One-time manual deploy

All commands run from this directory (`workers/abandon-cron/`).

1. **Pick a strong shared secret** (any long random string), e.g.
   ```sh
   openssl rand -hex 32
   ```

2. **Set the secret on the Worker:**
   ```sh
   wrangler secret put ABANDON_CRON_SECRET
   # paste the value from step 1 when prompted
   ```

3. **Set the SAME secret on the Pages project** (so the endpoint accepts the
   Worker's calls). Either in the Cloudflare dashboard
   (Pages → pet-licence-factory → Settings → Environment variables →
   add `ABANDON_CRON_SECRET` as a Secret to Production), or via CLI from the
   repo root:
   ```sh
   npx wrangler pages secret put ABANDON_CRON_SECRET --project-name pet-licence-factory
   # paste the SAME value
   ```

4. **Deploy the Worker:**
   ```sh
   wrangler deploy
   ```
   The cron trigger (`0 * * * *`) is registered from `wrangler.toml`.

## Test without waiting for the cron (and without real sends)

Use the endpoint's `dryRun` flag to see who WOULD be emailed. This selects and
returns candidates but sends nothing and marks nothing:

```sh
curl -sS -X POST https://petlicensefactory.com/api/send-abandonment \
  -H "x-cron-secret: <YOUR_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}' | jq
```

Expected shape:
```json
{ "dryRun": true, "candidates": 0, "leads": [] }
```

When you are ready to actually send, drop `dryRun` (send an empty body `{}`),
or just let the hourly cron do it.

## Optional: SendGrid unsubscribe group

The email includes a working unsubscribe link. If you create a SendGrid
**Suppression Group (ASM)** for marketing mail, set its numeric id as a Pages
env var `SENDGRID_ASM_GROUP_ID` and the email will use SendGrid's one-click
group unsubscribe. If that var is absent, the email falls back to SendGrid
subscription tracking (the `[unsubscribe]` token is swapped for a real URL at
send time) — no extra setup needed.

## Rollback

`wrangler delete` (from this directory) removes the Worker and its cron
trigger. The Pages Function stays deployed but does nothing without the hourly
poke, and returns 401 to anyone without the secret.
