/**
 * Native Rust N-API (`.node`) Bridge & Shared Escaped Wire Codec for `@super-ecommerce/kernel`.
 *
 * Dynamically loads `../native/commerce_kernel.node` (compiled from `crates/kernel-napi`
 * + `crates/commerce-kernel`) when running on Node.js / Bun.
 * All record strings are losslessly escaped (`\\`, `\t`, `\n`, `\r`) to prevent
 * control-character injection across both N-API and WASM boundaries.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AllocatedShare,
  AppliedOrderDiscountSummary,
  B2bPurchasePolicyInput,
  B2bPurchasePolicyResult,
  CalculatedLineResult,
  CalculatedRefundLineResult,
  CartCalculationInput,
  CartCalculationResult,
  LineDiscountAttribution,
  MinorUnits,
  OrderDiscountKind,
  RefundCalculationInput,
  RefundCalculationResult,
  WeightedItem,
} from "./index.ts";

export interface NativeRustKernelBinding {
  rustApplyBps(amount: bigint, bps: number): bigint;
  rustCurrencyExponent(currencyCode: string): number;
  rustFormatMinorUnits(amount: bigint, currencyCode: string): string;
  rustAllocateProRata(totalToAllocate: bigint, encodedItems: string): string;
  rustCalculateCart(encodedCart: string): string;
  rustPlanInventoryAllocation(encodedMsi: string): string;
  rustBenchmarkKernel(iterations: number): string;
  rustCalculateReturnRefund(encodedRma: string): string;
  rustEvaluateB2bPurchasePolicy(encodedB2b: string): string;
}

export function escapeWireField(raw: string): string {
  let needsEscape = false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || code === 92) {
      needsEscape = true;
      break;
    }
  }
  if (!needsEscape) {
    return raw;
  }
  return raw
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

export function unescapeWireField(escaped: string): string {
  if (!escaped.includes("\\")) {
    return escaped;
  }
  let out = "";
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped[i]!;
    if (ch === "\\" && i + 1 < escaped.length) {
      const next = escaped[++i]!;
      if (next === "t") out += "\t";
      else if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "\\") out += "\\";
      else out += "\\" + next;
    } else {
      out += ch;
    }
  }
  return out;
}

let cachedNativeBinding: NativeRustKernelBinding | null | undefined;

export function getNativeRustKernel(): NativeRustKernelBinding | null {
  if (cachedNativeBinding !== undefined) {
    return cachedNativeBinding;
  }
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const addonPath = join(__dirname, "../native/commerce_kernel.node");
    if (!existsSync(addonPath)) {
      cachedNativeBinding = null;
      return null;
    }
    const requireFn = createRequire(import.meta.url);
    cachedNativeBinding = requireFn(addonPath) as NativeRustKernelBinding;
    return cachedNativeBinding;
  } catch {
    cachedNativeBinding = null;
    return null;
  }
}

export function isNativeRustKernelLoaded(): boolean {
  return getNativeRustKernel() !== null;
}

export function encodeProRataPayload(items: readonly WeightedItem[]): string {
  return items
    .map((i) => `${escapeWireField(i.id)}\t${i.weight.toString()}`)
    .join("\n");
}

export function decodeProRataPayload(rawOut: string): AllocatedShare[] {
  if (!rawOut.trim()) return [];
  return rawOut.split("\n").map((line) => {
    const [id, allocStr] = line.split("\t");
    return {
      id: unescapeWireField(id ?? ""),
      allocated: BigInt(allocStr ?? "0"),
    };
  });
}

export function allocateProRataViaRust(
  binding: NativeRustKernelBinding,
  totalToAllocate: MinorUnits,
  items: readonly WeightedItem[]
): AllocatedShare[] {
  if (items.length === 0) return [];
  const rawOut = binding.rustAllocateProRata(totalToAllocate, encodeProRataPayload(items));
  return decodeProRataPayload(rawOut);
}

export function encodeCartPayload(input: CartCalculationInput): string {
  const records: string[] = [];
  records.push(
    `CART\t${escapeWireField(input.currencyCode)}\t${input.taxMode}\t${input.shippingBaseAmount.toString()}\t${Math.floor(input.shippingTaxRateBps)}`
  );

  for (const line of input.lines) {
    const costCol =
      line.unitCostAmount !== undefined ? line.unitCostAmount.toString() : "";
    const minMarginCol =
      line.minMarginBps !== undefined ? Math.floor(line.minMarginBps).toString() : "0";
    records.push(
      `LINE\t${escapeWireField(line.lineId)}\t${escapeWireField(line.variantId)}\t${line.quantity}\t${line.baseUnitPrice.toString()}\t${Math.floor(line.taxRateBps)}\t${line.isGift ? 1 : 0}\t${costCol}\t${minMarginCol}`
    );
    for (const tier of line.tierPrices ?? []) {
      records.push(
        `TIER\t${escapeWireField(line.lineId)}\t${tier.minQuantity}\t${tier.unitAmount.toString()}`
      );
    }
    for (const ld of line.candidateLineDiscounts ?? []) {
      const valType = ld.value.type;
      const valNum =
        ld.value.type === "FIXED"
          ? ld.value.amount.toString()
          : Math.floor(ld.value.bps).toString();
      records.push(
        `LDISC\t${escapeWireField(line.lineId)}\t${escapeWireField(ld.discountId)}\t${escapeWireField(ld.name)}\t${ld.kind}\t${valType}\t${valNum}`
      );
    }
  }

  for (const od of input.candidateOrderDiscounts ?? []) {
    const valType = od.value.type;
    const valNum =
      od.value.type === "FIXED"
        ? od.value.amount.toString()
        : Math.floor(od.value.bps).toString();
    records.push(
      `ODISC\t${escapeWireField(od.discountId)}\t${escapeWireField(od.name)}\t${od.kind}\t${valType}\t${valNum}`
    );
  }

  return records.join("\n");
}

export function decodeCartPayload(
  rawOut: string,
  fallbackCurrencyCode: string
): CartCalculationResult {
  let currencyCode = fallbackCurrencyCode;
  let shippingUndiscountedAmount = 0n;
  let shippingDiscountAmount = 0n;
  let shippingNetAmount = 0n;
  let shippingTaxAmount = 0n;
  let shippingGrossAmount = 0n;
  let totalNetAmount = 0n;
  let totalTaxAmount = 0n;
  let totalGrossAmount = 0n;

  const appliedOrderDiscounts: AppliedOrderDiscountSummary[] = [];
  const lineMap = new Map<
    string,
    {
      base: Omit<CalculatedLineResult, "discountAttributions">;
      attributions: LineDiscountAttribution[];
    }
  >();

  for (const row of rawOut.split("\n")) {
    if (!row.trim()) continue;
    const cols = row.split("\t");
    const tag = cols[0];

    if (tag === "TOTALS" && cols.length >= 10) {
      currencyCode = unescapeWireField(cols[1]!);
      shippingUndiscountedAmount = BigInt(cols[2]!);
      shippingDiscountAmount = BigInt(cols[3]!);
      shippingNetAmount = BigInt(cols[4]!);
      shippingTaxAmount = BigInt(cols[5]!);
      shippingGrossAmount = BigInt(cols[6]!);
      totalNetAmount = BigInt(cols[7]!);
      totalTaxAmount = BigInt(cols[8]!);
      totalGrossAmount = BigInt(cols[9]!);
    } else if (tag === "APPLIED_ODISC" && cols.length >= 5) {
      appliedOrderDiscounts.push({
        discountId: unescapeWireField(cols[1]!),
        name: unescapeWireField(cols[2]!),
        kind: cols[3] as OrderDiscountKind,
        totalAmount: BigInt(cols[4]!),
      });
    } else if (tag === "LINE_RES" && cols.length >= 13) {
      const lineId = unescapeWireField(cols[1]!);
      lineMap.set(lineId, {
        base: {
          lineId,
          variantId: unescapeWireField(cols[2]!),
          quantity: Number(cols[3]!),
          isGift: cols[4] === "1",
          effectiveBaseUnitPrice: BigInt(cols[5]!),
          undiscountedLineSubtotal: BigInt(cols[6]!),
          lineLevelDiscountAmount: BigInt(cols[7]!),
          subtotalAfterLineDiscount: BigInt(cols[8]!),
          allocatedOrderDiscountAmount: BigInt(cols[9]!),
          marginGuardClampedAmount: cols.length >= 14 ? BigInt(cols[13]!) : 0n,
          totalNetAmount: BigInt(cols[10]!),
          totalTaxAmount: BigInt(cols[11]!),
          totalGrossAmount: BigInt(cols[12]!),
        },
        attributions: [],
      });
    } else if (tag === "LINE_ATTR" && cols.length >= 6) {
      const targetLine = lineMap.get(unescapeWireField(cols[1]!));
      if (targetLine) {
        targetLine.attributions.push({
          discountId: unescapeWireField(cols[2]!),
          name: unescapeWireField(cols[3]!),
          isOrderLevel: cols[4] === "1",
          amount: BigInt(cols[5]!),
        });
      }
    }
  }

  const lines: CalculatedLineResult[] = Array.from(lineMap.values()).map((entry) => ({
    ...entry.base,
    discountAttributions: entry.attributions,
  }));

  return {
    currencyCode,
    lines,
    appliedOrderDiscounts,
    shippingUndiscountedAmount,
    shippingDiscountAmount,
    shippingNetAmount,
    shippingTaxAmount,
    shippingGrossAmount,
    totalNetAmount,
    totalTaxAmount,
    totalGrossAmount,
  };
}

export function calculateCartViaRust(
  binding: NativeRustKernelBinding,
  input: CartCalculationInput
): CartCalculationResult {
  const rawOut = binding.rustCalculateCart(encodeCartPayload(input));
  return decodeCartPayload(rawOut, input.currencyCode);
}

export interface RustMsiPlanningInput {
  readonly availabilityMode: "DIRECT_CHANNEL_WAREHOUSES" | "SHIPPING_ZONE_INTERSECTION";
  readonly strategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK" | "PRIORITIZE_RANK_ORDER";
  readonly slots: readonly {
    readonly warehouseId: string;
    readonly priorityRank: number;
    readonly linkedToChannel: boolean;
    readonly supportsShippingZone: boolean;
    readonly variantId: string;
    readonly onHand: number;
    readonly reserved: number;
    readonly allocated: number;
  }[];
  readonly demands: readonly {
    readonly lineId: string;
    readonly variantId: string;
    readonly quantity: number;
  }[];
}

export interface RustMsiPlanningResult {
  readonly isFullyAllocated: boolean;
  readonly shipmentCount: number;
  readonly allocations: readonly {
    readonly warehouseId: string;
    readonly lineId: string;
    readonly variantId: string;
    readonly quantityAllocated: number;
  }[];
  readonly unallocatedLines: readonly {
    readonly lineId: string;
    readonly variantId: string;
    readonly missingQuantity: number;
  }[];
}

export function planInventoryAllocationViaRust(
  binding: NativeRustKernelBinding,
  input: RustMsiPlanningInput
): RustMsiPlanningResult {
  const lines: string[] = [];
  lines.push(`CFG\t${input.availabilityMode}\t${input.strategy}`);
  for (const s of input.slots) {
    lines.push(
      `SLOT\t${escapeWireField(s.warehouseId)}\t${s.priorityRank}\t${s.linkedToChannel ? 1 : 0}\t${s.supportsShippingZone ? 1 : 0}\t${escapeWireField(s.variantId)}\t${s.onHand}\t${s.reserved}\t${s.allocated}`
    );
  }
  for (const d of input.demands) {
    lines.push(
      `DEMAND\t${escapeWireField(d.lineId)}\t${escapeWireField(d.variantId)}\t${d.quantity}`
    );
  }

  const rawOut = binding.rustPlanInventoryAllocation(lines.join("\n"));
  let isFullyAllocated = false;
  let shipmentCount = 0;
  const allocations: {
    warehouseId: string;
    lineId: string;
    variantId: string;
    quantityAllocated: number;
  }[] = [];
  const unallocatedLines: {
    lineId: string;
    variantId: string;
    missingQuantity: number;
  }[] = [];

  for (const row of rawOut.split("\n")) {
    if (!row.trim()) continue;
    const cols = row.split("\t");
    if (cols[0] === "PLAN") {
      isFullyAllocated = cols[1] === "1";
      shipmentCount = Number(cols[2] ?? "0");
    } else if (cols[0] === "ALLOC" && cols.length >= 5) {
      allocations.push({
        warehouseId: unescapeWireField(cols[1]!),
        lineId: unescapeWireField(cols[2]!),
        variantId: unescapeWireField(cols[3]!),
        quantityAllocated: Number(cols[4]!),
      });
    } else if (cols[0] === "SHORTFALL" && cols.length >= 6) {
      unallocatedLines.push({
        lineId: unescapeWireField(cols[1]!),
        variantId: unescapeWireField(cols[2]!),
        missingQuantity: Number(cols[5]!),
      });
    }
  }

  return {
    isFullyAllocated,
    shipmentCount,
    allocations,
    unallocatedLines,
  };
}

export interface NativeRustKernelBenchmarkStats {
  readonly iterations: number;
  readonly totalNanoseconds: number;
  readonly perOpNanoseconds: number;
  readonly opsPerSecond: number;
  readonly checksum: string;
}

export function benchmarkNativeRustKernel(
  iterations = 50_000
): NativeRustKernelBenchmarkStats {
  const binding = getNativeRustKernel();
  if (!binding) {
    throw new Error("Native Rust kernel not loaded");
  }
  const raw = binding.rustBenchmarkKernel(iterations);
  const [totalNsStr, perOpNsStr, opsPerSecStr, checksumStr] = raw.split("\t");
  return {
    iterations,
    totalNanoseconds: Number(totalNsStr ?? "0"),
    perOpNanoseconds: Number(perOpNsStr ?? "0"),
    opsPerSecond: Number(opsPerSecStr ?? "0"),
    checksum: checksumStr ?? "0",
  };
}

export function encodeReturnRefundPayload(input: RefundCalculationInput): string {
  const rows: string[] = [];
  const shipOrigNet = input.shippingOriginalNetAmount ?? 0n;
  const shipOrigTax = input.shippingOriginalTaxAmount ?? 0n;
  const shipOrigGross = input.shippingOriginalGrossAmount ?? 0n;
  const shipAlreadyRef = input.shippingAlreadyRefundedGrossAmount ?? 0n;
  const gwOrigCaptured = input.paymentGatewayOriginallyCaptured;
  const gwAlreadyRef = input.paymentGatewayAlreadyRefunded ?? 0n;
  const scOrigRedeemed = input.storeCreditOriginallyRedeemed ?? 0n;
  const scAlreadyRef = input.storeCreditAlreadyRefunded ?? 0n;
  const tenderPriority = input.tenderPriority ?? "GATEWAY_CASH_FIRST";

  rows.push(
    [
      "RMA_CFG",
      escapeWireField(input.currencyCode),
      input.refundShipping ? "1" : "0",
      shipOrigNet.toString(),
      shipOrigTax.toString(),
      shipOrigGross.toString(),
      shipAlreadyRef.toString(),
      gwOrigCaptured.toString(),
      gwAlreadyRef.toString(),
      scOrigRedeemed.toString(),
      scAlreadyRef.toString(),
      tenderPriority,
    ].join("\t")
  );

  for (const line of input.lines) {
    rows.push(
      [
        "RMA_LINE",
        escapeWireField(line.lineId),
        escapeWireField(line.variantId),
        Math.floor(line.originalQuantity),
        Math.floor(line.alreadyReturnedQuantity),
        Math.floor(line.returnQuantityRequested),
        line.isGift ? "1" : "0",
        line.originalNetAmount.toString(),
        line.originalTaxAmount.toString(),
        line.originalGrossAmount.toString(),
        (line.alreadyRefundedNetAmount ?? 0n).toString(),
        (line.alreadyRefundedTaxAmount ?? 0n).toString(),
        (line.alreadyRefundedGrossAmount ?? 0n).toString(),
        Math.floor(line.restockingFeeBps ?? 0),
      ].join("\t")
    );
  }
  return rows.join("\n");
}

export function decodeReturnRefundPayload(
  rawOut: string,
  fallbackCurrencyCode: string
): RefundCalculationResult {
  let currencyCode = fallbackCurrencyCode;
  let shippingRefundNetAmount = 0n;
  let shippingRefundTaxAmount = 0n;
  let shippingRefundGrossAmount = 0n;
  let totalGrossCeilingConsumed = 0n;
  let totalRestockingFeeAmount = 0n;
  let totalRefundNetAmount = 0n;
  let totalRefundTaxAmount = 0n;
  let totalRefundGrossAmount = 0n;
  let paymentGatewayRefundAmount = 0n;
  let storeCreditRefundAmount = 0n;
  let unallocatedRefundOverflow = 0n;
  const lines: CalculatedRefundLineResult[] = [];

  for (const row of rawOut.split("\n")) {
    if (!row.trim()) continue;
    const cols = row.split("\t");
    if (cols[0] === "RMA_TOTALS" && cols.length >= 13) {
      currencyCode = unescapeWireField(cols[1]!);
      shippingRefundNetAmount = BigInt(cols[2]!);
      shippingRefundTaxAmount = BigInt(cols[3]!);
      shippingRefundGrossAmount = BigInt(cols[4]!);
      totalGrossCeilingConsumed = BigInt(cols[5]!);
      totalRestockingFeeAmount = BigInt(cols[6]!);
      totalRefundNetAmount = BigInt(cols[7]!);
      totalRefundTaxAmount = BigInt(cols[8]!);
      totalRefundGrossAmount = BigInt(cols[9]!);
      paymentGatewayRefundAmount = BigInt(cols[10]!);
      storeCreditRefundAmount = BigInt(cols[11]!);
      unallocatedRefundOverflow = BigInt(cols[12]!);
    } else if (cols[0] === "RMA_LINE_RES" && cols.length >= 16) {
      lines.push({
        lineId: unescapeWireField(cols[1]!),
        variantId: unescapeWireField(cols[2]!),
        isGift: cols[3] === "1",
        originalQuantity: Number(cols[4]!),
        alreadyReturnedQuantity: Number(cols[5]!),
        acceptedReturnQuantity: Number(cols[6]!),
        remainingReturnableQuantity: Number(cols[7]!),
        isFinalUnitReconciliation: cols[8] === "1",
        netCeilingConsumed: BigInt(cols[9]!),
        taxCeilingConsumed: BigInt(cols[10]!),
        grossCeilingConsumed: BigInt(cols[11]!),
        restockingFeeAmount: BigInt(cols[12]!),
        refundNetAmount: BigInt(cols[13]!),
        refundTaxAmount: BigInt(cols[14]!),
        refundGrossAmount: BigInt(cols[15]!),
      });
    }
  }

  return {
    currencyCode,
    lines,
    shippingRefundNetAmount,
    shippingRefundTaxAmount,
    shippingRefundGrossAmount,
    totalGrossCeilingConsumed,
    totalRestockingFeeAmount,
    totalRefundNetAmount,
    totalRefundTaxAmount,
    totalRefundGrossAmount,
    paymentGatewayRefundAmount,
    storeCreditRefundAmount,
    unallocatedRefundOverflow,
  };
}

export function calculateReturnRefundViaRust(
  binding: NativeRustKernelBinding,
  input: RefundCalculationInput
): RefundCalculationResult {
  const rawOut = binding.rustCalculateReturnRefund(encodeReturnRefundPayload(input));
  return decodeReturnRefundPayload(rawOut, input.currencyCode);
}

export function encodeB2bPolicyPayload(input: B2bPurchasePolicyInput): string {
  const records: string[] = [];
  records.push(
    [
      "B2B_COMPANY",
      escapeWireField(input.company.companyId),
      input.company.paymentTerms,
      input.company.creditLimit.toString(),
      input.company.creditUsed.toString(),
      (input.company.creditReserved ?? 0n).toString(),
      Math.floor(input.company.contractDiscountBps ?? 0),
      input.company.taxExemptVerified ? "1" : "0",
    ].join("\t")
  );
  records.push(
    [
      "B2B_CC",
      escapeWireField(input.costCenter.costCenterId),
      input.costCenter.monthlyBudget.toString(),
      input.costCenter.monthlySpent.toString(),
      (input.costCenter.monthlyReserved ?? 0n).toString(),
    ].join("\t")
  );
  records.push(
    [
      "B2B_BUYER",
      escapeWireField(input.buyer.buyerId),
      input.buyer.role,
      input.buyer.singleOrderAutoApproveLimit.toString(),
    ].join("\t")
  );
  records.push(encodeCartPayload(input.cart));
  return records.join("\n");
}

export function decodeB2bPolicyPayload(
  rawOut: string,
  fallbackCurrencyCode: string
): B2bPurchasePolicyResult {
  let decision: B2bPurchasePolicyResult["decision"] = "APPROVED_AUTO";
  let standardTaxAmountWithoutExemption = 0n;
  let taxExemptSavingsAmount = 0n;
  let availableCompanyCreditBefore = 0n;
  let availableCompanyCreditAfter = 0n;
  let availableCostCenterBudgetBefore = 0n;
  let availableCostCenterBudgetAfter = 0n;
  let netTermsDueDays = 30;
  let recommendedReservationTtlSeconds = 900;
  const approvalReasons: string[] = [];

  for (const row of rawOut.split("\n")) {
    if (!row.trim()) continue;
    const cols = row.split("\t");
    const tag = cols[0];
    if (tag === "B2B_DECISION" && cols.length >= 10) {
      decision = cols[1] as B2bPurchasePolicyResult["decision"];
      standardTaxAmountWithoutExemption = BigInt(cols[2]!);
      taxExemptSavingsAmount = BigInt(cols[3]!);
      availableCompanyCreditBefore = BigInt(cols[4]!);
      availableCompanyCreditAfter = BigInt(cols[5]!);
      availableCostCenterBudgetBefore = BigInt(cols[6]!);
      availableCostCenterBudgetAfter = BigInt(cols[7]!);
      netTermsDueDays = Number(cols[8]!);
      recommendedReservationTtlSeconds = Number(cols[9]!);
    } else if (tag === "B2B_REASON" && cols.length >= 2) {
      approvalReasons.push(unescapeWireField(cols[1]!));
    }
  }

  const pricing = decodeCartPayload(rawOut, fallbackCurrencyCode);
  return {
    decision,
    approvalReasons,
    pricing,
    standardTaxAmountWithoutExemption,
    taxExemptSavingsAmount,
    availableCompanyCreditBefore,
    availableCompanyCreditAfter,
    availableCostCenterBudgetBefore,
    availableCostCenterBudgetAfter,
    netTermsDueDays,
    recommendedReservationTtlSeconds,
  };
}

export function evaluateB2bPurchasePolicyViaRust(
  binding: NativeRustKernelBinding,
  input: B2bPurchasePolicyInput
): B2bPurchasePolicyResult {
  const rawOut = binding.rustEvaluateB2bPurchasePolicy(encodeB2bPolicyPayload(input));
  return decodeB2bPolicyPayload(rawOut, input.cart.currencyCode);
}
