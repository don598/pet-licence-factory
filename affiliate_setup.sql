-- ================================================================
--  Pet Licence Factory — Affiliate System Schema
--  Safe to re-run; uses CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
--  Run against the petlicencefactory database on the shared RDS instance.
-- ================================================================

-- ── 1. Creators ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS affiliate_creators (
  id                       BIGSERIAL    PRIMARY KEY,
  name                     TEXT         NOT NULL,
  email                    TEXT         NOT NULL UNIQUE,
  coupon_code              TEXT         NOT NULL UNIQUE,
  commission_rate          NUMERIC(5,4) NOT NULL DEFAULT 0.20,
  customer_discount_rate   NUMERIC(5,4) NOT NULL DEFAULT 0.15,

  -- Stripe references
  stripe_coupon_id         TEXT,
  stripe_promo_code_id     TEXT,
  stripe_freebie_coupon_id TEXT,
  stripe_freebie_promo_id  TEXT,
  freebie_code             TEXT,

  -- Magic-link auth
  dashboard_token          TEXT         NOT NULL UNIQUE,

  -- State
  setup_status             TEXT         NOT NULL DEFAULT 'pending',
  setup_error              TEXT,
  freebie_redeemed_at      TIMESTAMPTZ,
  notes                    TEXT,

  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aff_creators_coupon ON affiliate_creators (LOWER(coupon_code));
CREATE INDEX IF NOT EXISTS idx_aff_creators_email  ON affiliate_creators (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_aff_creators_token  ON affiliate_creators (dashboard_token);


-- ── 2. Clicks ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id           BIGSERIAL    PRIMARY KEY,
  creator_id   BIGINT       NOT NULL REFERENCES affiliate_creators(id) ON DELETE CASCADE,
  visitor_hash TEXT         NOT NULL,
  referrer     TEXT,
  user_agent   TEXT,
  landing_path TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One row per visitor per creator per 24-hour window (dedup at write time
-- via INSERT...ON CONFLICT DO NOTHING using bucket_day).
ALTER TABLE affiliate_clicks
  ADD COLUMN IF NOT EXISTS bucket_day DATE NOT NULL DEFAULT CURRENT_DATE;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_aff_click_dedup
  ON affiliate_clicks (creator_id, visitor_hash, bucket_day);
CREATE INDEX IF NOT EXISTS idx_aff_clicks_creator_date
  ON affiliate_clicks (creator_id, created_at DESC);


-- ── 3. Affiliate orders (one row per attributed purchase) ──────────────────
-- Mirrors a subset of pet_orders columns at the time of attribution so that
-- changes to the source order or to creator commission rate later don't
-- alter historical earnings.
CREATE TABLE IF NOT EXISTS affiliate_orders (
  id               BIGSERIAL    PRIMARY KEY,
  creator_id       BIGINT       NOT NULL REFERENCES affiliate_creators(id) ON DELETE RESTRICT,
  pet_order_id     BIGINT       REFERENCES pet_orders(id) ON DELETE SET NULL,
  order_id_text    TEXT         NOT NULL,
  stripe_session_id   TEXT,
  stripe_payment_intent TEXT,

  attribution_method  TEXT      NOT NULL,             -- 'cookie' | 'coupon'
  is_freebie          BOOLEAN   NOT NULL DEFAULT FALSE,

  gross_cents         INTEGER   NOT NULL DEFAULT 0,   -- net of discount, pre-shipping/tax
  discount_cents      INTEGER   NOT NULL DEFAULT 0,
  commission_rate     NUMERIC(5,4) NOT NULL,
  commission_cents    INTEGER   NOT NULL DEFAULT 0,

  refunded_at         TIMESTAMPTZ,
  refund_cents        INTEGER   NOT NULL DEFAULT 0,
  commission_zeroed   BOOLEAN   NOT NULL DEFAULT FALSE,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (order_id_text)
);

CREATE INDEX IF NOT EXISTS idx_aff_orders_creator_created ON affiliate_orders (creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aff_orders_session         ON affiliate_orders (stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_aff_orders_intent          ON affiliate_orders (stripe_payment_intent);


-- ── 4. Manual payouts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS affiliate_payouts (
  id              BIGSERIAL    PRIMARY KEY,
  creator_id      BIGINT       NOT NULL REFERENCES affiliate_creators(id) ON DELETE CASCADE,
  amount_cents    INTEGER      NOT NULL,
  method          TEXT         NOT NULL,             -- venmo, paypal, zelle, other
  paid_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  notes           TEXT,
  -- Reserved for future Stripe Connect graduation
  stripe_transfer_id TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aff_payouts_creator_paid ON affiliate_payouts (creator_id, paid_at DESC);


-- ── 5. Email send log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS affiliate_email_log (
  id                 BIGSERIAL    PRIMARY KEY,
  creator_id         BIGINT       REFERENCES affiliate_creators(id) ON DELETE SET NULL,
  template           TEXT         NOT NULL,          -- onboarding, magic_link, etc.
  to_email           TEXT         NOT NULL,
  subject            TEXT,
  sendgrid_message_id TEXT,
  success            BOOLEAN      NOT NULL DEFAULT FALSE,
  error              TEXT,
  sent_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aff_email_log_creator ON affiliate_email_log (creator_id, sent_at DESC);


-- ── 6. Magic-link request log (for one-time token validation) ──────────────
CREATE TABLE IF NOT EXISTS affiliate_magic_links (
  id           BIGSERIAL    PRIMARY KEY,
  creator_id   BIGINT       NOT NULL REFERENCES affiliate_creators(id) ON DELETE CASCADE,
  token        TEXT         NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ  NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aff_magic_links_token ON affiliate_magic_links (token);
CREATE INDEX IF NOT EXISTS idx_aff_magic_links_creator ON affiliate_magic_links (creator_id, created_at DESC);


-- ── 7. Reuse the existing updated_at trigger ───────────────────────────────
DO $$ BEGIN
  CREATE TRIGGER set_affiliate_creators_updated_at
    BEFORE UPDATE ON affiliate_creators
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER set_affiliate_orders_updated_at
    BEFORE UPDATE ON affiliate_orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── 8. Augment pet_orders so attribution survives in the source row too ────
ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS affiliate_creator_id     BIGINT REFERENCES affiliate_creators(id) ON DELETE SET NULL;
ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS affiliate_coupon_code    TEXT;
ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS affiliate_commission_rate NUMERIC(5,4);
ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS affiliate_commission_cents INTEGER;
ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS affiliate_is_freebie     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS affiliate_ref_at_submit  TEXT;

CREATE INDEX IF NOT EXISTS idx_pet_orders_aff_creator ON pet_orders (affiliate_creator_id);

-- ── 9. Outreach templates (admin-only saved messages) ─────────────────────
CREATE TABLE IF NOT EXISTS affiliate_outreach_templates (
  id          BIGSERIAL    PRIMARY KEY,
  name        TEXT         NOT NULL,
  body        TEXT         NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TRIGGER set_affiliate_templates_updated_at
    BEFORE UPDATE ON affiliate_outreach_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_aff_templates_name ON affiliate_outreach_templates (name);

-- ================================================================
--  Done. Tables: affiliate_creators, affiliate_clicks, affiliate_orders,
--  affiliate_payouts, affiliate_email_log, affiliate_magic_links,
--  affiliate_outreach_templates
-- ================================================================
