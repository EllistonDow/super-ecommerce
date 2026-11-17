/**
 * `order-fulfillment-workflow` - Multi-Step Sagas for Fulfillment Dispatch and Order Cancellation.
 *
 * Guarantees:
 * 1. Fulfillment Dispatch:
 *    - Validates order exists and fulfillment_status is UNFULFILLED or PARTIALLY_FULFILLED
 *    - Atomically decrements MSI allocated and onHand stock in PostgreSQL / memory
 *    - Records dispatch in `order_fulfillments` and `order_fulfillment_lines`
 *    - Updates `orders.fulfillment_status = 'FULFILLED'`
 *    - Enqueues `fulfillment.dispatched.v1` and `fulfillment.3pl_dispatch_manifest` transactional outbox events
 *
 * 2. Pre-fulfillment Cancellation:
 *    - Validates order exists and fulfillment_status is UNFULFILLED (rejects fulfilled orders)
 *    - Atomically releases MSI allocated stock back to available pool
 *    - Voids or refunds payment gateway authorization/capture and restores store credit
 *    - Updates `orders.fulfillment_status = 'CANCELLED'`, `cancelled_at = now()`, `cancel_reason = reason`
 *    - Enqueues `order.cancelled.v1` and `inventory.stock_released.v1` transactional outbox events
 */

import { randomUUID } from "node:crypto";
import {
  deserializeWithBigInt,
  serializeWithBigInt,
  type PgPoolLike,
} from "@super-ecommerce/db";
import { createStep, createWorkflow } from "@super-ecommerce/workflow";
import type { MinorUnits } from "@super-ecommerce/kernel";
import type {
  MsiInventoryServiceLike,
  ShipmentSlice,
} from "./inventory-service.ts";
import type { OutboxStoreLike } from "./outbox-service.ts";
import type {
  OrderRecord,
  PaymentGatewayStrategy,
  StoreCreditLedger,
} from "./complete-checkout-workflow.ts";
import type { PgOrdersRepository } from "./orders-repository.ts";

export interface DispatchFulfillmentInput {
  readonly orderId: string;
  readonly fulfillmentId?: string;
  readonly trackingNumber?: string;
  readonly carrier?: string;
  readonly createdBy?: string;
  readonly simulateFulfillmentFault?: boolean;
}

export interface OrderFulfillmentLineRecord {
  readonly id: string;
  readonly fulfillmentId: string;
  readonly orderId: string;
  readonly lineId: string;
  readonly variantId: string;
  readonly sku: string;
  readonly warehouseId: string;
  readonly quantity: number;
}

