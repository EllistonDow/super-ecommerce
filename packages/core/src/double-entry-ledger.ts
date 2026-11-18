/**
 * Immutable SOX-Grade Double-Entry Financial Subledger (`packages/core/src/double-entry-ledger.ts`).
 *
 * Enforces strict accounting balance (`SUM(DEBIT) === SUM(CREDIT)`) across:
 * - Order checkout capture (`CASH_GATEWAY_CLEARING` + `STORE_CREDIT_LIABILITY` debits
 *   vs `MERCHANT_SALES_REVENUE` + `SHIPPING_REVENUE` + `SALES_TAX_PAYABLE` credits)
 * - Partial/full RMA return refunds (`MERCHANT_SALES_REVENUE` + `SHIPPING_REVENUE` + `SALES_TAX_PAYABLE` debits
 *   vs `CASH_GATEWAY_CLEARING` + `STORE_CREDIT_LIABILITY` + `RESTOCKING_FEE_REVENUE` credits)
 * - Store credit top-ups (`CASH_GATEWAY_CLEARING` debit vs `STORE_CREDIT_LIABILITY` credit)
 */

import { randomUUID } from "node:crypto";
import type { MinorUnits } from "@super-ecommerce/kernel";
import type { PgPoolLike, PgQueryable, PgTxClient } from "@super-ecommerce/db";
import type { OrderRecord } from "./complete-checkout-workflow.ts";
import type { OrderReturnRecord } from "./rma-refund-workflow.ts";

export type LedgerAccountCode =
  | "CASH_GATEWAY_CLEARING"
  | "STORE_CREDIT_LIABILITY"
  | "MERCHANT_SALES_REVENUE"
  | "SALES_TAX_PAYABLE"
  | "SHIPPING_REVENUE"
  | "RESTOCKING_FEE_REVENUE"
  | "CUSTOMER_REFUND_CLEARING";

export type LedgerPostingDirection = "DEBIT" | "CREDIT";

export type JournalReferenceType =
  | "ORDER_CAPTURE"
  | "RMA_REFUND"
  | "ORDER_EDIT_DELTA"
  | "STORE_CREDIT_TOPUP"
  | "MANUAL_ADJUSTMENT";

export interface LedgerPostingInput {
  readonly accountCode: LedgerAccountCode;
  readonly direction: LedgerPostingDirection;
  readonly amount: MinorUnits;
}

export interface RecordJournalEntryInput {
  readonly idempotencyKey: string;
  readonly referenceType: JournalReferenceType;
  readonly referenceId: string;
  readonly channelSlug: string;
  readonly currencyCode: string;
  readonly memo?: string;
  readonly postings: readonly LedgerPostingInput[];
}

export interface LedgerJournalRecord {
  readonly journalId: string;
  readonly idempotencyKey: string;
  readonly referenceType: JournalReferenceType;
  readonly referenceId: string;
  readonly channelSlug: string;
  readonly currencyCode: string;
  readonly totalDebitAmount: MinorUnits;
  readonly totalCreditAmount: MinorUnits;
  readonly memo: string;
  readonly createdAt: string;
  readonly postings: readonly {
    readonly postingId: string;
    readonly accountCode: LedgerAccountCode;
    readonly direction: LedgerPostingDirection;
    readonly amount: MinorUnits;
  }[];
}

export interface AccountTrialBalanceRow {
  readonly currencyCode: string;
  readonly accountCode: LedgerAccountCode;
  readonly debitTotal: MinorUnits;
  readonly creditTotal: MinorUnits;
  readonly netDebitMinusCredit: MinorUnits;
}

export interface TrialBalanceReport {
  readonly currencyCode: string;
  readonly isBalanced: boolean;
  readonly grandTotalDebits: MinorUnits;
  readonly grandTotalCredits: MinorUnits;
  readonly accounts: readonly AccountTrialBalanceRow[];
}

export class UnbalancedJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnbalancedJournalError";
  }
}

