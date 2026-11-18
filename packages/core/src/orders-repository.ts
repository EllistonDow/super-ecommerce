import {
  deserializeWithBigInt,
  serializeWithBigInt,
  type PgPoolLike,
  type PgQueryable,
  type PgTxClient,
} from "@super-ecommerce/db";
import type { OrderRecord } from "./complete-checkout-workflow.ts";
import type { OrderReturnRecord } from "./rma-refund-workflow.ts";

export type OrderFulfillmentStatus =
  | "UNFULFILLED"
  | "PARTIALLY_FULFILLED"
  | "FULFILLED"
  | "CANCELLED";

export class InvalidOrderCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOrderCursorError";
  }
}

export interface OrdersCursorPayload {
  readonly createdAt: string;
  readonly id: string;
}

export function encodeOrdersCursor(cursor: OrdersCursorPayload): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }),
    "utf8"
  ).toString("base64url");
}

export function decodeOrdersCursor(raw: string): OrdersCursorPayload {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new InvalidOrderCursorError("Order cursor must not be empty");
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(trimmed, "base64url").toString("utf8");
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new InvalidOrderCursorError("Malformed order pagination cursor");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new InvalidOrderCursorError("Invalid order pagination cursor payload");
  }
  const rec = parsed as Record<string, unknown>;
  const createdAt = rec["createdAt"];
  const id = rec["id"];
  if (
    typeof createdAt !== "string" ||
    !createdAt.trim() ||
    typeof id !== "string" ||
    !id.trim() ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    throw new InvalidOrderCursorError(
      "Order pagination cursor must include valid createdAt and id"
    );
  }
  return { createdAt, id };
}

export interface ListOrdersKeysetInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly direction?: "next" | "prev";
  readonly channelSlug?: string;
  readonly paymentStatus?: string;
  readonly fulfillmentStatus?: string;
  readonly customerId?: string;
  readonly q?: string;
}

export interface HydratedOrderEntry {
  readonly order: OrderRecord;
  readonly fulfillmentStatus: OrderFulfillmentStatus;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
  readonly returns: readonly OrderReturnRecord[];
  readonly cursorCreatedAt: string;
}

export interface ListOrdersKeysetResult {
  readonly items: readonly HydratedOrderEntry[];
  readonly limit: number;
  readonly hasMore: boolean;
  readonly hasPrev: boolean;
  readonly nextCursor: string | null;
  readonly prevCursor: string | null;
  readonly totalMatchingCount: number;
}

interface PgOrderRow {
  id: string;
  checkout_id: string;
  channel_slug: string;
  customer_id: string | null;
  currency_code: string;
  total_gross_amount: string;
  payment_transaction_id: string | null;
  payment_status: string;
  allocations_json: string | null;
  payload_json: string | null;
  fulfillment_status: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
}

function normalizeIso(raw: string): string {
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? raw : dt.toISOString();
}

function normalizeFulfillmentStatus(raw: string | null | undefined): OrderFulfillmentStatus {
  if (
    raw === "PARTIALLY_FULFILLED" ||
    raw === "FULFILLED" ||
    raw === "CANCELLED"
  ) {
    return raw;
  }
  return "UNFULFILLED";
}

