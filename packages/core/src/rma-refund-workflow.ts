/**
 * `processReturnRefundWorkflow` — Durable 5-Step RMA & Partial Refund Saga (`@super-ecommerce/core`).
 *
 * Step 1: `verify-rma-calculation`  -> Deterministic Rust N-API calculation with Hare-Niemeyer
 *                                      unit slicing and final-unit penny ceiling reconciliation.
 * Step 2: `restock-msi-inventory`   -> Returns resellable items to MSI available pool or writes off
 *                                      damaged items to quarantine (compensates via `revertRmaRestock`).
 * Step 3: `restore-store-credit`    -> Refunds store credit portion to customer ledger
 *                                      (compensates via `deduct`).
 * Step 4: `refund-payment-gateway`  -> Executes external gateway partial/full refund
 *                                      (compensates via re-capture on commit fault).
 * Step 5: `commit-rma-and-outbox`   -> Atomically persists `OrderReturnRecord`, transitions
 *                                      order status (`PARTIALLY_REFUNDED` | `REFUNDED`), and
 *                                      enqueues `order.rma.refunded` Outbox event.
 */

import {
  calculateReturnRefund,
  type Bps,
  type MinorUnits,
  type RefundCalculationResult,
  type RefundLineInput,
  type RefundTenderPriority,
} from "@super-ecommerce/kernel";
import {
  deserializeWithBigInt,
  serializeWithBigInt,
  type PgPoolLike,
} from "@super-ecommerce/db";
import { createStep, createWorkflow } from "@super-ecommerce/workflow";
import {
  type MsiInventoryServiceLike,
  type RestockedShipmentSlice,
  type ReturnItemCondition,
} from "./inventory-service.ts";
import { type OutboxStoreLike } from "./outbox-service.ts";
import type {
  OrderRecord,
  PaymentGatewayStrategy,
  StoreCreditLedger,
} from "./complete-checkout-workflow.ts";

export interface ReturnLineRequest {
  readonly lineId: string;
  readonly quantity: number;
  readonly condition?: ReturnItemCondition;
  readonly restockingFeeBps?: Bps;
}

export interface ProcessReturnRefundInput {
  readonly rmaId: string;
  readonly orderId: string;
  readonly linesToReturn: readonly ReturnLineRequest[];
  readonly refundShipping?: boolean;
  readonly tenderPriority?: RefundTenderPriority;
  readonly reason?: string;
  readonly simulateGatewayRefundFault?: boolean;
  readonly simulateCommitFault?: boolean;
}

export interface OrderReturnRecord {
  readonly rmaId: string;
  readonly orderId: string;
  readonly channelSlug: string;
  readonly customerId?: string;
  readonly currencyCode: string;
  readonly calculation: RefundCalculationResult;
  readonly restockedSlices: readonly RestockedShipmentSlice[];
  readonly storeCreditRestoredTxId?: string;
  readonly gatewayRefundTransactionId?: string;
  readonly orderPaymentStatusAfter: "PARTIALLY_REFUNDED" | "REFUNDED" | "CAPTURED";
  readonly reason: string;
  readonly createdAt: string;
}

export interface RmaWorkflowDeps {
  readonly inventoryService: MsiInventoryServiceLike;
  readonly paymentGateway: PaymentGatewayStrategy;
  readonly outboxService: OutboxStoreLike;
  readonly storeCreditLedger?: StoreCreditLedger;
  readonly orderStore?: Map<string, OrderRecord>;
  readonly rmaStore?: Map<string, OrderReturnRecord>;
  readonly pgPool?: PgPoolLike;
}

interface VerifiedRmaPlan {
  readonly order: OrderRecord;
  readonly priorReturns: readonly OrderReturnRecord[];
  readonly calculation: RefundCalculationResult;
  readonly restockPlan: readonly RestockedShipmentSlice[];
  readonly isOrderFullyRefundedAfter: boolean;
}

