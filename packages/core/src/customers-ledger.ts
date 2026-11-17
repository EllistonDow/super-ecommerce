/**
 * `@super-ecommerce/core` — PostgreSQL 17 Primary Customer Store & Append-Only Store Credit Ledger.
 *
 * Invariants:
 * - Direct execution on PostgreSQL 17 `customers` and `store_credit_ledger` tables.
 * - Customer store credit balance is append-only with strict non-negative invariant:
 *   CHECK (balance_after >= 0) enforced at the database engine level.
 * - Atomic customer row locking (`SELECT customer_id FROM customers WHERE customer_id = $1 FOR UPDATE`)
 *   prevents concurrent overdraft race conditions.
 * - Satisfies the `StoreCreditLedger` interface required by `completeCheckoutWorkflow`,
 *   `rmaRefundWorkflow`, and `orderFulfillmentWorkflow`.
 */

import { randomUUID } from "node:crypto";
import type { PgPoolLike, PgTxClient } from "@super-ecommerce/db";
import type { StoreCreditLedger } from "./complete-checkout-workflow.ts";

let ledgerSeq = 0n;
function generateLedgerEntryId(): string {
  ledgerSeq += 1n;
  const timeMs = Date.now().toString(10).padStart(14, "0");
  const seqStr = (ledgerSeq % 1_000_000n).toString(10).padStart(6, "0");
  const rand = randomUUID().replace(/-/g, "").slice(0, 8);
  return `scl_${timeMs}_${seqStr}_${rand}`;
}

export interface CustomerRecord {
  readonly customerId: string;
  readonly email: string;
  readonly fullName: string;
  readonly defaultChannelSlug: string;
  readonly currencyCode: string;
  readonly note?: string;
  readonly storeCreditBalance: bigint;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoreCreditEntryRecord {
  readonly entryId: string;
  readonly customerId: string;
  readonly currencyCode: string;
  readonly deltaAmount: bigint;
  readonly balanceAfter: bigint;
  readonly reason: string;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly createdAt: string;
}

export interface CreateCustomerInput {
  readonly customerId?: string;
  readonly email: string;
  readonly fullName: string;
  readonly defaultChannelSlug?: string;
  readonly currencyCode?: string;
  readonly note?: string;
}

export interface AddStoreCreditInput {
  readonly customerId: string;
  readonly amount: bigint | number;
  readonly currencyCode?: string;
  readonly reason: string;
  readonly referenceType?: string;
  readonly referenceId?: string;
}

export class PgCustomersService implements StoreCreditLedger {
  private readonly pgPool: PgPoolLike;

  constructor(pgPool: PgPoolLike) {
    this.pgPool = pgPool;
  }

  private async runInTx<T>(
    tx: PgTxClient | undefined,
    callback: (client: PgTxClient) => Promise<T>
  ): Promise<T> {
    return tx ? tx.withTransaction(callback) : this.pgPool.withTransaction(callback);
  }

  async createCustomer(
    input: CreateCustomerInput,
    tx?: PgTxClient
  ): Promise<CustomerRecord> {
    const customerId = input.customerId ?? `cust_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const nowIso = new Date().toISOString();
    const channelSlug = input.defaultChannelSlug ?? "us-retail";
    const currency = (input.currencyCode ?? "USD").toUpperCase();

    return await this.runInTx(tx, async (q) => {
      await q.query(
        `INSERT INTO customers (
          customer_id, email, full_name, default_channel_slug, currency_code, note, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
        [
          customerId,
          input.email.toLowerCase().trim(),
          input.fullName.trim(),
          channelSlug,
          currency,
          input.note ?? null,
          nowIso,
          nowIso,
        ]
      );

      return {
        customerId,
        email: input.email.toLowerCase().trim(),
        fullName: input.fullName.trim(),
        defaultChannelSlug: channelSlug,
        currencyCode: currency,
        note: input.note,
        storeCreditBalance: 0n,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
    });
  }