function hydrateOrderRow(
  row: PgOrderRow,
  returns: readonly OrderReturnRecord[]
): HydratedOrderEntry {
  const fulfillmentStatus = normalizeFulfillmentStatus(row.fulfillment_status);
  let order: OrderRecord;
  if (row.payload_json) {
    const parsed = deserializeWithBigInt<OrderRecord>(row.payload_json);
    order = {
      ...parsed,
      orderId: parsed.orderId ?? row.id,
      checkoutId: parsed.checkoutId ?? row.checkout_id,
      channelSlug: parsed.channelSlug ?? row.channel_slug,
      customerId: parsed.customerId ?? row.customer_id ?? undefined,
      currencyCode: parsed.currencyCode ?? row.currency_code,
      paymentStatus:
        (row.payment_status as OrderRecord["paymentStatus"]) ??
        parsed.paymentStatus,
      paymentTransactionId:
        row.payment_transaction_id ?? parsed.paymentTransactionId,
      fulfillmentStatus,
      createdAt: parsed.createdAt ?? normalizeIso(row.created_at),
    };
  } else {
    const totalGross = BigInt(row.total_gross_amount || "0");
    const shipments = row.allocations_json
      ? deserializeWithBigInt<OrderRecord["shipments"]>(row.allocations_json)
      : [];
    order = {
      orderId: row.id,
      checkoutId: row.checkout_id,
      channelSlug: row.channel_slug,
      customerId: row.customer_id ?? undefined,
      currencyCode: row.currency_code,
      pricing: {
        currencyCode: row.currency_code,
        taxMode: "TAX_EXCLUSIVE",
        subtotalNetAmount: totalGross,
        subtotalGrossAmount: totalGross,
        shippingNetAmount: 0n,
        shippingGrossAmount: 0n,
        totalTaxAmount: 0n,
        totalDiscountAmount: 0n,
        totalNetAmount: totalGross,
        totalGrossAmount: totalGross,
        winningOrderDiscount: null,
        lines: [],
      },
      shipments,
      paymentStatus: row.payment_status as OrderRecord["paymentStatus"],
      paymentTransactionId: row.payment_transaction_id ?? undefined,
      paymentCapturedAmount: totalGross,
      fulfillmentStatus,
      createdAt: normalizeIso(row.created_at),
    };
  }

  return {
    order,
    fulfillmentStatus,
    cancelledAt: row.cancelled_at ? normalizeIso(row.cancelled_at) : undefined,
    cancelReason: row.cancel_reason ?? undefined,
    returns,
    cursorCreatedAt: row.created_at,
  };
}

export interface SkuRevenueAnalyticsRow {
  readonly variantId: string;
  readonly channelSlug: string;
  readonly currencyCode: string;
  readonly lineCount: number;
  readonly unitsSold: number;
  readonly totalDiscountAmount: bigint;
  readonly totalNetAmount: bigint;
  readonly totalTaxAmount: bigint;
  readonly totalGrossAmount: bigint;
}

export async function persistNormalizedOrderLines(
  order: OrderRecord,
  runner: PgQueryable
): Promise<void> {
  for (const line of order.pricing.lines) {
    const rowId = `ol_${order.orderId}_${line.lineId}`;
    await runner.query(
      `INSERT INTO order_lines (
         id, order_id, line_id, variant_id, channel_slug, currency_code,
         quantity, is_gift, effective_unit_price, line_discount_amount,
         allocated_order_discount_amount, net_amount, tax_amount, gross_amount, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14, $15::timestamptz
       )
       ON CONFLICT (order_id, line_id) DO UPDATE SET
         quantity = excluded.quantity,
         net_amount = excluded.net_amount,
         tax_amount = excluded.tax_amount,
         gross_amount = excluded.gross_amount`,
      [
        rowId,
        order.orderId,
        line.lineId,
        line.variantId,
        order.channelSlug,
        order.currencyCode,
        line.quantity,
        line.isGift,
        line.effectiveBaseUnitPrice.toString(),
        line.lineLevelDiscountAmount.toString(),
        line.allocatedOrderDiscountAmount.toString(),
        line.totalNetAmount.toString(),
        line.totalTaxAmount.toString(),
        line.totalGrossAmount.toString(),
        order.createdAt,
      ]
    );
  }
}

export class PgOrdersRepository {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  private runner(tx?: PgTxClient): PgQueryable {
    return tx ?? this.pool;
  }

