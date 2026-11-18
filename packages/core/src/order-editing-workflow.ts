/**
 * OMS Pre-Fulfillment Order Editing & Delta Settlement Saga (`packages/core/src/order-editing-workflow.ts`).
 *
 * Allows merchants or self-service customers to modify an `UNFULFILLED` order before shipment:
 * - Add new SKU lines, increase/decrease existing line quantities, or remove lines
 * - Update shipping destination / shipping rate
 * - Re-evaluates the entire revised order through the deterministic Rust `calculateCart` kernel
 * - Reconciles **MSI Inventory Deltas** (allocating additional warehouse stock or releasing surplus slices)
 *   with strict LIFO compensation
 * - Settles **Financial Deltas** (`deltaGross > 0` incremental capture; `deltaGross < 0` partial refund;
 *   `deltaGross == 0` zero-cost swap)
 * - Atomically updates `orders`, normalized `order_lines`, `order_edits` audit history, balanced
 *   **Double-Entry Subledger** `ORDER_EDIT_DELTA` postings, and `order.edited.v1` Outbox event!
 */

import {
  calculateCart,
  type Bps,
  type CandidateOrderDiscount,
  type CartCalculationInput,
  type CartCalculationResult,
  type CartLineInput,
  type MinorUnits,
  type TaxInclusionMode,
} from "@super-ecommerce/kernel";
import {
  deserializeWithBigInt,
  serializeWithBigInt,
  type AllocationStrategy,
  type PgPoolLike,
  type StockAvailabilityMode,
} from "@super-ecommerce/db";
import { createStep, createWorkflow } from "@super-ecommerce/workflow";
import type {
  MsiInventoryServiceLike,
  ShipmentSlice,
} from "./inventory-service.ts";
import type { OutboxStoreLike } from "./outbox-service.ts";
import type {
  OrderRecord,
  PaymentGatewayStrategy,
} from "./complete-checkout-workflow.ts";
import { persistNormalizedOrderLines } from "./orders-repository.ts";
import {
  PgDoubleEntryLedgerService,
  type LedgerPostingInput,
} from "./double-entry-ledger.ts";

export interface OrderEditLineMutation {
  readonly lineId: string;
  readonly variantId?: string;
  /** Set `quantity = 0` to remove an existing line; `> 0` to update or add a line. */
  readonly quantity: number;
  readonly baseUnitPrice?: MinorUnits;
  readonly taxRateBps?: Bps;
}

export interface EditOrderInput {
  readonly editId: string;
  readonly orderId: string;
  readonly editedBy: string;
  readonly reason?: string;
  readonly lineMutations: readonly OrderEditLineMutation[];
  readonly revisedShippingBaseAmount?: MinorUnits;
  readonly revisedShippingTaxRateBps?: Bps;
  readonly revisedOrderDiscounts?: readonly CandidateOrderDiscount[];
  readonly paymentTokenForIncrementalCapture?: string;
  readonly stockAvailabilityMode?: StockAvailabilityMode;
  readonly allocationStrategy?: AllocationStrategy;
  readonly simulateCommitFault?: boolean;
}

export interface OrderEditRecord {
  readonly editId: string;
  readonly orderId: string;
  readonly editedBy: string;
  readonly reason: string;
  readonly previousGrossAmount: MinorUnits;
  readonly revisedGrossAmount: MinorUnits;
  readonly deltaGrossAmount: bigint;
  readonly settlementKind:
    | "NO_FINANCIAL_DELTA"
    | "INCREMENTAL_CAPTURE"
    | "PARTIAL_REFUND";
  readonly settlementTransactionId?: string;
  readonly revisedOrder: OrderRecord;
  readonly createdAt: string;
}

export interface OrderEditingWorkflowDeps {
  readonly pgPool: PgPoolLike;
  readonly inventoryService: MsiInventoryServiceLike;
  readonly paymentGateway: PaymentGatewayStrategy;
  readonly outboxService: OutboxStoreLike;
}

interface VerifiedOrderEditPlan {
  readonly originalOrder: OrderRecord;
  readonly revisedPricing: CartCalculationResult;
  readonly deltaNetMerchandise: bigint;
  readonly deltaShippingNet: bigint;
  readonly deltaTax: bigint;
  readonly deltaGross: bigint;
  readonly addedDemands: readonly { lineId: string; variantId: string; quantity: number }[];
  readonly releasedSlices: readonly ShipmentSlice[];
  readonly retainedSlices: readonly ShipmentSlice[];
}