  async getCustomer(
    customerId: string,
    tx?: PgTxClient
  ): Promise<CustomerRecord | null> {
    return await this.runInTx(tx, async (q) => {
      const res = await q.query<{
        customer_id: string;
        email: string;
        full_name: string;
        default_channel_slug: string;
        currency_code: string;
        note: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT customer_id, email, full_name, default_channel_slug, currency_code, note, created_at, updated_at
         FROM customers
         WHERE customer_id = $1`,
        [customerId]
      );

      if (res.rows.length === 0) return null;
      const row = res.rows[0]!;
      const balance = await this.getBalance(customerId, q);

      return {
        customerId: row.customer_id,
        email: row.email,
        fullName: row.full_name,
        defaultChannelSlug: row.default_channel_slug,
        currencyCode: row.currency_code,
        note: row.note ?? undefined,
        storeCreditBalance: balance,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async getCustomerByEmail(
    email: string,
    tx?: PgTxClient
  ): Promise<CustomerRecord | null> {
    return await this.runInTx(tx, async (q) => {
      const res = await q.query<{ customer_id: string }>(
        `SELECT customer_id FROM customers WHERE email = $1`,
        [email.toLowerCase().trim()]
      );
      if (res.rows.length === 0) return null;
      return await this.getCustomer(res.rows[0]!.customer_id, q);
    });
  }

  async listCustomers(
    limit = 50,
    tx?: PgTxClient
  ): Promise<readonly CustomerRecord[]> {
    return await this.runInTx(tx, async (q) => {
      const res = await q.query<{
        customer_id: string;
        email: string;
        full_name: string;
        default_channel_slug: string;
        currency_code: string;
        note: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT customer_id, email, full_name, default_channel_slug, currency_code, note, created_at, updated_at
         FROM customers
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );

      const customers: CustomerRecord[] = [];
      for (const row of res.rows) {
        const balance = await this.getBalance(row.customer_id, q);
        customers.push({
          customerId: row.customer_id,
          email: row.email,
          fullName: row.full_name,
          defaultChannelSlug: row.default_channel_slug,
          currencyCode: row.currency_code,
          note: row.note ?? undefined,
          storeCreditBalance: balance,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }
      return customers;
    });
  }

  async getBalance(customerId: string, tx?: PgTxClient): Promise<bigint> {
    return await this.runInTx(tx, async (q) => {
      const res = await q.query<{ balance_after: string | number | bigint }>(
        `SELECT balance_after
         FROM store_credit_ledger
         WHERE customer_id = $1
         ORDER BY entry_id DESC
         LIMIT 1`,
        [customerId]
      );

      if (res.rows.length === 0) return 0n;
      return BigInt(res.rows[0]!.balance_after);
    });
  }

  async addStoreCredit(
    input: AddStoreCreditInput,
    tx?: PgTxClient
  ): Promise<StoreCreditEntryRecord> {
    const delta = BigInt(input.amount);
    if (delta <= 0n) {
      throw new Error(`Store credit addition amount must be strictly positive, received ${delta}`);
    }

    return await this.runInTx(tx, async (q) => {
      // Lock the customer row to serialize ledger mutations
      const lockRes = await q.query<{ customer_id: string; currency_code: string }>(
        `SELECT customer_id, currency_code FROM customers WHERE customer_id = $1 FOR UPDATE`,
        [input.customerId]
      );
      if (lockRes.rows.length === 0) {
        throw new Error(`Customer '${input.customerId}' not found in PostgreSQL store`);
      }

      const currentBalance = await this.getBalance(input.customerId, q);
      const balanceAfter = currentBalance + delta;
      const entryId = generateLedgerEntryId();
      const nowIso = new Date().toISOString();
      const currency = input.currencyCode ?? lockRes.rows[0]!.currency_code;
      const refType = input.referenceType ?? "MANUAL_ADJUSTMENT";
      const refId = input.referenceId ?? `ref_${Date.now()}`;

      await q.query(
        `INSERT INTO store_credit_ledger (
          entry_id, customer_id, currency_code, delta_amount, balance_after, reason, reference_type, reference_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
        [
          entryId,
          input.customerId,
          currency,
          delta,
          balanceAfter,
          input.reason,
          refType,
          refId,
          nowIso,
        ]
      );

      return {
        entryId,
        customerId: input.customerId,
        currencyCode: currency,
        deltaAmount: delta,
        balanceAfter,
        reason: input.reason,
        referenceType: refType,
        referenceId: refId,
        createdAt: nowIso,
      };
    });
  }

  /**
   * Implements StoreCreditLedger.deduct
   * Atomically locks the customer row, verifies balance >= amount, inserts negative delta ledger entry.
   */
  async deduct(
    customerId: string,
    amount: bigint | number,
    referenceId?: string,
    tx?: PgTxClient
  ): Promise<{ ledgerTxId: string; balanceAfter: bigint }> {
    const deductAmount = BigInt(amount);
    if (deductAmount <= 0n) {
      return { ledgerTxId: "noop", balanceAfter: await this.getBalance(customerId, tx) };
    }

    return await this.runInTx(tx, async (q) => {
      const lockRes = await q.query<{ customer_id: string; currency_code: string }>(
        `SELECT customer_id, currency_code FROM customers WHERE customer_id = $1 FOR UPDATE`,
        [customerId]
      );
      if (lockRes.rows.length === 0) {
        throw new Error(`Customer '${customerId}' not found in PostgreSQL store`);
      }

      const currentBalance = await this.getBalance(customerId, q);
      if (currentBalance < deductAmount) {
        throw new Error(
          `Insufficient store credit balance: available ${currentBalance}, required ${deductAmount}`
        );
      }

      const balanceAfter = currentBalance - deductAmount;
      const entryId = generateLedgerEntryId();
      const nowIso = new Date().toISOString();
      const currency = lockRes.rows[0]!.currency_code;
      const refId = referenceId ?? `checkout_${Date.now()}`;

      await q.query(
        `INSERT INTO store_credit_ledger (
          entry_id, customer_id, currency_code, delta_amount, balance_after, reason, reference_type, reference_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
        [
          entryId,
          customerId,
          currency,
          -deductAmount,
          balanceAfter,
          "ORDER_CHECKOUT_REDEMPTION",
          "CHECKOUT_ORDER",
          refId,
          nowIso,
        ]
      );

      return {
        ledgerTxId: entryId,
        balanceAfter,
      };
    });
  }

  /**
   * Implements StoreCreditLedger.restore
   * Compensates a previously deducted store credit entry by inserting a positive delta ledger entry.
   */
  async restore(
    customerId: string,
    ledgerTxId: string,
    amount: bigint | number,
    tx?: PgTxClient
  ): Promise<void> {
    const restoreAmount = BigInt(amount);
    if (restoreAmount <= 0n) return;

    await this.runInTx(tx, async (q) => {
      const lockRes = await q.query<{ customer_id: string; currency_code: string }>(
        `SELECT customer_id, currency_code FROM customers WHERE customer_id = $1 FOR UPDATE`,
        [customerId]
      );
      if (lockRes.rows.length === 0) {
        throw new Error(`Customer '${customerId}' not found in PostgreSQL store`);
      }

      const currentBalance = await this.getBalance(customerId, q);
      const balanceAfter = currentBalance + restoreAmount;
      const entryId = generateLedgerEntryId();
      const nowIso = new Date().toISOString();
      const currency = lockRes.rows[0]!.currency_code;

      await q.query(
        `INSERT INTO store_credit_ledger (
          entry_id, customer_id, currency_code, delta_amount, balance_after, reason, reference_type, reference_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
        [
          entryId,
          customerId,
          currency,
          restoreAmount,
          balanceAfter,
          `RESTORE_COMPENSATION:${ledgerTxId}`,
          "WORKFLOW_COMPENSATION",
          ledgerTxId,
          nowIso,
        ]
      );
    });
  }

  async listLedgerEntries(
    customerId: string,
    limit = 50,
    tx?: PgTxClient
  ): Promise<readonly StoreCreditEntryRecord[]> {
    return await this.runInTx(tx, async (q) => {
      const res = await q.query<{
        entry_id: string;
        customer_id: string;
        currency_code: string;
        delta_amount: string | number | bigint;
        balance_after: string | number | bigint;
        reason: string;
        reference_type: string;
        reference_id: string;
        created_at: string;
      }>(
        `SELECT entry_id, customer_id, currency_code, delta_amount, balance_after, reason, reference_type, reference_id, created_at
         FROM store_credit_ledger
         WHERE customer_id = $1
         ORDER BY entry_id DESC
         LIMIT $2`,
        [customerId, limit]
      );

      return res.rows.map((r) => ({
        entryId: r.entry_id,
        customerId: r.customer_id,
        currencyCode: r.currency_code,
        deltaAmount: BigInt(r.delta_amount),
        balanceAfter: BigInt(r.balance_after),
        reason: r.reason,
        referenceType: r.reference_type,
        referenceId: r.reference_id,
        createdAt: r.created_at,
      }));
    });
  }
}