  async upsertOrder(
    order: OrderRecord,
    options?: {
      readonly fulfillmentStatus?: OrderFulfillmentStatus;
      readonly cancelledAt?: string;
      readonly cancelReason?: string;
      readonly ignoreConflict?: boolean;
    },
    tx?: PgTxClient
  ): Promise<void> {
    const fulfillmentStatus =
      options?.fulfillmentStatus ?? order.fulfillmentStatus ?? "UNFULFILLED";
    const conflictClause = options?.ignoreConflict
      ? "ON CONFLICT (id) DO NOTHING"
      : `ON CONFLICT (id) DO UPDATE SET
           payment_status = excluded.payment_status,
           payment_transaction_id = excluded.payment_transaction_id,
           payload_json = excluded.payload_json,
           fulfillment_status = excluded.fulfillment_status,
           cancelled_at = excluded.cancelled_at,
           cancel_reason = excluded.cancel_reason,
           updated_at = excluded.updated_at`;

    await this.runner(tx).query(
      `INSERT INTO orders (
         id, checkout_id, channel_slug, customer_id,
         currency_code, total_gross_amount, payment_transaction_id,
         payment_status, allocations_json, payload_json,
         fulfillment_status, cancelled_at, cancel_reason, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, $9::jsonb, $10::jsonb,
         $11, $12::timestamptz, $13, $14::timestamptz, $14::timestamptz
       )
       ${conflictClause}`,
      [
        order.orderId,
        order.checkoutId,
        order.channelSlug,
        order.customerId ?? null,
        order.currencyCode,
        order.pricing.totalGrossAmount.toString(),
        order.paymentTransactionId ?? null,
        order.paymentStatus ?? "CAPTURED",
        serializeWithBigInt(order.shipments),
        serializeWithBigInt(order),
        fulfillmentStatus,
        options?.cancelledAt ?? null,
        options?.cancelReason ?? null,
        order.createdAt,
      ]
    );

    await persistNormalizedOrderLines(order, this.runner(tx));
  }

  async getSkuRevenueAnalytics(options?: {
    readonly channelSlug?: string;
  }): Promise<readonly SkuRevenueAnalyticsRow[]> {
    const hasChannel = Boolean(options?.channelSlug && options.channelSlug !== "ALL");
    const whereSql = hasChannel ? "WHERE channel_slug = $1" : "";
    const params = hasChannel ? [options!.channelSlug!] : [];

    const res = await this.pool.query<{
      variant_id: string;
      channel_slug: string;
      currency_code: string;
      quantity: string;
      line_discount_amount: string;
      allocated_order_discount_amount: string;
      net_amount: string;
      tax_amount: string;
      gross_amount: string;
    }>(
      `SELECT variant_id, channel_slug, currency_code, quantity,
              line_discount_amount, allocated_order_discount_amount,
              net_amount, tax_amount, gross_amount
       FROM order_lines
       ${whereSql}`,
      params
    );

    const groups = new Map<string, {
      variantId: string;
      channelSlug: string;
      currencyCode: string;
      lineCount: number;
      unitsSold: number;
      totalDiscountAmount: bigint;
      totalNetAmount: bigint;
      totalTaxAmount: bigint;
      totalGrossAmount: bigint;
    }>();

    for (const r of res.rows) {
      const key = `${r.channel_slug}::${r.currency_code}::${r.variant_id}`;
      const g = groups.get(key) ?? {
        variantId: r.variant_id,
        channelSlug: r.channel_slug,
        currencyCode: r.currency_code,
        lineCount: 0,
        unitsSold: 0,
        totalDiscountAmount: 0n,
        totalNetAmount: 0n,
        totalTaxAmount: 0n,
        totalGrossAmount: 0n,
      };
      g.lineCount += 1;
      g.unitsSold += Number(r.quantity);
      g.totalDiscountAmount +=
        BigInt(r.line_discount_amount) + BigInt(r.allocated_order_discount_amount);
      g.totalNetAmount += BigInt(r.net_amount);
      g.totalTaxAmount += BigInt(r.tax_amount);
      g.totalGrossAmount += BigInt(r.gross_amount);
      groups.set(key, g);
    }

    return [...groups.values()].sort((a, b) =>
      b.totalGrossAmount !== a.totalGrossAmount
        ? b.totalGrossAmount > a.totalGrossAmount
          ? 1
          : -1
        : a.variantId.localeCompare(b.variantId)
    );
  }

