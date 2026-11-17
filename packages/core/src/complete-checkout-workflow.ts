/**
 * `completeCheckoutWorkflow` — Durable 5-Step Saga Pipeline (`@super-ecommerce/core`).
 *
 * Step 1: `verify-pricing`         -> Deterministic two-pass calculation & tamper check
 * Step 2: `allocate-inventory`     -> Multi-warehouse MSI stock allocation (compensates via release)
 * Step 3: `redeem-store-credit`    -> Gift card / B2B credit deduction (compensates via restore)
 * Step 4: `capture-payment`        -> External payment gateway capture (compensates via void/refund)
 * Step 5: `commit-order-and-outbox`-> Atomic Order persistence + Transactional Outbox event
 */

import {
  calculateCart,
  type CartCalculationInput,
  type CartCalculationResult,
  type MinorUnits,
} from "@super-ecommerce/kernel";
import {
  serializeWithBigInt,
  SqlDatabaseEngine,
  type AllocationStrategy,
  type PgPoolLike,
  type StockAvailabilityMode,
} from "@super-ecommerce/db";
import { createStep, createWorkflow } from "@super-ecommerce/workflow";
import {
  type MsiInventoryServiceLike,
  type ShipmentSlice,
} from "./inventory-service.ts";
import { type OutboxStoreLike } from "./outbox-service.ts";

export interface PaymentCaptureResult {
  readonly transactionId: string;
  readonly provider: string;
  readonly capturedAmount: MinorUnits;
}

export interface PaymentGatewayStrategy {
  capture(params: {
    checkoutId: string;
    amount: MinorUnits;
    currencyCode: string;
    paymentToken: string;
  }): Promise<PaymentCaptureResult>;

  voidOrRefund(params: {
    checkoutId: string;
    transactionId: string;
    amount: MinorUnits;
  }): Promise<void>;
}

export interface StoreCreditLedger {
  deduct(customerId: string, amount: MinorUnits): Promise<{ ledgerTxId: string }>;
  restore(customerId: string, ledgerTxId: string, amount: MinorUnits): Promise<void>;
}

export interface OrderRecord {
  readonly orderId: string;
  readonly checkoutId: string;
  readonly channelSlug: string;
  readonly customerId?: string;
  readonly currencyCode: string;
  readonly pricing: CartCalculationResult;
  readonly shipments: readonly ShipmentSlice[];
  readonly paymentStatus?:
    | "AUTHORIZED"
    | "CAPTURED"
    | "PARTIALLY_REFUNDED"
    | "REFUNDED"
    | "DISPUTED"
    | "FAILED"
    | "VOIDED";
  readonly fulfillmentStatus?:
    | "UNFULFILLED"
    | "PARTIALLY_FULFILLED"
    | "FULFILLED"
    | "CANCELLED";
  readonly paymentTransactionId?: string;
  readonly paymentCapturedAmount?: MinorUnits;
  readonly storeCreditLedgerTxId?: string;
  readonly storeCreditRedeemedAmount?: MinorUnits;
  readonly createdAt: string;
}

export interface CompleteCheckoutInput {
  readonly checkoutId: string;
  readonly channelSlug: string;
  readonly customerId?: string;
  readonly stockAvailabilityMode: StockAvailabilityMode;
  readonly allocationStrategy: AllocationStrategy;
  readonly cart: CartCalculationInput;
  readonly expectedTotalGrossAmount?: MinorUnits;
  readonly storeCreditToRedeem?: MinorUnits;
  readonly paymentToken: string;
  readonly simulateCommitFault?: boolean;
}

export interface CheckoutWorkflowDeps {
  readonly inventoryService: MsiInventoryServiceLike;
  readonly paymentGateway: PaymentGatewayStrategy;
  readonly outboxService: OutboxStoreLike;
  readonly storeCreditLedger?: StoreCreditLedger;
  readonly orderStore?: Map<string, OrderRecord>;
  readonly pgPool?: PgPoolLike;
  readonly sqlEngine?: SqlDatabaseEngine;
}

