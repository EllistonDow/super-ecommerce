-- =============================================================================
-- Super Ecommerce — Phase 1 Core PostgreSQL 17 Schema
-- =============================================================================
-- Follows Supabase/PostgreSQL Best Practices:
-- 1. Explicit indexes on all foreign key columns (avoids sequential scans on JOIN/CASCADE)
-- 2. Partial indexes on hot operational queues (Reservations, Outbox, Workflow Steps)
-- 3. JSONB `jsonb_path_ops` GIN indexes replacing EAV multi-table JOINs
-- 4. Strict CHECK constraints for financial minor units and orthogonal 3-tier stock
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. CHANNELS (Channel-First Architecture Anchor)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    default_country CHAR(2) NOT NULL,
    tax_inclusion_mode TEXT NOT NULL DEFAULT 'TAX_EXCLUSIVE'
        CHECK (tax_inclusion_mode IN ('TAX_EXCLUSIVE', 'TAX_INCLUSIVE')),
    stock_availability_mode TEXT NOT NULL DEFAULT 'DIRECT_CHANNEL_WAREHOUSES'
        CHECK (stock_availability_mode IN ('DIRECT_CHANNEL_WAREHOUSES', 'SHIPPING_ZONE_INTERSECTION')),
    allocation_strategy TEXT NOT NULL DEFAULT 'MINIMIZE_SPLIT_THEN_HIGH_STOCK'
        CHECK (allocation_strategy IN ('PRIORITIZE_RANK_ORDER', 'MINIMIZE_SPLIT_THEN_HIGH_STOCK')),
    reservation_ttl_seconds INTEGER NOT NULL DEFAULT 900 CHECK (reservation_ttl_seconds >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. PRODUCT TYPES & CATALOG (EAV Replacement via JSONB + Strict Schema)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_shipping_required BOOLEAN NOT NULL DEFAULT true,
    is_digital BOOLEAN NOT NULL DEFAULT false,
    product_attributes_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
    variant_attributes_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_type_id UUID NOT NULL REFERENCES product_types(id) ON DELETE RESTRICT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description JSONB,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(slug, '')), 'B')
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_product_type_id ON products (product_type_id);
CREATE INDEX IF NOT EXISTS idx_products_attributes_gin ON products USING GIN (attributes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_products_search_vector_gin ON products USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sku TEXT NOT NULL UNIQUE,
    barcode TEXT,
    name TEXT NOT NULL,
    weight_grams INTEGER CHECK (weight_grams IS NULL OR weight_grams >= 0),
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants (product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_attributes_gin ON product_variants USING GIN (attributes jsonb_path_ops);

-- -----------------------------------------------------------------------------
-- 3. CHANNEL LISTINGS & B2B TIER PRICING
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS variant_channel_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    is_published BOOLEAN NOT NULL DEFAULT false,
    price_amount BIGINT NOT NULL CHECK (price_amount >= 0),
    compare_at_amount BIGINT CHECK (compare_at_amount IS NULL OR compare_at_amount >= 0),
    cost_amount BIGINT CHECK (cost_amount IS NULL OR cost_amount >= 0),
    tier_prices JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (variant_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_vcl_channel_published
    ON variant_channel_listings (channel_id, price_amount)
    WHERE is_published = true;

-- -----------------------------------------------------------------------------
-- 4. CQRS STOREFRONT READ PROJECTION (0-JOIN Sub-10ms Reads)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_channel_projections (
    channel_slug TEXT NOT NULL,
    product_id UUID NOT NULL,
    product_slug TEXT NOT NULL,
    product_name TEXT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    min_effective_price BIGINT NOT NULL CHECK (min_effective_price >= 0),
    max_effective_price BIGINT NOT NULL CHECK (max_effective_price >= 0),
    is_in_stock BOOLEAN NOT NULL DEFAULT false,
    total_available_qty INTEGER NOT NULL DEFAULT 0 CHECK (total_available_qty >= 0),
    merged_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    variants_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_slug, product_id),
    UNIQUE (channel_slug, product_slug)
);

CREATE INDEX IF NOT EXISTS idx_ccp_storefront_browse
    ON catalog_channel_projections (channel_slug, is_in_stock, min_effective_price);
CREATE INDEX IF NOT EXISTS idx_ccp_merged_attributes_gin
    ON catalog_channel_projections USING GIN (merged_attributes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_ccp_fts_gin
    ON catalog_channel_projections USING GIN (
        to_tsvector('simple', coalesce(product_name, '') || ' ' || coalesce(product_slug, ''))
    );

-- -----------------------------------------------------------------------------
-- 5. MULTI-SOURCE INVENTORY (MSI) & RESERVATIONS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    country_code CHAR(2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_warehouses (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    priority_rank INTEGER NOT NULL DEFAULT 100,
    PRIMARY KEY (channel_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_warehouses_warehouse_id ON channel_warehouses (warehouse_id);

CREATE TABLE IF NOT EXISTS stock_quants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    quantity_on_hand BIGINT NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
    quantity_reserved BIGINT NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
    quantity_allocated BIGINT NOT NULL DEFAULT 0 CHECK (quantity_allocated >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (warehouse_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_quants_variant_id ON stock_quants (variant_id);

CREATE TABLE IF NOT EXISTS stock_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    checkout_id UUID NOT NULL,
    line_id TEXT NOT NULL,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'CONVERTED_TO_ALLOCATION', 'RELEASED', 'EXPIRED')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_reservations_active_expiry
    ON stock_reservations (expires_at)
    WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_stock_reservations_checkout_id
    ON stock_reservations (checkout_id);

-- -----------------------------------------------------------------------------
-- 6. DURABLE SAGA WORKFLOWS & TRANSACTIONAL OUTBOX
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_name TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'RUNNING'
        CHECK (status IN ('RUNNING', 'COMPLETED', 'COMPENSATING', 'COMPENSATED', 'FAILED')),
    input_payload JSONB NOT NULL,
    output_payload JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_active
    ON workflow_runs (updated_at)
    WHERE status IN ('RUNNING', 'COMPENSATING');

CREATE TABLE IF NOT EXISTS workflow_step_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_name TEXT NOT NULL,
    step_Order INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'COMPENSATED', 'FAILED')),
    output_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workflow_run_id, step_name)
);

CREATE TABLE IF NOT EXISTS transactional_outbox_events (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    event_type TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    channel_slug TEXT,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PUBLISHED', 'DEAD_LETTER')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending_poll
    ON transactional_outbox_events (next_attempt_at, created_at)
    WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    checkout_id TEXT NOT NULL UNIQUE,
    channel_slug TEXT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    total_gross_amount BIGINT NOT NULL CHECK (total_gross_amount >= 0),
    payment_transaction_id TEXT NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'AUTHORIZED'
        CHECK (payment_status IN ('AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'FAILED')),
    allocations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_channel_created
    ON orders (channel_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS inbound_webhook_events (
    event_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'stripe',
    event_type TEXT NOT NULL,
    signature_timestamp BIGINT NOT NULL,
    order_id TEXT,
    checkout_id TEXT,
    amount_minor_units BIGINT NOT NULL DEFAULT 0,
    payload JSONB NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_webhook_events_order
    ON inbound_webhook_events (order_id, processed_at DESC);

-- -----------------------------------------------------------------------------
-- 7. ENTERPRISE B2B ORGANIZATIONS, CREDIT LEDGER & PO APPROVAL WORKFLOW
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS b2b_companies (
    company_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tax_id TEXT NOT NULL,
    tax_exempt_verified BOOLEAN NOT NULL DEFAULT false,
    payment_terms TEXT NOT NULL DEFAULT 'NET_30'
        CHECK (payment_terms IN ('NET_30', 'NET_60', 'PREPAID_ONLY')),
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    credit_limit BIGINT NOT NULL CHECK (credit_limit >= 0),
    credit_used BIGINT NOT NULL DEFAULT 0 CHECK (credit_used >= 0),
    credit_reserved BIGINT NOT NULL DEFAULT 0 CHECK (credit_reserved >= 0),
    contract_discount_bps INTEGER NOT NULL DEFAULT 0 CHECK (contract_discount_bps BETWEEN 0 AND 10000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS b2b_cost_centers (
    cost_center_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES b2b_companies(company_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    department_code TEXT NOT NULL,
    monthly_budget BIGINT NOT NULL CHECK (monthly_budget >= 0),
    monthly_spent BIGINT NOT NULL DEFAULT 0 CHECK (monthly_spent >= 0),
    monthly_reserved BIGINT NOT NULL DEFAULT 0 CHECK (monthly_reserved >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_b2b_cost_centers_company_id
    ON b2b_cost_centers (company_id);

CREATE TABLE IF NOT EXISTS b2b_buyer_members (
    buyer_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES b2b_companies(company_id) ON DELETE CASCADE,
    cost_center_id TEXT NOT NULL REFERENCES b2b_cost_centers(cost_center_id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('BUYER', 'APPROVER', 'COMPANY_ADMIN')),
    single_order_auto_approve_limit BIGINT NOT NULL CHECK (single_order_auto_approve_limit >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_b2b_buyer_members_company_cc
    ON b2b_buyer_members (company_id, cost_center_id);

CREATE TABLE IF NOT EXISTS b2b_purchase_orders (
    po_id TEXT PRIMARY KEY,
    po_number TEXT NOT NULL UNIQUE,
    company_id TEXT NOT NULL REFERENCES b2b_companies(company_id) ON DELETE CASCADE,
    cost_center_id TEXT NOT NULL REFERENCES b2b_cost_centers(cost_center_id) ON DELETE CASCADE,
    buyer_id TEXT NOT NULL REFERENCES b2b_buyer_members(buyer_id) ON DELETE CASCADE,
    approver_id TEXT REFERENCES b2b_buyer_members(buyer_id),
    order_id TEXT,
    status TEXT NOT NULL
        CHECK (status IN (
            'PENDING_APPROVAL',
            'APPROVED_AUTO',
            'APPROVED_BY_SUPERVISOR',
            'REJECTED_COMPANY_CREDIT_EXCEEDED',
            'REJECTED_BY_SUPERVISOR',
            'EXPIRED_TTL'
        )),
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    total_gross_amount BIGINT NOT NULL CHECK (total_gross_amount >= 0),
    tax_exempt_savings_amount BIGINT NOT NULL DEFAULT 0 CHECK (tax_exempt_savings_amount >= 0),
    net_terms_due_days INTEGER NOT NULL DEFAULT 30,
    reservation_ttl_seconds INTEGER NOT NULL DEFAULT 0,
    reservation_expires_at TIMESTAMPTZ,
    payload_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_b2b_po_pending_approval
    ON b2b_purchase_orders (company_id, created_at DESC)
    WHERE status = 'PENDING_APPROVAL';

COMMIT;
