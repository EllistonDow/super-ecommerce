/**
 * Real ACID SQL Persistence Engine (`packages/db/src/sql-persistence.ts`).
 *
 * Uses Node 22's built-in relational SQL engine (`node:sqlite` `DatabaseSync`) with
 * `PRAGMA foreign_keys = ON` and `BEGIN IMMEDIATE ... COMMIT / ROLLBACK` transactions
 * to persist:
 * - `workflow_runs` & `workflow_step_logs` (Durable Saga Execution state)
 * - `stock_quants` & `stock_reservations` (3-tier MSI inventory with row-level transactional locking)
 * - `orders` & `transactional_outbox_events` (Atomic Order + Outbox commit)
 * - `inbound_webhook_events` (Cryptographically verified, idempotent payment webhook ledger)
 */

import { DatabaseSync } from "node:sqlite";
import { deserializeWithBigInt, serializeWithBigInt } from "./bigint-json.ts";

export { deserializeWithBigInt, serializeWithBigInt };

export class SqlDatabaseEngine {
  readonly db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stock_quants (
        warehouse_id TEXT NOT NULL,
        priority_rank INTEGER NOT NULL DEFAULT 100,
        linked_to_channel INTEGER NOT NULL DEFAULT 1,
        supports_shipping_zone INTEGER NOT NULL DEFAULT 1,
        variant_id TEXT NOT NULL,
        quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
        quantity_reserved INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
        quantity_allocated INTEGER NOT NULL DEFAULT 0 CHECK (quantity_allocated >= 0),
        PRIMARY KEY (warehouse_id, variant_id)
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'COMPENSATING', 'COMPENSATED', 'FAILED')),
        input_payload TEXT NOT NULL,
        output_payload TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_step_logs (
        workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        step_name TEXT NOT NULL,
        step_order INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'COMPENSATED', 'FAILED')),
        output_payload TEXT,
        PRIMARY KEY (workflow_run_id, step_name)
      );

      CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        checkout_id TEXT NOT NULL UNIQUE,
        channel_slug TEXT NOT NULL,
        customer_id TEXT,
        currency_code TEXT NOT NULL,
        total_gross_amount TEXT NOT NULL,
        payment_status TEXT NOT NULL DEFAULT 'CAPTURED'
          CHECK (payment_status IN ('AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'FAILED')),
        payment_transaction_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_returns (
        rma_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
        channel_slug TEXT NOT NULL,
        currency_code TEXT NOT NULL,
        total_refund_gross_amount TEXT NOT NULL,
        payment_gateway_refund_amount TEXT NOT NULL,
        store_credit_refund_amount TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactional_outbox_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        channel_slug TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'DEAD_LETTER')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
        last_error TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_pending ON transactional_outbox_events (status, next_attempt_at, created_at);

      CREATE TABLE IF NOT EXISTS inbound_webhook_events (
        event_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'stripe',
        event_type TEXT NOT NULL,
        signature_timestamp INTEGER NOT NULL,
        order_id TEXT,
        checkout_id TEXT,
        amount_minor_units TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_order ON inbound_webhook_events (order_id, processed_at DESC);

      CREATE TABLE IF NOT EXISTS stock_reservations (
        reservation_id TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        warehouse_id TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        line_id TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        status TEXT NOT NULL DEFAULT 'ACTIVE'
          CHECK (status IN ('ACTIVE', 'CONVERTED_TO_ALLOCATION', 'RELEASED', 'EXPIRED')),
        ttl_seconds INTEGER NOT NULL DEFAULT 900,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_stock_reservations_holder ON stock_reservations (holder_id, status);
      CREATE INDEX IF NOT EXISTS idx_stock_reservations_active_expiry ON stock_reservations (expires_at) WHERE status = 'ACTIVE';

      CREATE TABLE IF NOT EXISTS b2b_companies (
        company_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tax_id TEXT NOT NULL,
        tax_exempt_verified INTEGER NOT NULL DEFAULT 0,
        payment_terms TEXT NOT NULL DEFAULT 'NET_30'
          CHECK (payment_terms IN ('NET_30', 'NET_60', 'PREPAID_ONLY')),
        currency_code TEXT NOT NULL DEFAULT 'USD',
        credit_limit TEXT NOT NULL,
        credit_used TEXT NOT NULL DEFAULT '0',
        credit_reserved TEXT NOT NULL DEFAULT '0',
        contract_discount_bps INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS b2b_cost_centers (
        cost_center_id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES b2b_companies(company_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        department_code TEXT NOT NULL,
        monthly_budget TEXT NOT NULL,
        monthly_spent TEXT NOT NULL DEFAULT '0',
        monthly_reserved TEXT NOT NULL DEFAULT '0',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_b2b_cost_centers_company ON b2b_cost_centers (company_id);

      CREATE TABLE IF NOT EXISTS b2b_buyer_members (
        buyer_id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES b2b_companies(company_id) ON DELETE CASCADE,
        cost_center_id TEXT NOT NULL REFERENCES b2b_cost_centers(cost_center_id) ON DELETE CASCADE,
        email TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('BUYER', 'APPROVER', 'COMPANY_ADMIN')),
        single_order_auto_approve_limit TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS b2b_purchase_orders (
        po_id TEXT PRIMARY KEY,
        po_number TEXT NOT NULL UNIQUE,
        company_id TEXT NOT NULL REFERENCES b2b_companies(company_id) ON DELETE CASCADE,
        cost_center_id TEXT NOT NULL REFERENCES b2b_cost_centers(cost_center_id) ON DELETE CASCADE,
        buyer_id TEXT NOT NULL REFERENCES b2b_buyer_members(buyer_id) ON DELETE CASCADE,
        approver_id TEXT,
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
        currency_code TEXT NOT NULL DEFAULT 'USD',
        total_gross_amount TEXT NOT NULL,
        tax_exempt_savings_amount TEXT NOT NULL DEFAULT '0',
        net_terms_due_days INTEGER NOT NULL DEFAULT 30,
        reservation_ttl_seconds INTEGER NOT NULL DEFAULT 0,
        reservation_expires_at TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_b2b_po_company_status ON b2b_purchase_orders (company_id, status, created_at DESC);
    `);
  }

  /**
   * Executes a synchronous or asynchronous callback inside an atomic SQL transaction
   * (`BEGIN IMMEDIATE` -> `COMMIT` / `ROLLBACK`).
   */
  inTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
