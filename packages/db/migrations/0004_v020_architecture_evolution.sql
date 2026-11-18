-- =============================================================================
-- Super Ecommerce — 0004: v0.2.0 Architecture Evolution Schema
-- =============================================================================
-- Compatible with PostgreSQL 16.15+ / 17+ and OfflinePgPool:
-- 1. Durable Saga Mutual-Exclusion Leases (`workflow_runs`: `locked_by`, `lease_expires_at`, `attempt_count`)
-- 2. Normalized Order Line Items (`order_lines`) for SQL SKU revenue/tax analytics
-- 3. Hot/Cold CQRS Projection Split (`catalog_availability_hot`) eliminating MVCC JSONB write amplification
-- 4. 16-Shard Slotted Flash-Sale Inventory (`msi_stock_shards`) eliminating hot-SKU single-row lock bottlenecks
-- 5. Immutable Double-Entry Financial Subledger (`ledger_journal_entries`, `ledger_postings`) with Debit == Credit invariant
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. SAGA WORKFLOW MUTUAL-EXCLUSION LEASES & ZOMBIE RECOVERY INDEX
-- -----------------------------------------------------------------------------
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_orphan_lease
    ON workflow_runs (lease_expires_at, updated_at)
    WHERE status IN ('RUNNING', 'COMPENSATING');

-- -----------------------------------------------------------------------------
-- 2. NORMALIZED ORDER LINE ITEMS (Replaces opaque JSON-only line analytics)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_lines (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    line_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    channel_slug TEXT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    is_gift BOOLEAN NOT NULL DEFAULT false,
    effective_unit_price BIGINT NOT NULL CHECK (effective_unit_price >= 0),
    line_discount_amount BIGINT NOT NULL DEFAULT 0 CHECK (line_discount_amount >= 0),
    allocated_order_discount_amount BIGINT NOT NULL DEFAULT 0 CHECK (allocated_order_discount_amount >= 0),
    net_amount BIGINT NOT NULL CHECK (net_amount >= 0),
    tax_amount BIGINT NOT NULL CHECK (tax_amount >= 0),
    gross_amount BIGINT NOT NULL CHECK (gross_amount >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (order_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_order_lines_order_id
    ON order_lines (order_id);

CREATE INDEX IF NOT EXISTS idx_order_lines_variant_channel
    ON order_lines (variant_id, channel_slug);

-- -----------------------------------------------------------------------------
-- 3. HOT/COLD CQRS PROJECTION SPLIT (Fixed-Width Stock Table for HOT Updates)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_availability_hot (
    channel_slug TEXT NOT NULL,
    product_id TEXT NOT NULL,
    is_in_stock BOOLEAN NOT NULL DEFAULT false,
    total_available_qty INTEGER NOT NULL DEFAULT 0 CHECK (total_available_qty >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_slug, product_id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_availability_hot_instock
    ON catalog_availability_hot (channel_slug, is_in_stock);

-- -----------------------------------------------------------------------------
-- 4. SLOTTED FLASH-SALE INVENTORY SHARDS (16-Way Sharded Row Locks)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS msi_stock_shards (
    warehouse_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    shard_id INTEGER NOT NULL CHECK (shard_id >= 0 AND shard_id < 64),
    quantity_available INTEGER NOT NULL DEFAULT 0 CHECK (quantity_available >= 0),
    quantity_allocated INTEGER NOT NULL DEFAULT 0 CHECK (quantity_allocated >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (warehouse_id, variant_id, shard_id)
);

CREATE INDEX IF NOT EXISTS idx_msi_stock_shards_available
    ON msi_stock_shards (warehouse_id, variant_id, shard_id)
    WHERE quantity_available > 0;

-- -----------------------------------------------------------------------------
-- 5. IMMUTABLE DOUBLE-ENTRY SUBLEDGER (SOX Financial Integrity)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_journal_entries (
    journal_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    reference_type TEXT NOT NULL
        CHECK (reference_type IN ('ORDER_CAPTURE', 'RMA_REFUND', 'STORE_CREDIT_TOPUP', 'MANUAL_ADJUSTMENT')),
    reference_id TEXT NOT NULL,
    channel_slug TEXT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    total_debit_amount BIGINT NOT NULL CHECK (total_debit_amount >= 0),
    total_credit_amount BIGINT NOT NULL CHECK (total_credit_amount >= 0),
    memo TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (total_debit_amount = total_credit_amount)
);

CREATE INDEX IF NOT EXISTS idx_ledger_journal_ref
    ON ledger_journal_entries (reference_type, reference_id);

CREATE TABLE IF NOT EXISTS ledger_postings (
    posting_id TEXT PRIMARY KEY,
    journal_id TEXT NOT NULL REFERENCES ledger_journal_entries(journal_id) ON DELETE RESTRICT,
    account_code TEXT NOT NULL
        CHECK (account_code IN (
            'CASH_GATEWAY_CLEARING',
            'STORE_CREDIT_LIABILITY',
            'MERCHANT_SALES_REVENUE',
            'SALES_TAX_PAYABLE',
            'SHIPPING_REVENUE',
            'RESTOCKING_FEE_REVENUE',
            'CUSTOMER_REFUND_CLEARING'
        )),
    direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency_code CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_postings_journal
    ON ledger_postings (journal_id);

CREATE INDEX IF NOT EXISTS idx_ledger_postings_currency_account
    ON ledger_postings (currency_code, account_code, direction);

COMMIT;