export class PgDoubleEntryLedgerService {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  private async runInTx<T>(
    tx: PgTxClient | undefined,
    fn: (q: PgTxClient) => Promise<T>
  ): Promise<T> {
    return tx ? fn(tx) : this.pool.withTransaction(fn);
  }

  /**
   * Atomically persists an immutable, balanced double-entry journal and its postings.
   * Idempotent by `idempotencyKey`.
   */
  async recordJournalEntry(
    input: RecordJournalEntryInput,
    tx?: PgTxClient
  ): Promise<LedgerJournalRecord | null> {
    const nonZero = input.postings.filter((p) => p.amount > 0n);
    if (nonZero.some((p) => p.amount < 0n)) {
      throw new UnbalancedJournalError("Ledger posting amounts must be strictly positive");
    }
    if (nonZero.length === 0) {
      return null;
    }

    let totalDebit = 0n;
    let totalCredit = 0n;
    for (const p of nonZero) {
      if (p.direction === "DEBIT") totalDebit += p.amount;
      else totalCredit += p.amount;
    }

    if (totalDebit !== totalCredit) {
      throw new UnbalancedJournalError(
        `Double-entry invariant violated for '${input.referenceType}:${input.referenceId}': debits (${totalDebit}) !== credits (${totalCredit})`
      );
    }

    return await this.runInTx(tx, async (q) => {
      const existing = await this.getJournalByIdempotencyKey(input.idempotencyKey, q);
      if (existing) {
        return existing;
      }

      const journalId = `jrn_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const nowIso = new Date().toISOString();

      await q.query(
        `INSERT INTO ledger_journal_entries (
           journal_id, idempotency_key, reference_type, reference_id,
           channel_slug, currency_code, total_debit_amount, total_credit_amount,
           memo, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)`,
        [
          journalId,
          input.idempotencyKey,
          input.referenceType,
          input.referenceId,
          input.channelSlug,
          input.currencyCode,
          totalDebit.toString(),
          totalCredit.toString(),
          input.memo ?? "",
          nowIso,
        ]
      );

      const savedPostings: {
        postingId: string;
        accountCode: LedgerAccountCode;
        direction: LedgerPostingDirection;
        amount: MinorUnits;
      }[] = [];

      for (let i = 0; i < nonZero.length; i++) {
        const p = nonZero[i]!;
        const postingId = `pst_${journalId.slice(4)}_${String(i + 1).padStart(2, "0")}`;
        await q.query(
          `INSERT INTO ledger_postings (
             posting_id, journal_id, account_code, direction, amount, currency_code, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
          [
            postingId,
            journalId,
            p.accountCode,
            p.direction,
            p.amount.toString(),
            input.currencyCode,
            nowIso,
          ]
        );
        savedPostings.push({
          postingId,
          accountCode: p.accountCode,
          direction: p.direction,
          amount: p.amount,
        });
      }

      return {
        journalId,
        idempotencyKey: input.idempotencyKey,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        channelSlug: input.channelSlug,
        currencyCode: input.currencyCode,
        totalDebitAmount: totalDebit,
        totalCreditAmount: totalCredit,
        memo: input.memo ?? "",
        createdAt: nowIso,
        postings: savedPostings,
      };
    });
  }

  /**
   * Builds and posts the balanced double-entry journal for a captured Order.
   * Debits: `CASH_GATEWAY_CLEARING` + `STORE_CREDIT_LIABILITY`
   * Credits: `MERCHANT_SALES_REVENUE` (merchandise net) + `SHIPPING_REVENUE` (shipping net) + `SALES_TAX_PAYABLE`
   */
  async recordOrderCaptureJournal(
    order: OrderRecord,
    tx?: PgTxClient
  ): Promise<LedgerJournalRecord | null> {
    const storeCreditUsed = order.storeCreditRedeemedAmount ?? 0n;
    const cashCaptured =
      order.paymentCapturedAmount !== undefined
        ? order.paymentCapturedAmount
        : order.pricing.totalGrossAmount - storeCreditUsed;

    const shippingNet = order.pricing.shippingNetAmount;
    const merchandiseNet = order.pricing.totalNetAmount - shippingNet;
    const totalTax = order.pricing.totalTaxAmount;

    const postings: LedgerPostingInput[] = [];
    if (cashCaptured > 0n) {
      postings.push({
        accountCode: "CASH_GATEWAY_CLEARING",
        direction: "DEBIT",
        amount: cashCaptured,
      });
    }
    if (storeCreditUsed > 0n) {
      postings.push({
        accountCode: "STORE_CREDIT_LIABILITY",
        direction: "DEBIT",
        amount: storeCreditUsed,
      });
    }
    if (merchandiseNet > 0n) {
      postings.push({
        accountCode: "MERCHANT_SALES_REVENUE",
        direction: "CREDIT",
        amount: merchandiseNet,
      });
    }
    if (shippingNet > 0n) {
      postings.push({
        accountCode: "SHIPPING_REVENUE",
        direction: "CREDIT",
        amount: shippingNet,
      });
    }
    if (totalTax > 0n) {
      postings.push({
        accountCode: "SALES_TAX_PAYABLE",
        direction: "CREDIT",
        amount: totalTax,
      });
    }

    return await this.recordJournalEntry(
      {
        idempotencyKey: `ledger:order:${order.orderId}`,
        referenceType: "ORDER_CAPTURE",
        referenceId: order.orderId,
        channelSlug: order.channelSlug,
        currencyCode: order.currencyCode,
        memo: `Order ${order.orderId} capture (${order.channelSlug})`,
        postings,
      },
      tx
    );
  }

  /**
   * Builds and posts the balanced double-entry journal for an RMA Return Refund.
   *
   * Ceiling consumed (`totalGrossCeilingConsumed`) equals:
   *   `merchandiseNetConsumed + shippingRefundNet + taxConsumed`
   * And equals:
   *   `paymentGatewayRefundAmount + storeCreditRefundAmount + totalRestockingFeeAmount + unallocatedRefundOverflow`
   */
  async recordRmaRefundJournal(
    rma: OrderReturnRecord,
    tx?: PgTxClient
  ): Promise<LedgerJournalRecord | null> {
    const calc = rma.calculation;
    let lineNetConsumed = 0n;
    let lineTaxConsumed = 0n;
    for (const l of calc.lines) {
      lineNetConsumed += l.netCeilingConsumed;
      lineTaxConsumed += l.taxCeilingConsumed;
    }

    const shippingNet = calc.shippingRefundNetAmount;
    const totalTaxReversed = lineTaxConsumed + calc.shippingRefundTaxAmount;

    const postings: LedgerPostingInput[] = [];
    if (lineNetConsumed > 0n) {
      postings.push({
        accountCode: "MERCHANT_SALES_REVENUE",
        direction: "DEBIT",
        amount: lineNetConsumed,
      });
    }
    if (shippingNet > 0n) {
      postings.push({
        accountCode: "SHIPPING_REVENUE",
        direction: "DEBIT",
        amount: shippingNet,
      });
    }
    if (totalTaxReversed > 0n) {
      postings.push({
        accountCode: "SALES_TAX_PAYABLE",
        direction: "DEBIT",
        amount: totalTaxReversed,
      });
    }

    if (calc.paymentGatewayRefundAmount > 0n) {
      postings.push({
        accountCode: "CASH_GATEWAY_CLEARING",
        direction: "CREDIT",
        amount: calc.paymentGatewayRefundAmount,
      });
    }
    if (calc.storeCreditRefundAmount > 0n) {
      postings.push({
        accountCode: "STORE_CREDIT_LIABILITY",
        direction: "CREDIT",
        amount: calc.storeCreditRefundAmount,
      });
    }
    if (calc.totalRestockingFeeAmount > 0n) {
      postings.push({
        accountCode: "RESTOCKING_FEE_REVENUE",
        direction: "CREDIT",
        amount: calc.totalRestockingFeeAmount,
      });
    }
    if (calc.unallocatedRefundOverflow > 0n) {
      postings.push({
        accountCode: "CUSTOMER_REFUND_CLEARING",
        direction: "CREDIT",
        amount: calc.unallocatedRefundOverflow,
      });
    }

    return await this.recordJournalEntry(
      {
        idempotencyKey: `ledger:rma:${rma.rmaId}`,
        referenceType: "RMA_REFUND",
        referenceId: rma.rmaId,
        channelSlug: rma.channelSlug,
        currencyCode: rma.currencyCode,
        memo: `RMA ${rma.rmaId} for Order ${rma.orderId}`,
        postings,
      },
      tx
    );
  }

  async getJournalByIdempotencyKey(
    idempotencyKey: string,
    runner?: PgQueryable
  ): Promise<LedgerJournalRecord | null> {
    const q = runner ?? this.pool;
    const jRes = await q.query<{
      journal_id: string;
      idempotency_key: string;
      reference_type: JournalReferenceType;
      reference_id: string;
      channel_slug: string;
      currency_code: string;
      total_debit_amount: string;
      total_credit_amount: string;
      memo: string;
      created_at: string;
    }>(
      `SELECT journal_id, idempotency_key, reference_type, reference_id,
              channel_slug, currency_code, total_debit_amount, total_credit_amount,
              memo, created_at
       FROM ledger_journal_entries
       WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    const j = jRes.rows[0];
    if (!j) return null;

    const pRes = await q.query<{
      posting_id: string;
      account_code: LedgerAccountCode;
      direction: LedgerPostingDirection;
      amount: string;
    }>(
      `SELECT posting_id, account_code, direction, amount
       FROM ledger_postings
       WHERE journal_id = $1
       ORDER BY posting_id ASC`,
      [j.journal_id]
    );

    return {
      journalId: j.journal_id,
      idempotencyKey: j.idempotency_key,
      referenceType: j.reference_type,
      referenceId: j.reference_id,
      channelSlug: j.channel_slug,
      currencyCode: j.currency_code,
      totalDebitAmount: BigInt(j.total_debit_amount),
      totalCreditAmount: BigInt(j.total_credit_amount),
      memo: j.memo,
      createdAt: j.created_at,
      postings: pRes.rows.map((p) => ({
        postingId: p.posting_id,
        accountCode: p.account_code,
        direction: p.direction,
        amount: BigInt(p.amount),
      })),
    };
  }

  /**
   * Computes a real-time Trial Balance for `currencyCode` across all immutable postings,
   * mathematically verifying `grandTotalDebits === grandTotalCredits`.
   */
  async getTrialBalance(currencyCode = "USD"): Promise<TrialBalanceReport> {
    const res = await this.pool.query<{
      account_code: LedgerAccountCode;
      direction: LedgerPostingDirection;
      amount: string;
    }>(
      `SELECT account_code, direction, amount
       FROM ledger_postings
       WHERE currency_code = $1`,
      [currencyCode.toUpperCase().trim()]
    );

    const map = new Map<
      LedgerAccountCode,
      { debit: MinorUnits; credit: MinorUnits }
    >();
    let grandDebit = 0n;
    let grandCredit = 0n;

    for (const row of res.rows) {
      const amt = BigInt(row.amount);
      const entry = map.get(row.account_code) ?? { debit: 0n, credit: 0n };
      if (row.direction === "DEBIT") {
        entry.debit += amt;
        grandDebit += amt;
      } else {
        entry.credit += amt;
        grandCredit += amt;
      }
      map.set(row.account_code, entry);
    }

    const accounts: AccountTrialBalanceRow[] = [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([accountCode, totals]) => ({
        currencyCode: currencyCode.toUpperCase().trim(),
        accountCode,
        debitTotal: totals.debit,
        creditTotal: totals.credit,
        netDebitMinusCredit: totals.debit - totals.credit,
      }));

    return {
      currencyCode: currencyCode.toUpperCase().trim(),
      isBalanced: grandDebit === grandCredit,
      grandTotalDebits: grandDebit,
      grandTotalCredits: grandCredit,
      accounts,
    };
  }
}
