-- ================================================================
--  Pet Licence Factory — AWS RDS Setup
--  Run against the petlicencefactory database on the shared RDS instance.
--  Host: lessoncomplete-db.c9e2648w8z0z.us-east-2.rds.amazonaws.com
-- ================================================================

-- 1. Orders table
CREATE TABLE IF NOT EXISTS pet_orders (
  id               BIGSERIAL PRIMARY KEY,
  order_id         TEXT        NOT NULL UNIQUE,
  status           TEXT        NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Pet & licence fields
  pet_first_name   TEXT,
  pet_last_name    TEXT,
  dl_number        TEXT,
  dob              TEXT,
  exp_date         TEXT,
  iss_date         TEXT,
  addr_line1       TEXT,
  addr_line2       TEXT,
  sex              TEXT,
  height           TEXT,
  weight           TEXT,
  eyes             TEXT,
  lic_class        TEXT,
  restrict         TEXT,
  signature        TEXT,
  pet_species      TEXT,

  -- Order details
  pack_count       INTEGER DEFAULT 1,
  total            TEXT,
  chip_size        TEXT,
  add_on           TEXT,
  shipping_option  TEXT DEFAULT 'stamp',

  -- Photo (stored as base64 data URL)
  photo_url        TEXT,

  -- Customer shipping info
  customer_name    TEXT,
  customer_email   TEXT,
  ship_addr_line1  TEXT,
  ship_addr_line2  TEXT,
  ship_city        TEXT,
  ship_state       TEXT,
  ship_zip         TEXT,
  ship_country     TEXT DEFAULT 'US',

  -- Fulfilment
  stripe_payment_id  TEXT,
  shipping_label_url TEXT,
  tracking_number    TEXT,
  notes              TEXT
);

-- 2. Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON pet_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_pet_orders_status     ON pet_orders (status);
CREATE INDEX IF NOT EXISTS idx_pet_orders_created_at ON pet_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pet_orders_order_id   ON pet_orders (order_id);

-- 4. Admin tasks table (used by command station)
CREATE TABLE IF NOT EXISTS admin_tasks (
  id          BIGSERIAL    PRIMARY KEY,
  text        TEXT         NOT NULL,
  done        BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ================================================================
--  Migrations for existing deployments — safe to re-run
-- ================================================================
ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS pet_species TEXT;

-- Address-verification flow (auth + capture pattern):
--   stripe_session_id        — used as the auth token by /api/order-status and /api/update-address
--   stripe_payment_intent    — needed to capture/cancel the auth in the webhook
--   verification_attempts    — capped at 5 retries on the success page before order is locked
--   verification_error       — last EasyPost error text, surfaced in success page + admin
-- Order statuses can include: pending, address_pending_verification, address_invalid,
--   paid, shipped, printed, completed, refunded, etc.
ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS stripe_session_id     TEXT;
ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS stripe_payment_intent TEXT;
ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS verification_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pet_orders ADD COLUMN IF NOT EXISTS verification_error    TEXT;

CREATE INDEX IF NOT EXISTS idx_pet_orders_stripe_session_id ON pet_orders (stripe_session_id);

-- ================================================================
--  Done! Tables: pet_orders, admin_tasks
-- ================================================================