export function buildCompleteCheckoutWorkflow(deps: CheckoutWorkflowDeps) {
  const verifyPricingStep = createStep({
    name: "verify-pricing",
    invoke: async (input: CompleteCheckoutInput): Promise<CartCalculationResult> => {
      const pricing = calculateCart(input.cart);
      if (
        input.expectedTotalGrossAmount !== undefined &&
        pricing.totalGrossAmount !== input.expectedTotalGrossAmount
      ) {
        throw new Error(
          `Checkout price mismatch: expected ${input.expectedTotalGrossAmount}, calculated ${pricing.totalGrossAmount}`
        );
      }
      return pricing;
    },
  });

  const allocateInventoryStep = createStep({
    name: "allocate-inventory",
    invoke: async (input: CompleteCheckoutInput) => {
      const demands = input.cart.lines.map((l) => ({
        lineId: l.lineId,
        variantId: l.variantId,
        quantity: l.quantity,
      }));
      return await deps.inventoryService.allocateForCheckout({
        demands,
        availabilityMode: input.stockAvailabilityMode,
        strategy: input.allocationStrategy,
      });
    },
    compensate: async (output) => {
      await deps.inventoryService.releaseAllocations(output.allocations);
    },
  });

  const redeemStoreCreditStep = createStep({
    name: "redeem-store-credit",
    invoke: async (params: {
      customerId?: string;
      amount: MinorUnits;
    }): Promise<{ ledgerTxId?: string; deductedAmount: MinorUnits }> => {
      if (params.amount <= 0n) {
        return { deductedAmount: 0n };
      }
      if (!params.customerId || !deps.storeCreditLedger) {
        throw new Error("Store credit redemption requires customerId and storeCreditLedger");
      }
      const res = await deps.storeCreditLedger.deduct(params.customerId, params.amount);
      return { ledgerTxId: res.ledgerTxId, deductedAmount: params.amount };
    },
    compensate: async (output, params) => {
      if (output.deductedAmount > 0n && output.ledgerTxId && params.customerId && deps.storeCreditLedger) {
        await deps.storeCreditLedger.restore(
          params.customerId,
          output.ledgerTxId,
          output.deductedAmount
        );
      }
    },
  });

  const capturePaymentStep = createStep({
    name: "capture-payment",
    retryPolicy: { maxRetries: 1, retryDelayMs: 5 },
    invoke: async (params: {
      checkoutId: string;
      amountToCapture: MinorUnits;
      currencyCode: string;
      paymentToken: string;
    }): Promise<PaymentCaptureResult | null> => {
      if (params.amountToCapture <= 0n) {
        return null;
      }
      return await deps.paymentGateway.capture({
        checkoutId: params.checkoutId,
        amount: params.amountToCapture,
        currencyCode: params.currencyCode,
        paymentToken: params.paymentToken,
      });
    },
    compensate: async (output, params) => {
      if (output && output.capturedAmount > 0n) {
        await deps.paymentGateway.voidOrRefund({
          checkoutId: params.checkoutId,
          transactionId: output.transactionId,
          amount: output.capturedAmount,
        });
      }
    },
  });

  const commitOrderAndOutboxStep = createStep({
    name: "commit-order-and-outbox",
    invoke: async (params: {
      input: CompleteCheckoutInput;
      pricing: CartCalculationResult;
      shipments: readonly ShipmentSlice[];
      paymentTx: PaymentCaptureResult | null;
      storeCreditTxId?: string;
    }): Promise<OrderRecord> => {
      if (params.input.simulateCommitFault) {
        throw new Error("ORDER_COMMIT_COMPLIANCE_HOLD_FAULT");
      }
      const orderId = `ord_${params.input.checkoutId}`;
      const order: OrderRecord = {
        orderId,
        checkoutId: params.input.checkoutId,
        channelSlug: params.input.channelSlug,
        customerId: params.input.customerId,
        currencyCode: params.pricing.currencyCode,
        pricing: params.pricing,
        shipments: params.shipments,
        paymentStatus: "CAPTURED",
        paymentTransactionId: params.paymentTx?.transactionId,
        paymentCapturedAmount: params.paymentTx?.capturedAmount ?? 0n,
        storeCreditLedgerTxId: params.storeCreditTxId,
        storeCreditRedeemedAmount: params.input.storeCreditToRedeem ?? 0n,
        createdAt: new Date().toISOString(),
      };

      const outboxEventParams = {
        eventType: "order.created",
        aggregateType: "Order",
        aggregateId: orderId,
        channelSlug: params.input.channelSlug,
        payload: {
          orderId,
          checkoutId: params.input.checkoutId,
          totalGrossAmount: params.pricing.totalGrossAmount.toString(),
          shipmentCount: new Set(params.shipments.map((s) => s.warehouseId)).size,
        },
      };

      if (deps.pgPool) {
        await deps.pgPool.withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO orders (
               id, checkout_id, channel_slug, customer_id,
               currency_code, total_gross_amount, payment_transaction_id,
               payment_status, allocations_json, payload_json,
               fulfillment_status, created_at, updated_at
             ) VALUES (
               $1, $2, $3, $4,
               $5, $6, $7,
               'CAPTURED', $8::jsonb, $9::jsonb,
               'UNFULFILLED', $10::timestamptz, $10::timestamptz
             )`,
            [
              orderId,
              order.checkoutId,
              order.channelSlug,
              order.customerId ?? null,
              order.currencyCode,
              order.pricing.totalGrossAmount.toString(),
              order.paymentTransactionId ?? null,
              serializeWithBigInt(order.shipments),
              serializeWithBigInt(order),
              order.createdAt,
            ]
          );
          await deps.outboxService.enqueue(outboxEventParams, tx);
        });
        deps.orderStore?.set(orderId, order);
      } else {
        const commitAction = () => {
          if (deps.sqlEngine) {
            deps.sqlEngine.db
              .prepare(
                `INSERT INTO orders (
                   order_id, checkout_id, channel_slug, customer_id,
                   currency_code, total_gross_amount, payment_status,
                   payment_transaction_id, payload_json, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, 'CAPTURED', ?, ?, ?)`
              )
              .run(
                orderId,
                order.checkoutId,
                order.channelSlug,
                order.customerId ?? null,
                order.currencyCode,
                order.pricing.totalGrossAmount.toString(),
                order.paymentTransactionId ?? null,
                serializeWithBigInt(order),
                order.createdAt
              );
          }
          deps.orderStore?.set(orderId, order);
          deps.outboxService.enqueue(outboxEventParams);
        };

        if (deps.sqlEngine) {
          deps.sqlEngine.inTransaction(commitAction);
        } else {
          commitAction();
        }
      }

      return order;
    },
  });

  return createWorkflow(
    "complete-checkout",
    async (input: CompleteCheckoutInput, ctx): Promise<OrderRecord> => {
      // 1. Deterministic pricing & tamper check
      const pricing = await ctx.run(verifyPricingStep, input);

      // 2. Allocate MSI inventory across warehouses
      const allocation = await ctx.run(allocateInventoryStep, input);

      // 3. Optional store credit / gift card deduction
      const creditToUse = input.storeCreditToRedeem ?? 0n;
      const creditResult = await ctx.run(redeemStoreCreditStep, {
        customerId: input.customerId,
        amount: creditToUse,
      });

      // 4. External payment gateway capture
      const remainingToCapture = pricing.totalGrossAmount - creditResult.deductedAmount;
      const paymentTx = await ctx.run(capturePaymentStep, {
        checkoutId: input.checkoutId,
        amountToCapture: remainingToCapture,
        currencyCode: pricing.currencyCode,
        paymentToken: input.paymentToken,
      });

      // 5. Commit Order + Transactional Outbox event
      return await ctx.run(commitOrderAndOutboxStep, {
        input,
        pricing,
        shipments: allocation.allocations,
        paymentTx,
        storeCreditTxId: creditResult.ledgerTxId,
      });
    }
  );
}
