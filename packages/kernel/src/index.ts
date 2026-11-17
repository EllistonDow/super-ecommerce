/**
 * `@super-ecommerce/kernel`
 *
 * Unified entry point that automatically routes calls into the compiled Rust
 * `commerce-kernel` N-API binary (`commerce_kernel.node`) on Node.js / Bun,
 * exposes the portable WebAssembly pricing kernel (`wasm-kernel.ts`) for Edge / Browser,
 * and retains the BigInt isomorphic implementation as a zero-float fallback.
 */

import {
  allocateProRataViaRust,
  benchmarkNativeRustKernel,
  calculateCartViaRust,
  calculateReturnRefundViaRust,
  evaluateB2bPurchasePolicyViaRust,
  getNativeRustKernel,
  isNativeRustKernelLoaded,
  planInventoryAllocationViaRust,
  type NativeRustKernelBenchmarkStats,
  type RustMsiPlanningInput,
  type RustMsiPlanningResult,
} from "./rust-bridge.ts";
import {
  buildCommerceKernelWasmBytes,
  instantiateWasmPricingKernel,
  type WasmPricingKernelInstance,
} from "./wasm-kernel.ts";
import {
  runKernelBenchmarkSuite,
  type BenchmarkTierReport,
  type KernelBenchmarkSuiteReport,
} from "./benchmark.ts";

export {
  isNativeRustKernelLoaded,
  benchmarkNativeRustKernel,
  runKernelBenchmarkSuite,
  buildCommerceKernelWasmBytes,
  instantiateWasmPricingKernel,
  type WasmPricingKernelInstance,
  type NativeRustKernelBenchmarkStats,
  type BenchmarkTierReport,
  type KernelBenchmarkSuiteReport,
  type RustMsiPlanningInput,
  type RustMsiPlanningResult,
};

export type MinorUnits = bigint;
export type Bps = number;

export const MAX_BPS = 10_000n;

export interface PriceTier {
  readonly minQuantity: number;
  readonly unitAmount: MinorUnits;
}

export interface WeightedItem {
  readonly id: string;
  readonly weight: MinorUnits;
}

export interface AllocatedShare {
  readonly id: string;
  readonly allocated: MinorUnits;
}

export type DiscountValue =
  | { readonly type: "FIXED"; readonly amount: MinorUnits }
  | { readonly type: "PERCENTAGE"; readonly bps: Bps };

export type LineDiscountKind =
  | "CATALOGUE_PROMOTION"
  | "VOUCHER_LINE"
  | "MANUAL_LINE"
  | "ORDER_PROMOTION_GIFT";

export type OrderDiscountKind =
  | "ORDER_PROMOTION"
  | "ORDER_VOUCHER"
  | "MANUAL_ORDER"
  | "SHIPPING_VOUCHER";

export type TaxInclusionMode = "TAX_EXCLUSIVE" | "TAX_INCLUSIVE";

export interface CandidateLineDiscount {
  readonly discountId: string;
  readonly name: string;
  readonly kind: LineDiscountKind;
  readonly value: DiscountValue;
}

export interface CandidateOrderDiscount {
  readonly discountId: string;
  readonly name: string;
  readonly kind: OrderDiscountKind;
  readonly value: DiscountValue;
}

export interface CartLineInput {
  readonly lineId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly baseUnitPrice: MinorUnits;
  readonly tierPrices?: readonly PriceTier[];
  readonly taxRateBps: Bps;
  readonly isGift?: boolean;
  readonly candidateLineDiscounts?: readonly CandidateLineDiscount[];
}

export interface CartCalculationInput {
  readonly currencyCode: string;
  readonly taxMode: TaxInclusionMode;
  readonly shippingBaseAmount: MinorUnits;
  readonly shippingTaxRateBps: Bps;
  readonly lines: readonly CartLineInput[];
  readonly candidateOrderDiscounts?: readonly CandidateOrderDiscount[];
}

export interface LineDiscountAttribution {
  readonly discountId: string;
  readonly name: string;
  readonly isOrderLevel: boolean;
  readonly amount: MinorUnits;
}

export interface CalculatedLineResult {
  readonly lineId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly isGift: boolean;
  readonly effectiveBaseUnitPrice: MinorUnits;
  readonly undiscountedLineSubtotal: MinorUnits;
  readonly lineLevelDiscountAmount: MinorUnits;
  readonly subtotalAfterLineDiscount: MinorUnits;
  readonly allocatedOrderDiscountAmount: MinorUnits;
  readonly discountAttributions: readonly LineDiscountAttribution[];
  readonly totalNetAmount: MinorUnits;
  readonly totalTaxAmount: MinorUnits;
  readonly totalGrossAmount: MinorUnits;
}

export interface AppliedOrderDiscountSummary {
  readonly discountId: string;
  readonly name: string;
  readonly kind: OrderDiscountKind;
  readonly totalAmount: MinorUnits;
}

