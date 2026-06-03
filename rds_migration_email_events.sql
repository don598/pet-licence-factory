-- ── Email event tracking (SendGrid Event Webhook) ───────────────────────────
-- Stores every delivery event SendGrid posts (processed/delivered/open/click/
-- bounce/dropped/spamreport/deferred), keyed back to a pet_orders row via the
-- order_id custom_arg we attach when sending. A denormalised summary lives on
-- pet_orders for fast display in Command Station.
-- Additive + idempotent: safe to run on the live DB.

CREATE TABLE IF NOT EXISTS email_events (
  id            BIGSERIAL PRIMARY KEY,
  order_id      TEXT,                       -- joins to pet_orders.order_id (may be null for non-order emails)
  email         TEXT,                       -- recipient
  event         TEXT NOT NULL,              -- processed | delivered | open | click | bounce | dropped | spamreport | deferred | unsubscribe
  email_type    TEXT,                       -- our custom tag: confirmation | address_issue | shipping | stamp_shipped | ...
  reason        TEXT,                       -- bounce/drop reason or SMTP response
  sg_message_id TEXT,                       -- SendGrid message id
  sg_event_id   TEXT UNIQUE,                -- per-event id; used to dedupe retried deliveries
  occurred_at   TIMESTAMPTZ,                -- event timestamp from SendGrid
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_events_order_id ON email_events(order_id);
CREATE INDEX IF NOT EXISTS idx_email_events_email    ON email_events(email);
CREATE INDEX IF NOT EXISTS idx_email_events_event    ON email_events(event);

-- Denormalised summary for quick rendering in the order list.
ALTER TABLE pet_orders
  ADD COLUMN IF NOT EXISTS email_status        TEXT,           -- latest event for this order
  ADD COLUMN IF NOT EXISTS email_status_at     TIMESTAMPTZ,    -- when that event occurred
  ADD COLUMN IF NOT EXISTS email_opens         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_bounce_reason TEXT,           -- last bounce/drop/spam reason
  ADD COLUMN IF NOT EXISTS email_last_type     TEXT;           -- which email it was (confirmation, etc.)