export interface OrderFulfillmentRecord {
  readonly fulfillmentId: string;
  readonly orderId: string;
  readonly warehouseId: string;
  readonly trackingNumber?: string;
  readonly carrier?: string;
  readonly status: "FULFILLED";
  readonly lines: readonly OrderFulfillmentLineRecord[];
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface FulfillmentWorkflowDeps {
  readonly inventoryService: MsiInventoryServiceLike;
  readonly outboxService: OutboxStoreLike;
  readonly ordersRepository?: PgOrdersRepository;
  readonly pgPool?: PgPoolLike;
  readonly orderStore?: Map<string, OrderRecord>;
}

export interface CancelOrderInput {
  readonly orderId: string;
  readonly reason?: string;
  readonly cancelledBy?: string;
  readonly simulateCancelFault?: boolean;
}

export interface CancelOrderResult {
  readonly orderId: string;
  readonly status: "CANCELLED";
  readonly cancelledAt: string;
  readonly cancelReason: string;
  readonly releasedStockUnits: number;
  readonly paymentVoidedAmount: MinorUnits;
  readonly storeCreditRestoredAmount: MinorUnits;
}

export interface CancelOrderWorkflowDeps {
  readonly inventoryService: MsiInventoryServiceLike;
  readonly paymentGateway: PaymentGatewayStrategy;
  readonly outboxService: OutboxStoreLike;
  readonly storeCreditLedger?: StoreCreditLedger;
  readonly ordersRepository?: PgOrdersRepository;
  readonly pgPool?: PgPoolLike;
  readonly orderStore?: Map<string, OrderRecord>;
}

async function loadOrder(
  orderId: string,
  deps: { pgPool?: PgPoolLike; orderStore?: Map<string, OrderRecord> }
): Promise<OrderRecord | null> {
  if (deps.pgPool) {
    const res = await deps.pgPool.query<{
      id: string;
      fulfillment_status: string | null;
      payment_status: OrderRecord["paymentStatus"];
      payload_json: string | null;
    }>(
      `SELECT id, fulfillment_status, payment_status, payload_json
       FROM orders
       WHERE id = $1`,
      [orderId]
    );
    const row = res.rows[0];
    if (row?.payload_json) {
      const parsed = deserializeWithBigInt<OrderRecord>(row.payload_json);
      return {
        ...parsed,
        orderId: parsed.orderId ?? row.id,
        paymentStatus: row.payment_status ?? parsed.paymentStatus,
        fulfillmentStatus:
          (row.fulfillment_status as OrderRecord["fulfillmentStatus"]) ??
          parsed.fulfillmentStatus ??
          "UNFULFILLED",
      };
    }
  }

  const mem = deps.orderStore?.get(orderId);
  return mem ? { ...mem } : null;
}

export function buildFulfillmentDispatchWorkflow(deps: FulfillmentWorkflowDeps) {
  const verifyOrderFulfillableStep = createStep({
    name: "verify-order-fulfillable",
    invoke: async (input: DispatchFulfillmentInput): Promise<{ order: OrderRecord }> => {
      const order = await loadOrder(input.orderId, deps);
      if (!order) {
        throw new Error(`Order '${input.orderId}' not found for fulfillment dispatch`);
      }

      if (order.fulfillmentStatus === "FULFILLED") {
        throw new Error(`Order '${input.orderId}' is already fulfilled`);
      }

      if (order.fulfillmentStatus === "CANCELLED") {
        throw new Error(`Cannot fulfill cancelled order '${input.orderId}'`);
      }

      if (!order.shipments || order.shipments.length === 0) {
        throw new Error(`Order '${input.orderId}' has no warehouse stock allocations to fulfill`);
      }

      return { order };
    },
  });

  const deductMsiStockStep = createStep({
    name: "deduct-msi-stock",
    invoke: async (params: { order: OrderRecord }): Promise<{ deductedSlices: readonly ShipmentSlice[] }> => {
      await deps.inventoryService.deductAllocatedStock(params.order.shipments);
      return { deductedSlices: params.order.shipments };
    },
    compensate: async (output) => {
      await deps.inventoryService.revertDeductAllocatedStock(output.deductedSlices);
    },
  });

  const commitFulfillmentAndOutboxStep = createStep({
    name: "commit-fulfillment-and-outbox",
    invoke: async (params: {
      input: DispatchFulfillmentInput;
      order: OrderRecord;
      deductedSlices: readonly ShipmentSlice[];
    }): Promise<OrderFulfillmentRecord> => {
      if (params.input.simulateFulfillmentFault) {
        throw new Error("FULFILLMENT_COMMIT_FAULT_SIMULATION");
      }

      const fulfillmentId = params.input.fulfillmentId ?? `ful_${randomUUID()}`;
      const nowIso = new Date().toISOString();
      const primaryWarehouse = params.deductedSlices[0]?.warehouseId ?? "wh_main";
      const carrier = params.input.carrier ?? "DHL Express";
      const trackingNumber =
        params.input.trackingNumber ?? `TRACK-${randomUUID().slice(0, 8).toUpperCase()}`;
      const createdBy = params.input.createdBy ?? "admin@super-ecommerce.com";

      const fulfillmentLines: OrderFulfillmentLineRecord[] = params.deductedSlices.map(
        (slice, idx) => ({
          id: `ful_line_${fulfillmentId}_${idx + 1}`,
          fulfillmentId,
          orderId: params.order.orderId,
          lineId: slice.lineId,
          variantId: slice.variantId,
          sku: slice.variantId,
          warehouseId: slice.warehouseId,
          quantity: slice.quantityAllocated,
        })
      );

      const fulfillmentRecord: OrderFulfillmentRecord = {
        fulfillmentId,
        orderId: params.order.orderId,
        warehouseId: primaryWarehouse,
        trackingNumber,
        carrier,
        status: "FULFILLED",
        lines: fulfillmentLines,
        createdBy,
        createdAt: nowIso,
      };

      const updatedOrder: OrderRecord = {
        ...params.order,
        fulfillmentStatus: "FULFILLED",
      };

      if (deps.pgPool) {
        await deps.pgPool.withTransaction(async (tx) => {
          await tx.query(
            `UPDATE orders
             SET fulfillment_status = 'FULFILLED',
                 payload_json = $1::jsonb,
                 updated_at = $2::timestamptz
             WHERE id = $3`,
            [serializeWithBigInt(updatedOrder), nowIso, updatedOrder.orderId]
          );

          await tx.query(
            `INSERT INTO order_fulfillments (
               fulfillment_id, order_id, warehouse_id, tracking_number,
               carrier, status, created_by, created_at
             ) VALUES ($1, $2, $3, $4, $5, 'FULFILLED', $6, $7::timestamptz)`,
            [
              fulfillmentId,
              params.order.orderId,
              primaryWarehouse,
              trackingNumber,
              carrier,
              createdBy,
              nowIso,
            ]
          );

          for (const line of fulfillmentLines) {
            await tx.query(
              `INSERT INTO order_fulfillment_lines (
                 id, fulfillment_id, order_id, line_id, variant_id, sku, warehouse_id, quantity
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                line.id,
                line.fulfillmentId,
                line.orderId,
                line.lineId,
                line.variantId,
                line.sku,
                line.warehouseId,
                line.quantity,
              ]
            );
          }

          if (deps.outboxService.enqueue) {
            await deps.outboxService.enqueue(
              {
                eventType: "fulfillment.dispatched.v1",
                aggregateType: "OrderFulfillment",
                aggregateId: fulfillmentId,
                channelSlug: params.order.channelSlug,
                payload: {
                  fulfillmentId,
                  orderId: params.order.orderId,
                  trackingNumber,
                  carrier,
                  warehouseId: primaryWarehouse,
                  totalUnits: params.deductedSlices.reduce(
                    (s, l) => s + l.quantityAllocated,
                    0
                  ),
                },
              },
              tx
            );

            await deps.outboxService.enqueue(
              {
                eventType: "fulfillment.3pl_dispatch_manifest",
                aggregateType: "OrderFulfillment",
                aggregateId: fulfillmentId,
                channelSlug: params.order.channelSlug,
                payload: {
                  fulfillmentId,
                  orderId: params.order.orderId,
                  carrier,
                  trackingNumber,
                  shipments: params.deductedSlices,
                },
              },
              tx
            );
          }
        });
      } else {
        if (deps.outboxService.enqueue) {
          deps.outboxService.enqueue({
            eventType: "fulfillment.dispatched.v1",
            aggregateType: "OrderFulfillment",
            aggregateId: fulfillmentId,
            channelSlug: params.order.channelSlug,
            payload: {
              fulfillmentId,
              orderId: params.order.orderId,
              trackingNumber,
              carrier,
              warehouseId: primaryWarehouse,
              totalUnits: params.deductedSlices.reduce(
                (s, l) => s + l.quantityAllocated,
                0
              ),
            },
          });

          deps.outboxService.enqueue({
            eventType: "fulfillment.3pl_dispatch_manifest",
            aggregateType: "OrderFulfillment",
            aggregateId: fulfillmentId,
            channelSlug: params.order.channelSlug,
            payload: {
              fulfillmentId,
              orderId: params.order.orderId,
              carrier,
              trackingNumber,
              shipments: params.deductedSlices,
            },
          });
        }
      }

      if (deps.orderStore) {
        deps.orderStore.set(updatedOrder.orderId, updatedOrder);
      }

      return fulfillmentRecord;
    },
  });

  return createWorkflow(
    "dispatch-fulfillment",
    async (input: DispatchFulfillmentInput, ctx) => {
      const { order } = await ctx.run(verifyOrderFulfillableStep, input);
      const { deductedSlices } = await ctx.run(deductMsiStockStep, { order });
      return await ctx.run(commitFulfillmentAndOutboxStep, {
        input,
        order,
        deductedSlices,
      });
    }
  );
}

export function buildCancelOrderWorkflow(deps: CancelOrderWorkflowDeps) {
  const verifyOrderCancellableStep = createStep({
    name: "verify-order-cancellable",
    invoke: async (input: CancelOrderInput): Promise<{ order: OrderRecord }> => {
      const order = await loadOrder(input.orderId, deps);
      if (!order) {
        throw new Error(`Order '${input.orderId}' not found for cancellation`);
      }

      if (order.fulfillmentStatus === "FULFILLED") {
        throw new Error(
          `Cannot cancel already fulfilled order '${input.orderId}'. Use RMA return flow instead.`
        );
      }

      if (order.fulfillmentStatus === "CANCELLED") {
        throw new Error(`Order '${input.orderId}' is already cancelled`);
      }

      return { order };
    },
  });

  const releaseMsiStockStep = createStep({
    name: "release-msi-stock",
    invoke: async (params: { order: OrderRecord }): Promise<{ releasedUnits: number }> => {
      const slices = params.order.shipments ?? [];
      const totalUnits = slices.reduce((s, l) => s + l.quantityAllocated, 0);
      if (slices.length > 0) {
        await deps.inventoryService.releaseAllocations(slices);
      }
      return { releasedUnits: totalUnits };
    },
    compensate: async (output, params) => {
      if (params.order.shipments && params.order.shipments.length > 0) {
        await deps.inventoryService.upsertExternalSlots(
          params.order.shipments.map((s) => ({
            warehouseId: s.warehouseId,
            variantId: s.variantId,
            priorityRank: 100,
            linkedToChannel: true,
            supportsShippingZone: true,
            quantityOnHand: s.quantityAllocated,
            quantityReserved: 0,
            quantityAllocated: s.quantityAllocated,
          })),
          { preserveAllocated: false }
        );
      }
    },
  });

  const voidOrRefundPaymentStep = createStep({
    name: "void-or-refund-payment",
    invoke: async (params: {
      order: OrderRecord;
    }): Promise<{ voidedAmount: MinorUnits; storeCreditRestored: MinorUnits }> => {
      const amountToVoid = params.order.paymentCapturedAmount ?? params.order.pricing.totalGrossAmount;
      const txId = params.order.paymentTransactionId ?? `tx_${params.order.checkoutId}`;

      if (amountToVoid > 0n) {
        await deps.paymentGateway.voidOrRefund({
          checkoutId: params.order.checkoutId,
          transactionId: txId,
          amount: amountToVoid,
        });
      }

      let storeCreditRestored = 0n;
      if (params.order.customerId && deps.storeCreditLedger) {
        const giftOrCreditLines = params.order.pricing.lines.filter((l) =>
          Boolean(l.allocatedOrderDiscountAmount > 0n)
        );
        const creditAmount = giftOrCreditLines.reduce(
          (s, l) => s + l.allocatedOrderDiscountAmount,
          0n
        );
        if (creditAmount > 0n) {
          await deps.storeCreditLedger.restore(
            params.order.customerId,
            `cancel_${params.order.orderId}`,
            creditAmount
          );
          storeCreditRestored = creditAmount;
        }
      }

      return {
        voidedAmount: amountToVoid,
        storeCreditRestored,
      };
    },
    compensate: async (output, params) => {
      if (output.voidedAmount > 0n) {
        await deps.paymentGateway.capture({
          checkoutId: params.order.checkoutId,
          amount: output.voidedAmount,
          currencyCode: params.order.currencyCode,
          paymentToken: `tok_cancel_revert_${params.order.orderId}`,
        });
      }
      if (output.storeCreditRestored > 0n && params.order.customerId && deps.storeCreditLedger) {
        await deps.storeCreditLedger.deduct(
          params.order.customerId,
          output.storeCreditRestored
        );
      }
    },
  });

  const commitCancelAndOutboxStep = createStep({
    name: "commit-cancel-and-outbox",
    invoke: async (params: {
      input: CancelOrderInput;
      order: OrderRecord;
      releasedUnits: number;
      voidedAmount: MinorUnits;
      storeCreditRestored: MinorUnits;
    }): Promise<CancelOrderResult> => {
      if (params.input.simulateCancelFault) {
        throw new Error("ORDER_CANCEL_COMMIT_FAULT_SIMULATION");
      }

      const nowIso = new Date().toISOString();
      const cancelReason = params.input.reason ?? "Pre-fulfillment cancellation by customer request";

      const updatedOrder: OrderRecord = {
        ...params.order,
        fulfillmentStatus: "CANCELLED",
        paymentStatus: "VOIDED",
      };

      if (deps.pgPool) {
        await deps.pgPool.withTransaction(async (tx) => {
          await tx.query(
            `UPDATE orders
             SET fulfillment_status = 'CANCELLED',
                 payment_status = 'VOIDED',
                 cancelled_at = $1::timestamptz,
                 cancel_reason = $2,
                 payload_json = $3::jsonb,
                 updated_at = $1::timestamptz
             WHERE id = $4`,
            [nowIso, cancelReason, serializeWithBigInt(updatedOrder), updatedOrder.orderId]
          );

          if (deps.outboxService.enqueue) {
            await deps.outboxService.enqueue(
              {
                eventType: "order.cancelled.v1",
                aggregateType: "Order",
                aggregateId: params.order.orderId,
                channelSlug: params.order.channelSlug,
                payload: {
                  orderId: params.order.orderId,
                  cancelledAt: nowIso,
                  cancelReason,
                  totalGrossAmount: params.order.pricing.totalGrossAmount.toString(),
                  voidedAmount: params.voidedAmount.toString(),
                },
              },
              tx
            );

            await deps.outboxService.enqueue(
              {
                eventType: "inventory.stock_released.v1",
                aggregateType: "Order",
                aggregateId: params.order.orderId,
                channelSlug: params.order.channelSlug,
                payload: {
                  orderId: params.order.orderId,
                  releasedUnits: params.releasedUnits,
                  shipments: params.order.shipments,
                },
              },
              tx
            );
          }
        });
      } else {
        if (deps.outboxService.enqueue) {
          deps.outboxService.enqueue({
            eventType: "order.cancelled.v1",
            aggregateType: "Order",
            aggregateId: params.order.orderId,
            channelSlug: params.order.channelSlug,
            payload: {
              orderId: params.order.orderId,
              cancelledAt: nowIso,
              cancelReason,
              totalGrossAmount: params.order.pricing.totalGrossAmount.toString(),
              voidedAmount: params.voidedAmount.toString(),
            },
          });

          deps.outboxService.enqueue({
            eventType: "inventory.stock_released.v1",
            aggregateType: "Order",
            aggregateId: params.order.orderId,
            channelSlug: params.order.channelSlug,
            payload: {
              orderId: params.order.orderId,
              releasedUnits: params.releasedUnits,
              shipments: params.order.shipments,
            },
          });
        }
      }

      if (deps.orderStore) {
        deps.orderStore.set(updatedOrder.orderId, updatedOrder);
      }

      return {
        orderId: params.order.orderId,
        status: "CANCELLED",
        cancelledAt: nowIso,
        cancelReason,
        releasedStockUnits: params.releasedUnits,
        paymentVoidedAmount: params.voidedAmount,
        storeCreditRestoredAmount: params.storeCreditRestored,
      };
    },
  });

  return createWorkflow(
    "cancel-order",
    async (input: CancelOrderInput, ctx) => {
      const { order } = await ctx.run(verifyOrderCancellableStep, input);
      const { releasedUnits } = await ctx.run(releaseMsiStockStep, { order });
      const { voidedAmount, storeCreditRestored } = await ctx.run(voidOrRefundPaymentStep, { order });
      return await ctx.run(commitCancelAndOutboxStep, {
        input,
        order,
        releasedUnits,
        voidedAmount,
        storeCreditRestored,
      });
    }
  );
}