export interface CartCalculationResult {
  readonly currencyCode: string;
  readonly lines: readonly CalculatedLineResult[];
  readonly appliedOrderDiscounts: readonly AppliedOrderDiscountSummary[];
  readonly shippingUndiscountedAmount: MinorUnits;
  readonly shippingDiscountAmount: MinorUnits;
  readonly shippingNetAmount: MinorUnits;
  readonly shippingTaxAmount: MinorUnits;
  readonly shippingGrossAmount: MinorUnits;
  readonly totalNetAmount: MinorUnits;
  readonly totalTaxAmount: MinorUnits;
  readonly totalGrossAmount: MinorUnits;
}

export function divRoundHalfUp(numerator: bigint, denominator: bigint): MinorUnits {
  if (numerator <= 0n || denominator <= 0n) {
    return 0n;
  }
  return (numerator + denominator / 2n) / denominator;
}

export function applyBps(amount: MinorUnits, bps: Bps): MinorUnits {
  if (amount <= 0n || bps <= 0) {
    return 0n;
  }
  const native = getNativeRustKernel();
  if (native) {
    return native.rustApplyBps(amount, Math.min(Math.floor(bps), 10_000));
  }
  const clampedBps = BigInt(Math.min(Math.floor(bps), 10_000));
  return divRoundHalfUp(amount * clampedBps, MAX_BPS);
}

export function resolveTierUnitPrice(
  baseUnitPrice: MinorUnits,
  quantity: number,
  tiers: readonly PriceTier[] = []
): MinorUnits {
  let best = baseUnitPrice > 0n ? baseUnitPrice : 0n;
  for (const tier of tiers) {
    if (quantity >= tier.minQuantity && tier.unitAmount >= 0n && tier.unitAmount < best) {
      best = tier.unitAmount;
    }
  }
  return best;
}

export function allocateProRata(
  totalToAllocate: MinorUnits,
  items: readonly WeightedItem[]
): AllocatedShare[] {
  const native = getNativeRustKernel();
  if (native) {
    return allocateProRataViaRust(native, totalToAllocate, items);
  }
  return allocateProRataIsomorphic(totalToAllocate, items);
}

export function allocateProRataIsomorphic(
  totalToAllocate: MinorUnits,
  items: readonly WeightedItem[]
): AllocatedShare[] {
  if (items.length === 0) {
    return [];
  }

  let totalWeight = 0n;
  for (const item of items) {
    if (item.weight > 0n) {
      totalWeight += item.weight;
    }
  }

  if (totalToAllocate <= 0n || totalWeight <= 0n) {
    return items.map((item) => ({ id: item.id, allocated: 0n }));
  }

  const cappedTotal = totalToAllocate < totalWeight ? totalToAllocate : totalWeight;

  interface Slot {
    originalIndex: number;
    id: string;
    floorShare: MinorUnits;
    remainder: bigint;
  }

  const slots: Slot[] = [];
  let sumFloors = 0n;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const w = item.weight > 0n ? item.weight : 0n;
    const numerator = cappedTotal * w;
    const floorShare = numerator / totalWeight;
    const remainder = numerator % totalWeight;
    sumFloors += floorShare;
    slots.push({
      originalIndex: i,
      id: item.id,
      floorShare,
      remainder,
    });
  }

  const remainderUnits = Number(cappedTotal - sumFloors);

  slots.sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder > a.remainder ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (let i = 0; i < remainderUnits; i++) {
    slots[i]!.floorShare += 1n;
  }

  slots.sort((a, b) => a.originalIndex - b.originalIndex);

  return slots.map((s) => ({
    id: s.id,
    allocated: s.floorShare,
  }));
}

export function calculateCart(input: CartCalculationInput): CartCalculationResult {
  const native = getNativeRustKernel();
  if (native) {
    return calculateCartViaRust(native, input);
  }
  throw new Error("Native Rust kernel not loaded");
}

export function planInventoryAllocation(
  input: RustMsiPlanningInput
): RustMsiPlanningResult {
  const native = getNativeRustKernel();
  if (native) {
    return planInventoryAllocationViaRust(native, input);
  }
  throw new Error("Native Rust kernel not loaded");
}

export type RefundTenderPriority = "GATEWAY_CASH_FIRST" | "STORE_CREDIT_FIRST";

export interface RefundLineInput {
  readonly lineId: string;
  readonly variantId: string;
  readonly originalQuantity: number;
  readonly alreadyReturnedQuantity: number;
  readonly returnQuantityRequested: number;
  readonly isGift?: boolean;
  readonly originalNetAmount: MinorUnits;
  readonly originalTaxAmount: MinorUnits;
  readonly originalGrossAmount: MinorUnits;
  readonly alreadyRefundedNetAmount?: MinorUnits;
  readonly alreadyRefundedTaxAmount?: MinorUnits;
  readonly alreadyRefundedGrossAmount?: MinorUnits;
  readonly restockingFeeBps?: Bps;
}

