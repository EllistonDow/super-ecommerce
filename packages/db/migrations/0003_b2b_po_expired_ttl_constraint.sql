-- =============================================================================
-- Super Ecommerce — 0003: Ensure b2b_purchase_orders.status CHECK allows EXPIRED_TTL
-- =============================================================================
-- Early Phase 1 bootstraps created `b2b_purchase_orders` before `'EXPIRED_TTL'`
-- was added to the status CHECK constraint. Re-assert the canonical status set
-- idempotently so live PostgreSQL instances stay aligned with `0001` & `OfflinePgPool`.
-- =============================================================================

BEGIN;

ALTER TABLE b2b_purchase_orders
    DROP CONSTRAINT IF EXISTS b2b_purchase_orders_status_check;

ALTER TABLE b2b_purchase_orders
    ADD CONSTRAINT b2b_purchase_orders_status_check
    CHECK (status IN (
        'PENDING_APPROVAL',
        'APPROVED_AUTO',
        'APPROVED_BY_SUPERVISOR',
        'REJECTED_COMPANY_CREDIT_EXCEEDED',
        'REJECTED_BY_SUPERVISOR',
        'EXPIRED_TTL'
    ));

COMMIT;