export function buildProcessReturnRefundWorkflow(deps: RmaWorkflowDeps) {
  const verifyRmaCalculationStep = createStep({
    name: "verify-rma-calculation",
    invoke: async (input: ProcessReturnRefundInput): Promise<VerifiedRmaPlan> => {
      let order = deps.orderStore?.get(input.orderId);
      let priorReturns: OrderReturnRecord[] = [];

      if (deps.pgPool) {
        const orderRes = await deps.pgPool.query<{
          id: string;
          payment_status: OrderRecord["paymentStatus"];
          payload_json: string | null;
        }>(
          `SELECT id, payment_status, payload_json
           FROM orders
           WHERE id = $1`,
          [input.orderId]
        );
        const row = orderRes.rows[0];
        if (row?.payload_json) {
          const parsedOrder = deserializeWithBigInt<OrderRecord>(row.payload_json);
          order = {
            ...parsedOrder,
            paymentStatus: row.payment_status ?? parsedOrder.paymentStatus,
          };
        }

        const rmaRes = await deps.pgPool.query<{ payload_json: string }>(
          `SELECT payload_json
           FROM order_returns
           WHERE order_id = $1
           ORDER BY created_at ASC`,
          [input.orderId]
        );
        priorReturns = rmaRes.rows.map((r) =>
          deserializeWithBigInt<OrderReturnRecord>(r.payload_json)
        );
      } else {
        priorReturns = [...(deps.rmaStore?.values() ?? [])].filter(
          (r) => r.orderId === input.orderId
        );
      }

      if (!order) {
        throw new Error(`Order '${input.orderId}' not found for RMA '${input.rmaId}'`);
      }

      // Accumulate prior returned quantities & consumed ceilings per line
      const priorQtyByLine = new Map<string, number>();
      const priorNetByLine = new Map<string, MinorUnits>();
      const priorTaxByLine = new Map<string, MinorUnits>();
      const priorGrossByLine = new Map<string, MinorUnits>();

      let shippingAlreadyRefundedGross = 0n;
      let gatewayAlreadyRefunded = 0n;
      let storeCreditAlreadyRefunded = 0n;

      for (const prev of priorReturns) {
        shippingAlreadyRefundedGross += prev.calculation.shippingRefundGrossAmount;
        gatewayAlreadyRefunded += prev.calculation.paymentGatewayRefundAmount;
        storeCreditAlreadyRefunded += prev.calculation.storeCreditRefundAmount;
        for (const l of prev.calculation.lines) {
          priorQtyByLine.set(
            l.lineId,
            (priorQtyByLine.get(l.lineId) ?? 0) + l.acceptedReturnQuantity
          );
          priorNetByLine.set(
            l.lineId,
            (priorNetByLine.get(l.lineId) ?? 0n) + l.netCeilingConsumed
          );
          priorTaxByLine.set(
            l.lineId,
            (priorTaxByLine.get(l.lineId) ?? 0n) + l.taxCeilingConsumed
          );
          priorGrossByLine.set(
            l.lineId,
            (priorGrossByLine.get(l.lineId) ?? 0n) + l.grossCeilingConsumed
          );
        }
      }

      const reqByLine = new Map<string, ReturnLineRequest>();
      for (const req of input.linesToReturn) {
        reqByLine.set(req.lineId, req);
      }

      const refundLinesInput: RefundLineInput[] = order.pricing.lines.map((origLine) => {
        const req = reqByLine.get(origLine.lineId);
        return {
          lineId: origLine.lineId,
          variantId: origLine.variantId,
          originalQuantity: origLine.quantity,
          alreadyReturnedQuantity: priorQtyByLine.get(origLine.lineId) ?? 0,
          returnQuantityRequested: req?.quantity ?? 0,
          isGift: origLine.isGift,
          originalNetAmount: origLine.totalNetAmount,
          originalTaxAmount: origLine.totalTaxAmount,
          originalGrossAmount: origLine.totalGrossAmount,
          alreadyRefundedNetAmount: priorNetByLine.get(origLine.lineId) ?? 0n,
          alreadyRefundedTaxAmount: priorTaxByLine.get(origLine.lineId) ?? 0n,
          alreadyRefundedGrossAmount: priorGrossByLine.get(origLine.lineId) ?? 0n,
          restockingFeeBps: req?.restockingFeeBps ?? 0,
        };
      });

      const storeCreditOriginallyRedeemed = order.storeCreditRedeemedAmount ?? 0n;
      const paymentGatewayOriginallyCaptured =
        order.paymentCapturedAmount !== undefined
          ? order.paymentCapturedAmount
          : order.pricing.totalGrossAmount - storeCreditOriginallyRedeemed;

      const calculation = calculateReturnRefund({
        currencyCode: order.currencyCode,
        lines: refundLinesInput,
        refundShipping: input.refundShipping ?? false,
        shippingOriginalNetAmount: order.pricing.shippingNetAmount,
        shippingOriginalTaxAmount: order.pricing.shippingTaxAmount,
        shippingOriginalGrossAmount: order.pricing.shippingGrossAmount,
        shippingAlreadyRefundedGrossAmount: shippingAlreadyRefundedGross,
        paymentGatewayOriginallyCaptured,
        paymentGatewayAlreadyRefunded: gatewayAlreadyRefunded,
        storeCreditOriginallyRedeemed,
        storeCreditAlreadyRefunded,
        tenderPriority: input.tenderPriority ?? "GATEWAY_CASH_FIRST",
      });

      const totalAcceptedUnits = calculation.lines.reduce(
        (sum, l) => sum + l.acceptedReturnQuantity,
        0
      );
      if (totalAcceptedUnits === 0 && calculation.shippingRefundGrossAmount === 0n) {
        throw new Error(
          `RMA '${input.rmaId}' rejected: 0 returnable units remaining on requested lines`
        );
      }

      // Map accepted return quantities back onto the order's warehouse shipment slices
      const priorRestockedBySliceKey = new Map<string, number>();
      for (const prev of priorReturns) {
        for (const s of prev.restockedSlices) {
          const key = `${s.warehouseId}::${s.lineId}`;
          priorRestockedBySliceKey.set(
            key,
            (priorRestockedBySliceKey.get(key) ?? 0) + s.quantityReturned
          );
        }
      }

      const restockPlan: RestockedShipmentSlice[] = [];
      for (const lineRes of calculation.lines) {
        if (lineRes.acceptedReturnQuantity <= 0) continue;
        const req = reqByLine.get(lineRes.lineId);
        const condition: ReturnItemCondition = req?.condition ?? "RESELLABLE";
        let remainingToAssign = lineRes.acceptedReturnQuantity;

        const matchingShipments = order.shipments.filter(
          (s) => s.lineId === lineRes.lineId
        );
        for (const ship of matchingShipments) {
          if (remainingToAssign <= 0) break;
          const key = `${ship.warehouseId}::${ship.lineId}`;
          const alreadyRestockedFromSlice = priorRestockedBySliceKey.get(key) ?? 0;
          const sliceReturnable = Math.max(
            0,
            ship.quantityAllocated - alreadyRestockedFromSlice
          );
          const take = Math.min(remainingToAssign, sliceReturnable);
          if (take > 0) {
            restockPlan.push({
              warehouseId: ship.warehouseId,
              lineId: ship.lineId,
              variantId: ship.variantId,
              quantityReturned: take,
              condition,
            });
            remainingToAssign -= take;
          }
        }
      }

      const allPaidLinesExhausted = calculation.lines
        .filter((l) => !l.isGift)
        .every((l) => l.remainingReturnableQuantity === 0);

      return {
        order,
        priorReturns,
        calculation,
        restockPlan,
        isOrderFullyRefundedAfter: allPaidLinesExhausted,
      };
    },
  });

  const restockMsiInventoryStep = createStep({
    name: "restock-msi-inventory",
    invoke: async (plan: VerifiedRmaPlan): Promise<RestockedShipmentSlice[]> => {
      return await deps.inventoryService.restockReturnedItems(plan.restockPlan);
    },
    compensate: async (restockedSlices) => {
      await deps.inventoryService.revertRmaRestock(restockedSlices);
    },
  });

  const restoreStoreCreditStep = createStep({
    name: "restore-store-credit",
    invoke: async (params: {
      customerId?: string;
      rmaId: string;
      amount: MinorUnits;
    }): Promise<{ restoredTxId?: string; restoredAmount: MinorUnits }> => {
      if (params.amount <= 0n) {
        return { restoredAmount: 0n };
      }
      if (!params.customerId || !deps.storeCreditLedger) {
        throw new Error(
          "RMA store credit restoration requires customerId and storeCreditLedger"
        );
      }
      const restoredTxId = `sc_rma_${params.rmaId}`;
      await deps.storeCreditLedger.restore(
        params.customerId,
        restoredTxId,
        params.amount
      );
      return { restoredTxId, restoredAmount: params.amount };
    },
    compensate: async (output, params) => {
      if (
        output.restoredAmount > 0n &&
        params.customerId &&
        deps.storeCreditLedger
      ) {
        await deps.storeCreditLedger.deduct(
          params.customerId,
          output.restoredAmount
        );
      }
    },
  });

  const refundPaymentGatewayStep = createStep({
    name: "refund-payment-gateway",
    invoke: async (params: {
      rmaId: string;
      order: OrderRecord;
      amountToRefund: MinorUnits;
      simulateFault?: boolean;
    }): Promise<{ refundTxId?: string; refundedAmount: MinorUnits }> => {
      if (params.simulateFault) {
        throw new Error("GATEWAY_REFUND_NETWORK_REJECTED");
      }
      if (params.amountToRefund <= 0n) {
        return { refundedAmount: 0n };
      }
      const origTxId = params.order.paymentTransactionId ?? `tx_${params.order.checkoutId}`;
      await deps.paymentGateway.voidOrRefund({
        checkoutId: params.order.checkoutId,
        transactionId: origTxId,
        amount: params.amountToRefund,
      });
      return {
        refundTxId: `re_${params.rmaId}`,
        refundedAmount: params.amountToRefund,
      };
    },
    compensate: async (output, params) => {
      if (output.refundedAmount > 0n) {
        await deps.paymentGateway.capture({
          checkoutId: params.order.checkoutId,
          amount: output.refundedAmount,
          currencyCode: params.order.currencyCode,
          paymentToken: `tok_reconcile_${params.rmaId}`,
        });
      }
    },
  });

  const commitRmaAndOutboxStep = createStep({
    name: "commit-rma-and-outbox",
    invoke: async (params: {
      input: ProcessReturnRefundInput;
      plan: VerifiedRmaPlan;
      restockedSlices: readonly RestockedShipmentSlice[];
      storeCreditTxId?: string;
      gatewayRefundTxId?: string;
    }): Promise<OrderReturnRecord> => {
      if (params.input.simulateCommitFault) {
        throw new Error("RMA_COMMIT_LEDGER_LOCK_FAULT");
      }

      const nextStatus: "PARTIALLY_REFUNDED" | "REFUNDED" =
        params.plan.isOrderFullyRefundedAfter ? "REFUNDED" : "PARTIALLY_REFUNDED";

      const rmaRecord: OrderReturnRecord = {
        rmaId: params.input.rmaId,
        orderId: params.plan.order.orderId,
        channelSlug: params.plan.order.channelSlug,
        customerId: params.plan.order.customerId,
        currencyCode: params.plan.order.currencyCode,
        calculation: params.plan.calculation,
        restockedSlices: params.restockedSlices,
        storeCreditRestoredTxId: params.storeCreditTxId,
        gatewayRefundTransactionId: params.gatewayRefundTxId,
        orderPaymentStatusAfter: nextStatus,
        reason: params.input.reason ?? "Customer Partial Return (RMA)",
        createdAt: new Date().toISOString(),
      };

      const updatedOrder: OrderRecord = {
        ...params.plan.order,
        paymentStatus: nextStatus,
      };

      const outboxEventParams = {
        eventType: "order.rma.refunded",
        aggregateType: "OrderReturn",
        aggregateId: rmaRecord.rmaId,
        channelSlug: rmaRecord.channelSlug,
        payload: {
          rmaId: rmaRecord.rmaId,
          orderId: rmaRecord.orderId,
          orderPaymentStatusAfter: nextStatus,
          totalRefundGrossAmount:
            rmaRecord.calculation.totalRefundGrossAmount.toString(),
          paymentGatewayRefundAmount:
            rmaRecord.calculation.paymentGatewayRefundAmount.toString(),
          storeCreditRefundAmount:
            rmaRecord.calculation.storeCreditRefundAmount.toString(),
        },
      };

      if (deps.pgPool) {
        await deps.pgPool.withTransaction(async (tx) => {
          await tx.query(
            `UPDATE orders
             SET payment_status = $1,
                 payload_json = $2::jsonb,
                 updated_at = $3::timestamptz
             WHERE id = $4`,
            [
              nextStatus,
              serializeWithBigInt(updatedOrder),
              rmaRecord.createdAt,
              updatedOrder.orderId,
            ]
          );

          await tx.query(
            `INSERT INTO order_returns (
               rma_id, order_id, channel_slug, currency_code,
               total_refund_gross_amount, payment_gateway_refund_amount,
               store_credit_refund_amount, payload_json, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)`,
            [
              rmaRecord.rmaId,
              rmaRecord.orderId,
              rmaRecord.channelSlug,
              rmaRecord.currencyCode,
              rmaRecord.calculation.totalRefundGrossAmount.toString(),
              rmaRecord.calculation.paymentGatewayRefundAmount.toString(),
              rmaRecord.calculation.storeCreditRefundAmount.toString(),
              serializeWithBigInt(rmaRecord),
              rmaRecord.createdAt,
            ]
          );

          await deps.outboxService.enqueue(outboxEventParams, tx);
        });

        deps.orderStore?.set(updatedOrder.orderId, updatedOrder);
        deps.rmaStore?.set(rmaRecord.rmaId, rmaRecord);
      } else {
        deps.orderStore?.set(updatedOrder.orderId, updatedOrder);
        deps.rmaStore?.set(rmaRecord.rmaId, rmaRecord);
        await deps.outboxService.enqueue(outboxEventParams);
      }

      return rmaRecord;
    },
  });

  return createWorkflow(
    "process-return-refund",
    async (input: ProcessReturnRefundInput, ctx): Promise<OrderReturnRecord> => {
      const plan = await ctx.run(verifyRmaCalculationStep, input);
      const restockedSlices = await ctx.run(restockMsiInventoryStep, plan);
      const scRes = await ctx.run(restoreStoreCreditStep, {
        customerId: plan.order.customerId,
        rmaId: input.rmaId,
        amount: plan.calculation.storeCreditRefundAmount,
      });
      const gwRes = await ctx.run(refundPaymentGatewayStep, {
        rmaId: input.rmaId,
        order: plan.order,
        amountToRefund: plan.calculation.paymentGatewayRefundAmount,
        simulateFault: input.simulateGatewayRefundFault,
      });
      return await ctx.run(commitRmaAndOutboxStep, {
        input,
        plan,
        restockedSlices,
        storeCreditTxId: scRes.restoredTxId,
        gatewayRefundTxId: gwRes.refundTxId,
      });
    }
  );
}