export interface RefundCalculationInput {
  readonly currencyCode: string;
  readonly lines: readonly RefundLineInput[];
  readonly refundShipping?: boolean;
  readonly shippingOriginalNetAmount?: MinorUnits;
  readonly shippingOriginalTaxAmount?: MinorUnits;
  readonly shippingOriginalGrossAmount?: MinorUnits;
  readonly shippingAlreadyRefundedGrossAmount?: MinorUnits;
  readonly paymentGatewayOriginallyCaptured: MinorUnits;
  readonly paymentGatewayAlreadyRefunded?: MinorUnits;
  readonly storeCreditOriginallyRedeemed?: MinorUnits;
  readonly storeCreditAlreadyRefunded?: MinorUnits;
  readonly tenderPriority?: RefundTenderPriority;
}

export interface CalculatedRefundLineResult {
  readonly lineId: string;
  readonly variantId: string;
  readonly isGift: boolean;
  readonly originalQuantity: number;
  readonly alreadyReturnedQuantity: number;
  readonly acceptedReturnQuantity: number;
  readonly remainingReturnableQuantity: number;
  readonly isFinalUnitReconciliation: boolean;
  readonly netCeilingConsumed: MinorUnits;
  readonly taxCeilingConsumed: MinorUnits;
  readonly grossCeilingConsumed: MinorUnits;
  readonly restockingFeeAmount: MinorUnits;
  readonly refundNetAmount: MinorUnits;
  readonly refundTaxAmount: MinorUnits;
  readonly refundGrossAmount: MinorUnits;
}

export interface RefundCalculationResult {
  readonly currencyCode: string;
  readonly lines: readonly CalculatedRefundLineResult[];
  readonly shippingRefundNetAmount: MinorUnits;
  readonly shippingRefundTaxAmount: MinorUnits;
  readonly shippingRefundGrossAmount: MinorUnits;
  readonly totalGrossCeilingConsumed: MinorUnits;
  readonly totalRestockingFeeAmount: MinorUnits;
  readonly totalRefundNetAmount: MinorUnits;
  readonly totalRefundTaxAmount: MinorUnits;
  readonly totalRefundGrossAmount: MinorUnits;
  readonly paymentGatewayRefundAmount: MinorUnits;
  readonly storeCreditRefundAmount: MinorUnits;
  readonly unallocatedRefundOverflow: MinorUnits;
}

export function calculateReturnRefund(
  input: RefundCalculationInput
): RefundCalculationResult {
  const native = getNativeRustKernel();
  if (native) {
    return calculateReturnRefundViaRust(native, input);
  }
  throw new Error("Native Rust kernel not loaded");
}

// ============================================================================
// 5. Enterprise B2B Organization, Tax Exemption & Net-Terms Credit Kernel
// ============================================================================

export type B2bPaymentTerms = "NET_30" | "NET_60" | "PREPAID_ONLY";
export type B2bBuyerRole = "BUYER" | "APPROVER" | "COMPANY_ADMIN";
export type B2bPolicyDecisionStatus =
  | "APPROVED_AUTO"
  | "PENDING_APPROVAL"
  | "REJECTED_COMPANY_CREDIT_EXCEEDED";

export interface B2bCompanyPolicyInput {
  readonly companyId: string;
  readonly paymentTerms: B2bPaymentTerms;
  readonly creditLimit: MinorUnits;
  readonly creditUsed: MinorUnits;
  readonly creditReserved?: MinorUnits;
  readonly contractDiscountBps?: Bps;
  readonly taxExemptVerified?: boolean;
}

export interface B2bCostCenterPolicyInput {
  readonly costCenterId: string;
  readonly monthlyBudget: MinorUnits;
  readonly monthlySpent: MinorUnits;
  readonly monthlyReserved?: MinorUnits;
}

export interface B2bBuyerPolicyInput {
  readonly buyerId: string;
  readonly role: B2bBuyerRole;
  readonly singleOrderAutoApproveLimit: MinorUnits;
}

export interface B2bPurchasePolicyInput {
  readonly company: B2bCompanyPolicyInput;
  readonly costCenter: B2bCostCenterPolicyInput;
  readonly buyer: B2bBuyerPolicyInput;
  readonly cart: CartCalculationInput;
}

export interface B2bPurchasePolicyResult {
  readonly decision: B2bPolicyDecisionStatus;
  readonly approvalReasons: readonly string[];
  readonly pricing: CartCalculationResult;
  readonly standardTaxAmountWithoutExemption: MinorUnits;
  readonly taxExemptSavingsAmount: MinorUnits;
  readonly availableCompanyCreditBefore: MinorUnits;
  readonly availableCompanyCreditAfter: MinorUnits;
  readonly availableCostCenterBudgetBefore: MinorUnits;
  readonly availableCostCenterBudgetAfter: MinorUnits;
  readonly netTermsDueDays: number;
  readonly recommendedReservationTtlSeconds: number;
}

export function evaluateB2bPurchasePolicy(
  input: B2bPurchasePolicyInput
): B2bPurchasePolicyResult {
  const native = getNativeRustKernel();
  if (native) {
    return evaluateB2bPurchasePolicyViaRust(native, input);
  }
  throw new Error("Native Rust kernel not loaded");
}