  async getOrder(
    orderId: string,
    tx?: PgTxClient
  ): Promise<HydratedOrderEntry | null> {
    const runner = this.runner(tx);
    const res = await runner.query<PgOrderRow>(
      `SELECT id, checkout_id, channel_slug, customer_id,
              currency_code, total_gross_amount, payment_transaction_id,
              payment_status, allocations_json, payload_json,
              fulfillment_status, cancelled_at, cancel_reason, created_at
       FROM orders
       WHERE id = $1`,
      [orderId]
    );
    const row = res.rows[0];
    if (!row) return null;

    const returnsRes = await runner.query<{ payload_json: string }>(
      `SELECT payload_json
       FROM order_returns
       WHERE order_id = $1
       ORDER BY created_at DESC`,
      [orderId]
    );
    const returns = returnsRes.rows.map((r) =>
      deserializeWithBigInt<OrderReturnRecord>(r.payload_json)
    );
    return hydrateOrderRow(row, returns);
  }

  private buildBaseFilters(input: ListOrdersKeysetInput): {
    whereParts: string[];
    params: unknown[];
  } {
    const whereParts: string[] = [];
    const params: unknown[] = [];

    if (input.channelSlug && input.channelSlug !== "ALL") {
      params.push(input.channelSlug);
      whereParts.push(`channel_slug = $${params.length}`);
    }
    if (input.paymentStatus && input.paymentStatus !== "ALL") {
      params.push(input.paymentStatus);
      whereParts.push(`payment_status = $${params.length}`);
    }
    if (input.fulfillmentStatus && input.fulfillmentStatus !== "ALL") {
      params.push(input.fulfillmentStatus);
      whereParts.push(`fulfillment_status = $${params.length}`);
    }
    if (input.customerId && input.customerId.trim()) {
      params.push(input.customerId.trim());
      whereParts.push(`customer_id = $${params.length}`);
    }
    if (input.q && input.q.trim()) {
      params.push(`%${input.q.trim()}%`);
      const p = `$${params.length}`;
      whereParts.push(
        `(id ILIKE ${p} OR checkout_id ILIKE ${p} OR channel_slug ILIKE ${p} OR COALESCE(customer_id, '') ILIKE ${p})`
      );
    }

    return { whereParts, params };
  }

  private async hasOrderRelativeToTuple(
    baseWhereParts: readonly string[],
    baseParams: readonly unknown[],
    comparator: "<" | ">",
    createdAt: string,
    id: string
  ): Promise<boolean> {
    const params = [...baseParams, createdAt, id];
    const pCreated = `$${params.length - 1}::timestamptz`;
    const pId = `$${params.length}`;
    const whereAll = [
      ...baseWhereParts,
      `(created_at, id) ${comparator} (${pCreated}, ${pId})`,
    ];
    const res = await this.pool.query<{ id: string }>(
      `SELECT id FROM orders WHERE ${whereAll.join(" AND ")} LIMIT 1`,
      params
    );
    return res.rows.length > 0;
  }

