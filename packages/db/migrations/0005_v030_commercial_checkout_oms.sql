-- =============================================================================
-- Super Ecommerce — 0005: v0.3.0 Commercial Checkout, Persistent Carts,
-- Stripe PaymentIntents & OMS Order Editing Schema
-- =============================================================================
-- Compatible with PostgreSQL 16.15+ / 17+ and OfflinePgPool:
-- 1. Customer Auth Credentials & Shipping Address Book (`customer_credentials`, `customer_addresses`)
-- 2. Persistent Multi-Channel Guest & Member Carts (`carts`, `cart_lines`) with Guest-Merge audit
-- 3. Stripe PaymentIntent Async State Machine (`payment_intents`: 3DS, Auth/Capture, Refunds)
-- 4. OMS Pre-Fulfillment Order Editing Ledger (`order_edits`) + Subledger `ORDER_EDIT_DELTA`
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. C-END CUSTOMER AUTHENTICATION & SHIPPING ADDRESS BOOK
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_credentials (
    customer_id TEXT PRIMARY KEY REFERENCES customers(customer_id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_addresses (
    address_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT 'Shipping',
    recipient_name TEXT NOT NULL,
    line1 TEXT NOT NULL,
    line2 TEXT,
    city TEXT NOT NULL,
    postal_code TEXT NOT NULL,
    country_code CHAR(2) NOT NULL,
    phone TEXT,
    is_default_shipping BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer
    ON customer_addresses (customer_id, is_default_shipping DESC);

-- -----------------------------------------------------------------------------
-- 2. PERSISTENT MULTI-CHANNEL GUEST & MEMBER CARTS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carts (
    cart_id TEXT PRIMARY KEY,
    channel_slug TEXT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    tax_mode TEXT NOT NULL DEFAULT 'TAX_EXCLUSIVE'
        CHECK (tax_mode IN ('TAX_EXCLUSIVE', 'TAX_INCLUSIVE')),
    customer_id TEXT REFERENCES customers(customer_id) ON DELETE SET NULL,
    guest_token TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'MERGED', 'CHECKED_OUT', 'ABANDONED')),
    merged_into_cart_id TEXT,
    shipping_address_json JSONB,
    voucher_code TEXT,
    voucher_discount_json JSONB,
    shipping_base_amount BIGINT NOT NULL DEFAULT 0 CHECK (shipping_base_amount >= 0),
    shipping_tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (shipping_tax_rate_bps >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_carts_customer_active
    ON carts (customer_id, channel_slug)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_carts_guest_active
    ON carts (guest_token, channel_slug)
    WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS cart_lines (
    id TEXT PRIMARY KEY,
    cart_id TEXT NOT NULL REFERENCES carts(cart_id) ON DELETE CASCADE,
    line_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    title TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    base_unit_price BIGINT NOT NULL CHECK (base_unit_price >= 0),
    tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0),
    tier_prices_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    line_discounts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    unit_cost_amount BIGINT,
    min_margin_bps INTEGER NOT NULL DEFAULT 0 CHECK (min_margin_bps >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cart_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_cart_lines_cart_id
    ON cart_lines (cart_id);

-- -----------------------------------------------------------------------------
-- 3. STRIPE PAYMENT INTENTS (Two-Phase Auth/Capture, 3DS & Async Webhooks)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_intents (
    payment_intent_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    checkout_id TEXT NOT NULL,
    order_id TEXT,
    customer_id TEXT,
    channel_slug TEXT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    amount_capturable BIGINT NOT NULL DEFAULT 0 CHECK (amount_capturable >= 0),
    amount_received BIGINT NOT NULL DEFAULT 0 CHECK (amount_received >= 0),
    amount_refunded BIGINT NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
    capture_method TEXT NOT NULL DEFAULT 'automatic'
        CHECK (capture_method IN ('automatic', 'manual')),
    status TEXT NOT NULL
        CHECK (status IN (
            'requires_payment_method',
            'requires_confirmation',
            'requires_action',
            'requires_capture',
            'succeeded',
            'canceled'
        )),
    client_secret TEXT NOT NULL,
    payment_method_token TEXT,
    next_action_redirect_url TEXT,
    provider_mode TEXT NOT NULL DEFAULT 'LOCAL_SIMULATOR'
        CHECK (provider_mode IN ('STRIPE_LIVE_API', 'LOCAL_SIMULATOR')),
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_checkout
    ON payment_intents (checkout_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. OMS PRE-FULFILLMENT ORDER EDITS & SUBLEDGER REFERENCE EXTENSION
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_edits (
    edit_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    edited_by TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    previous_gross_amount BIGINT NOT NULL CHECK (previous_gross_amount >= 0),
    revised_gross_amount BIGINT NOT NULL CHECK (revised_gross_amount >= 0),
    delta_gross_amount BIGINT NOT NULL,
    settlement_kind TEXT NOT NULL
        CHECK (settlement_kind IN ('NO_FINANCIAL_DELTA', 'INCREMENTAL_CAPTURE', 'PARTIAL_REFUND')),
    settlement_transaction_id TEXT,
    diff_payload_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_edits_order_id
    ON order_edits (order_id, created_at DESC);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ledger_journal_entries_reference_type_check'
          AND conrelid = 'public.ledger_journal_entries'::regclass
    ) THEN
        ALTER TABLE ledger_journal_entries
            DROP CONSTRAINT ledger_journal_entries_reference_type_check;
    END IF;
    ALTER TABLE ledger_journal_entries
        ADD CONSTRAINT ledger_journal_entries_reference_type_check
        CHECK (reference_type IN (
            'ORDER_CAPTURE',
            'RMA_REFUND',
            'ORDER_EDIT_DELTA',
            'STORE_CREDIT_TOPUP',
            'MANUAL_ADJUSTMENT'
        ));
END $$;

COMMIT;
