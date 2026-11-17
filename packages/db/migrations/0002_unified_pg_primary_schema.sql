-- =============================================================================
-- Super Ecommerce — Phase 2 Unified PostgreSQL Primary Schema (0002)
-- =============================================================================
-- PostgreSQL 16.15+ compatible, idempotent DDL that elevates PostgreSQL to the
-- sole primary store across all bounded contexts:
--   - Schema version ledger (`schema_migrations`)
--   - Operational MSI slots & reservations (`msi_stock_slots`, `msi_stock_reservations`, `reservation_reaper_audit`)
--   - Shipping Zones & Channel/Warehouse links (`shipping_zones`, `shipping_zone_channels`, `shipping_zone_warehouses`)
--   - Orders & RMA returns reconciliation (`orders`, `order_returns`) with keyset cursor index
--   - Fulfillments (`order_fulfillments`, `order_fulfillment_lines`)
--   - Promotions & Vouchers (`promotions`, `vouchers`)
--   - Store Configurator state & deployment history (`store_config_state`, `store_config_deployments`)
--   - Customers & Store Credit Ledger (`customers`, `store_credit_ledger`)
--   - Dynamic Admin RBAC & Audit Logs (`admin_roles`, `admin_users`, `admin_audit_logs`)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. SCHEMA MIGRATIONS LEDGER
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. OPERATIONAL MSI SLOTS, RESERVATIONS & REAPER AUDIT
--    (Keeps UUID-keyed `stock_quants` / `stock_reservations` intact for benchmarks)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS msi_stock_slots (
    warehouse_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    priority_rank INTEGER NOT NULL DEFAULT 100,
    linked_to_channel BOOLEAN NOT NULL DEFAULT true,
    supports_shipping_zone BOOLEAN NOT NULL DEFAULT true,
    quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
    quantity_reserved INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
    quantity_allocated INTEGER NOT NULL DEFAULT 0 CHECK (quantity_allocated >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (warehouse_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_msi_stock_slots_variant_rank
    ON msi_stock_slots (variant_id, priority_rank);

CREATE TABLE IF NOT EXISTS msi_stock_reservations (
    reservation_id TEXT PRIMARY KEY,
    holder_id TEXT NOT NULL,
    warehouse_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'CONVERTED_TO_ALLOCATION', 'RELEASED', 'EXPIRED')),
    ttl_seconds INTEGER NOT NULL DEFAULT 900 CHECK (ttl_seconds >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msi_stock_reservations_holder
    ON msi_stock_reservations (holder_id, status);

CREATE INDEX IF NOT EXISTS idx_msi_stock_reservations_active_expiry
    ON msi_stock_reservations (expires_at)
    WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS reservation_reaper_audit (
    id TEXT PRIMARY KEY,
    reaped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expired_count INTEGER NOT NULL CHECK (expired_count >= 0),
    released_units INTEGER NOT NULL CHECK (released_units >= 0),
    details_json JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- -----------------------------------------------------------------------------
-- 3. SHIPPING ZONES & WAREHOUSE / CHANNEL INTERSECTION
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipping_zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    countries JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shipping_zone_channels (
    shipping_zone_id UUID NOT NULL REFERENCES shipping_zones(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    PRIMARY KEY (shipping_zone_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_shipping_zone_channels_channel_id
    ON shipping_zone_channels (channel_id);

CREATE TABLE IF NOT EXISTS shipping_zone_warehouses (
    shipping_zone_id UUID NOT NULL REFERENCES shipping_zones(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    PRIMARY KEY (shipping_zone_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_shipping_zone_warehouses_warehouse_id
    ON shipping_zone_warehouses (warehouse_id);

-- -----------------------------------------------------------------------------
-- 4. ORDERS & RMA RETURNS RECONCILIATION (Keyset Cursor + Full Payload + Fulfillment)
-- -----------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payload_json JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status TEXT NOT NULL DEFAULT 'UNFULFILLED';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE orders ALTER COLUMN payment_transaction_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'orders_fulfillment_status_check'
          AND conrelid = 'public.orders'::regclass
    ) THEN
        ALTER TABLE orders
            ADD CONSTRAINT orders_fulfillment_status_check
            CHECK (fulfillment_status IN ('UNFULFILLED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED'));
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'orders_payment_status_check'
          AND conrelid = 'public.orders'::regclass
    ) THEN
        ALTER TABLE orders DROP CONSTRAINT orders_payment_status_check;
    END IF;
    ALTER TABLE orders
        ADD CONSTRAINT orders_payment_status_check
        CHECK (payment_status IN ('AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'FAILED', 'VOIDED'));
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_created_id_desc
    ON orders (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_orders_channel_created_id_desc
    ON orders (channel_slug, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_orders_customer_created_desc
    ON orders (customer_id, created_at DESC)
    WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_returns (
    rma_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    channel_slug TEXT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    total_refund_gross_amount BIGINT NOT NULL CHECK (total_refund_gross_amount >= 0),
    payment_gateway_refund_amount BIGINT NOT NULL CHECK (payment_gateway_refund_amount >= 0),
    store_credit_refund_amount BIGINT NOT NULL CHECK (store_credit_refund_amount >= 0),
    payload_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_returns_order_id
    ON order_returns (order_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 5. ORDER FULFILLMENTS (Shipment Dispatch & Line Quantities)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_fulfillments (
    fulfillment_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    warehouse_id TEXT NOT NULL,
    tracking_number TEXT,
    carrier TEXT,
    status TEXT NOT NULL DEFAULT 'FULFILLED'
        CHECK (status IN ('FULFILLED', 'CANCELLED', 'RETURNED')),
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_fulfillments_order_id
    ON order_fulfillments (order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS order_fulfillment_lines (
    id TEXT PRIMARY KEY,
    fulfillment_id TEXT NOT NULL REFERENCES order_fulfillments(fulfillment_id) ON DELETE CASCADE,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    line_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    warehouse_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_order_fulfillment_lines_order_line
    ON order_fulfillment_lines (order_id, line_id);

-- -----------------------------------------------------------------------------
-- 6. B2B APPROVER FLEXIBILITY (Allow Backoffice Admin Principals + Buyer Approvers)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'b2b_purchase_orders_approver_id_fkey'
          AND conrelid = 'public.b2b_purchase_orders'::regclass
    ) THEN
        ALTER TABLE b2b_purchase_orders DROP CONSTRAINT b2b_purchase_orders_approver_id_fkey;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 7. DISCOUNTS (Promotions & Vouchers)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promotions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('CATALOGUE', 'ORDER')),
    discount_type TEXT NOT NULL CHECK (discount_type IN ('PERCENTAGE', 'FIXED')),
    discount_value BIGINT NOT NULL CHECK (discount_value >= 0),
    channel_slugs JSONB NOT NULL DEFAULT '[]'::jsonb,
    min_subtotal_amount BIGINT NOT NULL DEFAULT 0 CHECK (min_subtotal_amount >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vouchers (
    code TEXT PRIMARY KEY,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('PERCENTAGE', 'FIXED')),
    discount_value BIGINT NOT NULL CHECK (discount_value >= 0),
    channel_slug TEXT,
    min_order_amount BIGINT NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
    usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
    used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 8. STORE CONFIGURATOR STATE & DEPLOYMENT HISTORY
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store_config_state (
    config_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 1,
    desired_config_json JSONB NOT NULL,
    remote_state_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS store_config_deployments (
    deployment_id TEXT PRIMARY KEY,
    config_key TEXT NOT NULL REFERENCES store_config_state(config_key) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    executed_by TEXT NOT NULL,
    summary TEXT NOT NULL,
    diff_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_config_deployments_created
    ON store_config_deployments (config_key, created_at DESC);

-- -----------------------------------------------------------------------------
-- 9. CUSTOMERS & APPEND-ONLY STORE CREDIT LEDGER
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
    customer_id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    default_channel_slug TEXT NOT NULL DEFAULT 'us-retail',
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS store_credit_ledger (
    entry_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    delta_amount BIGINT NOT NULL,
    balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
    reason TEXT NOT NULL,
    reference_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_credit_ledger_customer
    ON store_credit_ledger (customer_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 10. DYNAMIC ADMIN RBAC ROLES, USERS & AUDIT LOGS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_roles (
    role_slug TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    permissions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_users (
    admin_id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role_slug TEXT NOT NULL REFERENCES admin_roles(role_slug) ON DELETE RESTRICT,
    password_hash TEXT NOT NULL,
    scope_summary TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_users_role_slug
    ON admin_users (role_slug);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    actor_email TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created
    ON admin_audit_logs (created_at DESC, id DESC);

COMMIT;