  async listOrdersKeyset(
    input: ListOrdersKeysetInput = {}
  ): Promise<ListOrdersKeysetResult> {
    const rawLimit = Number.isFinite(input.limit) ? Number(input.limit) : 20;
    const limit = Math.min(100, Math.max(1, Math.trunc(rawLimit)));
    const direction: "next" | "prev" =
      input.direction === "prev" ? "prev" : "next";
    const parsedCursor =
      input.cursor && input.cursor.trim()
        ? decodeOrdersCursor(input.cursor)
        : null;

    const { whereParts: baseWhereParts, params: baseParams } =
      this.buildBaseFilters(input);
    const baseWhereSql =
      baseWhereParts.length > 0 ? `WHERE ${baseWhereParts.join(" AND ")}` : "";

    const countRes = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM orders ${baseWhereSql}`,
      baseParams
    );
    const totalMatchingCount = Number(countRes.rows[0]?.cnt ?? 0);

    const rowWhereParts = [...baseWhereParts];
    const rowParams = [...baseParams];
    if (parsedCursor) {
      rowParams.push(parsedCursor.createdAt, parsedCursor.id);
      const pCreated = `$${rowParams.length - 1}::timestamptz`;
      const pId = `$${rowParams.length}`;
      rowWhereParts.push(
        direction === "prev"
          ? `(created_at, id) > (${pCreated}, ${pId})`
          : `(created_at, id) < (${pCreated}, ${pId})`
      );
    }

    const rowWhereSql =
      rowWhereParts.length > 0 ? `WHERE ${rowWhereParts.join(" AND ")}` : "";
    const orderSql =
      direction === "prev"
        ? `ORDER BY created_at ASC, id ASC`
        : `ORDER BY created_at DESC, id DESC`;
    rowParams.push(limit + 1);
    const limitParam = `$${rowParams.length}`;

    const rowsRes = await this.pool.query<PgOrderRow>(
      `SELECT id, checkout_id, channel_slug, customer_id,
              currency_code, total_gross_amount, payment_transaction_id,
              payment_status, allocations_json, payload_json,
              fulfillment_status, cancelled_at, cancel_reason, created_at
       FROM orders
       ${rowWhereSql}
       ${orderSql}
       LIMIT ${limitParam}`,
      rowParams
    );

    const rawRows = rowsRes.rows;
    let pageRows: PgOrderRow[];
    let hasMore: boolean;
    let hasPrev: boolean;

    if (direction === "prev") {
      hasPrev = rawRows.length > limit;
      pageRows = rawRows.slice(0, limit).reverse();
      if (pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1]!;
        hasMore = await this.hasOrderRelativeToTuple(
          baseWhereParts,
          baseParams,
          "<",
          last.created_at,
          last.id
        );
      } else {
        hasMore = false;
      }
    } else {
      hasMore = rawRows.length > limit;
      pageRows = rawRows.slice(0, limit);
      if (parsedCursor && pageRows.length > 0) {
        const first = pageRows[0]!;
        hasPrev = await this.hasOrderRelativeToTuple(
          baseWhereParts,
          baseParams,
          ">",
          first.created_at,
          first.id
        );
      } else {
        hasPrev = false;
      }
    }

    const returnsByOrderId = new Map<string, OrderReturnRecord[]>();
    if (pageRows.length > 0) {
      const orderIds = pageRows.map((r) => r.id);
      const placeholders = orderIds.map((_, idx) => `$${idx + 1}`).join(", ");
      const retRes = await this.pool.query<{
        order_id: string;
        payload_json: string;
      }>(
        `SELECT order_id, payload_json
         FROM order_returns
         WHERE order_id IN (${placeholders})
         ORDER BY created_at DESC`,
        orderIds
      );
      for (const r of retRes.rows) {
        const list = returnsByOrderId.get(r.order_id) ?? [];
        list.push(deserializeWithBigInt<OrderReturnRecord>(r.payload_json));
        returnsByOrderId.set(r.order_id, list);
      }
    }

    const items = pageRows.map((row) =>
      hydrateOrderRow(row, returnsByOrderId.get(row.id) ?? [])
    );

    const nextCursor =
      hasMore && items.length > 0
        ? encodeOrdersCursor({
            createdAt: items[items.length - 1]!.cursorCreatedAt,
            id: items[items.length - 1]!.order.orderId,
          })
        : null;
    const prevCursor =
      hasPrev && items.length > 0
        ? encodeOrdersCursor({
            createdAt: items[0]!.cursorCreatedAt,
            id: items[0]!.order.orderId,
          })
        : null;

    return {
      items,
      limit,
      hasMore,
      hasPrev,
      nextCursor,
      prevCursor,
      totalMatchingCount,
    };
  }
}