export async function listOrderEditsFromPg(
  pool: PgPoolLike,
  options?: { readonly orderId?: string; readonly limit?: number }
): Promise<readonly OrderEditRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(options?.limit ?? 25)));
  const res = options?.orderId
    ? await pool.query<{ diff_payload_json: string }>(
        `SELECT diff_payload_json FROM order_edits WHERE order_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [options.orderId, safeLimit]
      )
    : await pool.query<{ diff_payload_json: string }>(
        `SELECT diff_payload_json FROM order_edits ORDER BY created_at DESC LIMIT $1`,
        [safeLimit]
      );
  return res.rows.map((r) => deserializeWithBigInt<OrderEditRecord>(r.diff_payload_json));
}

export function buildEditOrderWorkflow(deps: OrderEditingWorkflowDeps) {
  const validateAndRepriceStep = createStep({
    name: "validate-and-reprice-order-edit",
    invoke: async (input: EditOrderInput): Promise<VerifiedOrderEditPlan> => {
      const orderRes = await deps.pgPool.query<{
        id: string;
        fulfillment_status: string | null;
        payment_status: OrderRecord["paymentStatus"];
        payload_json: string | null;
      }>(
        `SELECT id, fulfillment_status, payment_status, payload_json
         FROM orders
         WHERE id = $1`,
        [input.orderId]
      );

      const row = orderRes.rows[0];
      if (!row || !row.payload_json) {
        throw new Error(`Order '${input.orderId}' not found`);
      }

      const fulfillmentStatus = row.fulfillment_status ?? "UNFULFILLED";
      if (fulfillmentStatus !== "UNFULFILLED") {
        throw new Error(
          `Cannot edit order '${input.orderId}' because fulfillment_status is '${fulfillmentStatus}' (must be UNFULFILLED)`
        );
      }

      const originalOrder = deserializeWithBigInt<OrderRecord>(row.payload_json);
      if (
        row.payment_status === "VOIDED" ||
        row.payment_status === "REFUNDED" ||
        row.payment_status === "FAILED"
      ) {
        throw new Error(
          `Cannot edit order '${input.orderId}' in terminal payment_status '${row.payment_status}'`
        );
      }

      // Build revised cart lines from original lines + mutations
      const lineMap = new Map<string, CartLineInput>();
      for (const orig of originalOrder.pricing.lines) {
        if (orig.isGift) continue;
        lineMap.set(orig.lineId, {
          lineId: orig.lineId,
          variantId: orig.variantId,
          quantity: orig.quantity,
          baseUnitPrice: orig.effectiveBaseUnitPrice,
          taxRateBps:
            orig.totalNetAmount > 0n
              ? Math.round(Number((orig.totalTaxAmount * 10_000n) / orig.totalNetAmount))
              : 0,
        });
      }

      for (const mut of input.lineMutations) {
        const qty = Math.floor(mut.quantity);
        if (qty <= 0) {
          lineMap.delete(mut.lineId);
        } else {
          const prev = lineMap.get(mut.lineId);
          const unitPrice = mut.baseUnitPrice ?? prev?.baseUnitPrice;
          if (unitPrice === undefined) {
            throw new Error(
              `New order line '${mut.lineId}' requires explicit baseUnitPrice`
            );
          }
          const resolvedVariantId = mut.variantId ?? prev?.variantId;
          if (!resolvedVariantId) {
            throw new Error(
              `New order line '${mut.lineId}' requires explicit variantId`
            );
          }
          lineMap.set(mut.lineId, {
            lineId: mut.lineId,
            variantId: resolvedVariantId,
            quantity: qty,
            baseUnitPrice: unitPrice,
            taxRateBps: mut.taxRateBps ?? prev?.taxRateBps ?? 0,
          });
        }
      }

      const revisedLines = [...lineMap.values()];
      if (revisedLines.length === 0) {
        throw new Error(
          `Order edit '${input.editId}' cannot remove all lines (use cancelOrderWorkflow instead)`
        );
      }

      const taxMode: TaxInclusionMode = "TAX_EXCLUSIVE";
      const prevShipNet = originalOrder.pricing.shippingNetAmount;
      const prevShipTaxBps =
        prevShipNet > 0n
          ? Math.round(
              Number((originalOrder.pricing.shippingTaxAmount * 10_000n) / prevShipNet)
            )
          : 0;

      const revisedCart: CartCalculationInput = {
        currencyCode: originalOrder.currencyCode,
        taxMode,
        shippingBaseAmount: input.revisedShippingBaseAmount ?? prevShipNet,
        shippingTaxRateBps: input.revisedShippingTaxRateBps ?? prevShipTaxBps,
        lines: revisedLines,
        candidateOrderDiscounts: input.revisedOrderDiscounts ?? [],
      };

      const revisedPricing = calculateCart(revisedCart);

      // Compute per-line inventory deltas against existing shipments
      const prevQtyByLine = new Map<string, number>();
      for (const l of originalOrder.pricing.lines) {
        if (!l.isGift) prevQtyByLine.set(l.lineId, l.quantity);
      }

      const addedDemands: { lineId: string; variantId: string; quantity: number }[] = [];
      const releasedSlices: ShipmentSlice[] = [];
      const retainedSlices: ShipmentSlice[] = [];

      // Handle reduced or removed lines
      for (const ship of originalOrder.shipments) {
        const nextLine = lineMap.get(ship.lineId);
        if (!nextLine) {
          releasedSlices.push(ship);
        } else {
          retainedSlices.push({ ...ship });
        }
      }

      for (const nextLine of revisedLines) {
        const prevQty = prevQtyByLine.get(nextLine.lineId) ?? 0;
        if (nextLine.quantity > prevQty) {
          addedDemands.push({
            lineId: nextLine.lineId,
            variantId: nextLine.variantId,
            quantity: nextLine.quantity - prevQty,
          });
        } else if (nextLine.quantity < prevQty) {
          let toReduce = prevQty - nextLine.quantity;
          for (let i = retainedSlices.length - 1; i >= 0 && toReduce > 0; i--) {
            const sl = retainedSlices[i]!;
            if (sl.lineId !== nextLine.lineId) continue;
            const cut = Math.min(toReduce, sl.quantityAllocated);
            if (cut > 0) {
              releasedSlices.push({
                warehouseId: sl.warehouseId,
                lineId: sl.lineId,
                variantId: sl.variantId,
                quantityAllocated: cut,
              });
              if (cut === sl.quantityAllocated) {
                retainedSlices.splice(i, 1);
              } else {
                retainedSlices[i] = {
                  ...sl,
                  quantityAllocated: sl.quantityAllocated - cut,
                };
              }
              toReduce -= cut;
            }
          }
        }
      }

      const prevMerchNet =
        originalOrder.pricing.totalNetAmount - originalOrder.pricing.shippingNetAmount;
      const nextMerchNet =
        revisedPricing.totalNetAmount - revisedPricing.shippingNetAmount;

      return {
        originalOrder,
        revisedPricing,
        deltaNetMerchandise: nextMerchNet - prevMerchNet,
        deltaShippingNet:
          revisedPricing.shippingNetAmount - originalOrder.pricing.shippingNetAmount,
        deltaTax: revisedPricing.totalTaxAmount - originalOrder.pricing.totalTaxAmount,
        deltaGross:
          revisedPricing.totalGrossAmount - originalOrder.pricing.totalGrossAmount,
        addedDemands,
        releasedSlices,
        retainedSlices,
      };
    },
  });

  const reconcileMsiInventoryDeltaStep = createStep({
    name: "reconcile-msi-inventory-delta",
    invoke: async (params: {
      input: EditOrderInput;
      plan: VerifiedOrderEditPlan;
    }): Promise<{
      newlyAllocated: readonly ShipmentSlice[];
      released: readonly ShipmentSlice[];
      finalShipments: readonly ShipmentSlice[];
    }> => {
      let newlyAllocated: readonly ShipmentSlice[] = [];
      if (params.plan.addedDemands.length > 0) {
        const alloc = await deps.inventoryService.allocateForCheckout({
          demands: params.plan.addedDemands,
          availabilityMode:
            params.input.stockAvailabilityMode ?? "DIRECT_CHANNEL_WAREHOUSES",
          strategy:
            params.input.allocationStrategy ?? "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        });
        newlyAllocated = alloc.allocations;
      }

      if (params.plan.releasedSlices.length > 0) {
        await deps.inventoryService.releaseAllocations(params.plan.releasedSlices);
      }

      return {
        newlyAllocated,
        released: params.plan.releasedSlices,
        finalShipments: [...params.plan.retainedSlices, ...newlyAllocated],
      };
    },
    compensate: async (output, params) => {
      if (output.newlyAllocated.length > 0) {
        await deps.inventoryService.releaseAllocations(output.newlyAllocated);
      }
      if (output.released.length > 0) {
        await deps.inventoryService.allocateForCheckout({
          demands: output.released.map((r) => ({
            lineId: r.lineId,
            variantId: r.variantId,
            quantity: r.quantityAllocated,
          })),
          availabilityMode:
            params.input.stockAvailabilityMode ?? "DIRECT_CHANNEL_WAREHOUSES",
          strategy:
            params.input.allocationStrategy ?? "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        });
      }
    },
  });

  const settleFinancialDeltaStep = createStep({
    name: "settle-financial-delta",
    invoke: async (params: {
      input: EditOrderInput;
      plan: VerifiedOrderEditPlan;
    }): Promise<{
      settlementKind: OrderEditRecord["settlementKind"];
      settlementTransactionId?: string;
      capturedDelta: MinorUnits;
      refundedDelta: MinorUnits;
    }> => {
      const delta = params.plan.deltaGross;
      if (delta === 0n) {
        return {
          settlementKind: "NO_FINANCIAL_DELTA",
          capturedDelta: 0n,
          refundedDelta: 0n,
        };
      }

      if (delta > 0n) {
        const cap = await deps.paymentGateway.capture({
          checkoutId: `${params.plan.originalOrder.checkoutId}_edit_${params.input.editId}`,
          amount: delta,
          currencyCode: params.plan.originalOrder.currencyCode,
          paymentToken:
            params.input.paymentTokenForIncrementalCapture ?? "tok_saved_payment_method",
        });
        return {
          settlementKind: "INCREMENTAL_CAPTURE",
          settlementTransactionId: cap.transactionId,
          capturedDelta: cap.capturedAmount,
          refundedDelta: 0n,
        };
      }

      const refundAmt = -delta;
      const origTx =
        params.plan.originalOrder.paymentTransactionId ??
        `tx_${params.plan.originalOrder.checkoutId}`;
      await deps.paymentGateway.voidOrRefund({
        checkoutId: params.plan.originalOrder.checkoutId,
        transactionId: origTx,
        amount: refundAmt,
      });
      return {
        settlementKind: "PARTIAL_REFUND",
        settlementTransactionId: `re_edit_${params.input.editId}`,
        capturedDelta: 0n,
        refundedDelta: refundAmt,
      };
    },
    compensate: async (output, params) => {
      if (output.capturedDelta > 0n && output.settlementTransactionId) {
        await deps.paymentGateway.voidOrRefund({
          checkoutId: params.plan.originalOrder.checkoutId,
          transactionId: output.settlementTransactionId,
          amount: output.capturedDelta,
        });
      } else if (output.refundedDelta > 0n) {
        await deps.paymentGateway.capture({
          checkoutId: `${params.plan.originalOrder.checkoutId}_reconcile_${params.input.editId}`,
          amount: output.refundedDelta,
          currencyCode: params.plan.originalOrder.currencyCode,
          paymentToken:
            params.input.paymentTokenForIncrementalCapture ?? "tok_saved_payment_method",
        });
      }
    },
  });

  const commitOrderEditStep = createStep({
    name: "commit-order-edit-and-ledger",
    invoke: async (params: {
      idempotencyKey: string;
      input: EditOrderInput;
      plan: VerifiedOrderEditPlan;
      finalShipments: readonly ShipmentSlice[];
      settlement: {
        settlementKind: OrderEditRecord["settlementKind"];
        settlementTransactionId?: string;
      };
    }): Promise<OrderEditRecord> => {
      if (params.input.simulateCommitFault) {
        throw new Error("ORDER_EDIT_COMMIT_FAULT");
      }

      const nowIso = new Date().toISOString();
      const orig = params.plan.originalOrder;
      const storeCreditUsed = orig.storeCreditRedeemedAmount ?? 0n;
      const nextPaymentCaptured =
        params.plan.revisedPricing.totalGrossAmount - storeCreditUsed;

      const revisedOrder: OrderRecord = {
        ...orig,
        pricing: params.plan.revisedPricing,
        shipments: params.finalShipments,
        paymentCapturedAmount: nextPaymentCaptured > 0n ? nextPaymentCaptured : 0n,
      };

      const editRecord: OrderEditRecord = {
        editId: params.input.editId,
        orderId: orig.orderId,
        editedBy: params.input.editedBy,
        reason: params.input.reason ?? "Pre-fulfillment order modification",
        previousGrossAmount: orig.pricing.totalGrossAmount,
        revisedGrossAmount: params.plan.revisedPricing.totalGrossAmount,
        deltaGrossAmount: params.plan.deltaGross,
        settlementKind: params.settlement.settlementKind,
        settlementTransactionId: params.settlement.settlementTransactionId,
        revisedOrder,
        createdAt: nowIso,
      };

      const subledger = new PgDoubleEntryLedgerService(deps.pgPool);

      await deps.pgPool.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE orders
           SET total_gross_amount = $1,
               allocations_json = $2::jsonb,
               payload_json = $3::jsonb,
               updated_at = $4::timestamptz
           WHERE id = $5`,
          [
            revisedOrder.pricing.totalGrossAmount.toString(),
            serializeWithBigInt(revisedOrder.shipments),
            serializeWithBigInt(revisedOrder),
            nowIso,
            revisedOrder.orderId,
          ]
        );

        await tx.query(`DELETE FROM order_lines WHERE order_id = $1`, [
          revisedOrder.orderId,
        ]);
        await persistNormalizedOrderLines(revisedOrder, tx);

        await tx.query(
          `INSERT INTO order_edits (
             edit_id, idempotency_key, order_id, edited_by, reason,
             previous_gross_amount, revised_gross_amount, delta_gross_amount,
             settlement_kind, settlement_transaction_id, diff_payload_json, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz)`,
          [
            editRecord.editId,
            params.idempotencyKey,
            editRecord.orderId,
            editRecord.editedBy,
            editRecord.reason,
            editRecord.previousGrossAmount.toString(),
            editRecord.revisedGrossAmount.toString(),
            editRecord.deltaGrossAmount.toString(),
            editRecord.settlementKind,
            editRecord.settlementTransactionId ?? null,
            serializeWithBigInt(editRecord),
            nowIso,
          ]
        );

        // Post balanced Double-Entry Subledger delta postings when financial totals changed
        const postings: LedgerPostingInput[] = [];
        const { deltaGross, deltaNetMerchandise, deltaShippingNet, deltaTax } = params.plan;

        if (deltaGross > 0n) {
          postings.push({
            accountCode: "CASH_GATEWAY_CLEARING",
            direction: "DEBIT",
            amount: deltaGross,
          });
        } else if (deltaGross < 0n) {
          postings.push({
            accountCode: "CASH_GATEWAY_CLEARING",
            direction: "CREDIT",
            amount: -deltaGross,
          });
        }

        if (deltaNetMerchandise > 0n) {
          postings.push({
            accountCode: "MERCHANT_SALES_REVENUE",
            direction: "CREDIT",
            amount: deltaNetMerchandise,
          });
        } else if (deltaNetMerchandise < 0n) {
          postings.push({
            accountCode: "MERCHANT_SALES_REVENUE",
            direction: "DEBIT",
            amount: -deltaNetMerchandise,
          });
        }

        if (deltaShippingNet > 0n) {
          postings.push({
            accountCode: "SHIPPING_REVENUE",
            direction: "CREDIT",
            amount: deltaShippingNet,
          });
        } else if (deltaShippingNet < 0n) {
          postings.push({
            accountCode: "SHIPPING_REVENUE",
            direction: "DEBIT",
            amount: -deltaShippingNet,
          });
        }

        if (deltaTax > 0n) {
          postings.push({
            accountCode: "SALES_TAX_PAYABLE",
            direction: "CREDIT",
            amount: deltaTax,
          });
        } else if (deltaTax < 0n) {
          postings.push({
            accountCode: "SALES_TAX_PAYABLE",
            direction: "DEBIT",
            amount: -deltaTax,
          });
        }

        if (postings.length > 0) {
          await subledger.recordJournalEntry(
            {
              idempotencyKey: `ledger:order_edit:${editRecord.editId}`,
              referenceType: "ORDER_EDIT_DELTA",
              referenceId: editRecord.editId,
              channelSlug: revisedOrder.channelSlug,
              currencyCode: revisedOrder.currencyCode,
              memo: `Order edit ${editRecord.editId} on ${revisedOrder.orderId}`,
              postings,
            },
            tx
          );
        }

        await deps.outboxService.enqueue(
          {
            eventType: "order.edited.v1",
            aggregateType: "Order",
            aggregateId: revisedOrder.orderId,
            channelSlug: revisedOrder.channelSlug,
            payload: {
              editId: editRecord.editId,
              orderId: revisedOrder.orderId,
              previousGrossAmount: editRecord.previousGrossAmount.toString(),
              revisedGrossAmount: editRecord.revisedGrossAmount.toString(),
              deltaGrossAmount: editRecord.deltaGrossAmount.toString(),
              settlementKind: editRecord.settlementKind,
            },
          },
          tx
        );
      });

      return editRecord;
    },
  });

  return createWorkflow(
    "edit-unfulfilled-order",
    async (input: EditOrderInput, ctx): Promise<OrderEditRecord> => {
      const plan = await ctx.run(validateAndRepriceStep, input);
      const invDelta = await ctx.run(reconcileMsiInventoryDeltaStep, { input, plan });
      const settlement = await ctx.run(settleFinancialDeltaStep, { input, plan });
      return await ctx.run(commitOrderEditStep, {
        idempotencyKey: ctx.idempotencyKey,
        input,
        plan,
        finalShipments: invDelta.finalShipments,
        settlement,
      });
    }
  );
}
