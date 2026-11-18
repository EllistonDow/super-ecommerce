import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allocateProRata,
  applyBps,
  calculateCart,
  calculateReturnRefund,
  currencyExponent,
  evaluateB2bPurchasePolicy,
  formatMinorUnits,
  instantiateWasmPricingKernel,
  isNativeRustKernelLoaded,
  runKernelBenchmarkSuite,
} from "./index.ts";
import { getNativeRustKernel } from "./rust-bridge.ts";

describe("@super-ecommerce/kernel (Native Rust N-API + WASM Bridge)", () => {
  it("loads the compiled Rust N-API binary (commerce_kernel.node) and matches WASM pricing bit-for-bit", async () => {
    assert.equal(
      isNativeRustKernelLoaded(),
      true,
      "Expected compiled Rust N-API binary (commerce_kernel.node) to be loaded"
    );

    const wasmKernel = await instantiateWasmPricingKernel();

    // $19.99 * 8.25% (825 bps) = 165 cents in both Native Rust N-API and WASM
    const rustTax = applyBps(1999n, 825);
    const wasmTax = wasmKernel.applyBps(1999n, 825);
    assert.equal(rustTax, 165n);
    assert.equal(wasmTax, 165n);

    // 4000 cents gross at 20% VAT (2000 bps) -> 3333 cents net
    const wasmVatNet = wasmKernel.extractVatNet(4000n, 2000);
    assert.equal(wasmVatNet, 3333n);
  });

  it("distributes 1000 cents across 3 equal lines via Native Rust Hare-Niemeyer FFI", () => {
    const orderA = allocateProRata(1000n, [
      { id: "line-2", weight: 1000n },
      { id: "line-1", weight: 1000n },
      { id: "line-3", weight: 1000n },
    ]);
    const orderB = allocateProRata(1000n, [
      { id: "line-3", weight: 1000n },
      { id: "line-2", weight: 1000n },
      { id: "line-1", weight: 1000n },
    ]);

    const totalAllocated = orderA.reduce((acc, s) => acc + s.allocated, 0n);
    assert.equal(totalAllocated, 1000n);

    const line1InA = orderA.find((s) => s.id === "line-1")?.allocated;
    const line1InB = orderB.find((s) => s.id === "line-1")?.allocated;
    assert.equal(line1InA, 334n);
    assert.equal(line1InB, 334n);
  });

  it("enforces two-pass precedence and records exact per-record-per-line attribution in Rust", () => {
    const result = calculateCart({
      currencyCode: "USD",
      taxMode: "TAX_EXCLUSIVE",
      shippingBaseAmount: 1500n,
      shippingTaxRateBps: 0,
      lines: [
        {
          lineId: "L-1",
          variantId: "V-1",
          quantity: 2,
          baseUnitPrice: 2000n,
          tierPrices: [{ minQuantity: 2, unitAmount: 1500n }],
          taxRateBps: 1000,
          candidateLineDiscounts: [
            {
              discountId: "cat-10pct",
              name: "10% Catalogue Promo",
              kind: "CATALOGUE_PROMOTION",
              value: { type: "PERCENTAGE", bps: 1000 },
            },
          ],
        },
        {
          lineId: "L-GIFT",
          variantId: "V-GIFT",
          quantity: 1,
          baseUnitPrice: 1000n,
          taxRateBps: 1000,
          isGift: true,
        },
      ],
      candidateOrderDiscounts: [
        {
          discountId: "order-promo-5",
          name: "$5 Order Promo",
          kind: "ORDER_PROMOTION",
          value: { type: "FIXED", amount: 500n },
        },
        {
          discountId: "order-voucher-7",
          name: "$7 Order Voucher",
          kind: "ORDER_VOUCHER",
          value: { type: "FIXED", amount: 700n },
        },
      ],
    });

    const paidLine = result.lines[0]!;
    const giftLine = result.lines[1]!;

    assert.equal(paidLine.effectiveBaseUnitPrice, 1500n);
    assert.equal(paidLine.lineLevelDiscountAmount, 300n);
    assert.equal(paidLine.subtotalAfterLineDiscount, 2700n);
    assert.equal(paidLine.allocatedOrderDiscountAmount, 700n);
    assert.equal(paidLine.discountAttributions.length, 2);
    assert.equal(paidLine.totalNetAmount, 2000n);
    assert.equal(paidLine.totalTaxAmount, 200n);
    assert.equal(paidLine.totalGrossAmount, 2200n);

    assert.equal(giftLine.lineLevelDiscountAmount, 1000n);
    assert.equal(giftLine.allocatedOrderDiscountAmount, 0n);
    assert.equal(giftLine.totalGrossAmount, 0n);
  });

  it("executes 5-tier Rust N-API + WASM + BigInt throughput benchmark with sub-millisecond p99 latency", async () => {
    const report = await runKernelBenchmarkSuite({ scale: 0.1 });
    assert.equal(report.tiers.length, 5);
    for (const tier of report.tiers) {
      assert.ok(tier.opsPerSec > 5_000, `Expected ${tier.id} ops/sec > 5,000, got ${tier.opsPerSec}`);
      assert.ok(tier.p99Us < 1_000, `Expected ${tier.id} p99 < 1,000us, got ${tier.p99Us}us`);
    }
  });

  it("reconciles multi-wave partial RMA refunds to the exact penny via Native Rust N-API", () => {
    let alreadyRetQty = 0;
    let alreadyRefNet = 0n;
    let alreadyRefTax = 0n;
    let alreadyRefGross = 0n;
    const waveGrossRefunds: bigint[] = [];

    for (let wave = 1; wave <= 3; wave++) {
      const res = calculateReturnRefund({
        currencyCode: "USD",
        lines: [
          {
            lineId: "L-1",
            variantId: "KR-KB75-TI",
            originalQuantity: 3,
            alreadyReturnedQuantity: alreadyRetQty,
            returnQuantityRequested: 1,
            originalNetAmount: 1000n,
            originalTaxAmount: 0n,
            originalGrossAmount: 1000n,
            alreadyRefundedNetAmount: alreadyRefNet,
            alreadyRefundedTaxAmount: alreadyRefTax,
            alreadyRefundedGrossAmount: alreadyRefGross,
          },
        ],
        paymentGatewayOriginallyCaptured: 1000n,
        paymentGatewayAlreadyRefunded: alreadyRefGross,
      });

      const line = res.lines[0]!;
      assert.equal(line.acceptedReturnQuantity, 1);
      assert.equal(line.isFinalUnitReconciliation, wave === 3);
      waveGrossRefunds.push(line.refundGrossAmount);

      alreadyRetQty += line.acceptedReturnQuantity;
      alreadyRefNet += line.netCeilingConsumed;
      alreadyRefTax += line.taxCeilingConsumed;
      alreadyRefGross += line.grossCeilingConsumed;
    }

    assert.deepEqual(waveGrossRefunds, [334n, 333n, 333n]);
    assert.equal(alreadyRefGross, 1000n);
  });

  it("evaluates B2B volume tier pricing, contract discount, tax exemption, and PO approval thresholds via Native Rust N-API", () => {
    const autoRes = evaluateB2bPurchasePolicy({
      company: {
        companyId: "comp-acme-ind",
        paymentTerms: "NET_30",
        creditLimit: 5_000_000n,
        creditUsed: 1_000_000n,
        creditReserved: 0n,
        contractDiscountBps: 500,
        taxExemptVerified: true,
      },
      costCenter: {
        costCenterId: "cc-hw-eng",
        monthlyBudget: 1_500_000n,
        monthlySpent: 200_000n,
        monthlyReserved: 0n,
      },
      buyer: {
        buyerId: "buyer-alice",
        role: "BUYER",
        singleOrderAutoApproveLimit: 250_000n,
      },
      cart: {
        currencyCode: "USD",
        taxMode: "TAX_EXCLUSIVE",
        shippingBaseAmount: 0n,
        shippingTaxRateBps: 825,
        lines: [
          {
            lineId: "L-1",
            variantId: "KR-KB75-TI",
            quantity: 5,
            baseUnitPrice: 24_000n,
            tierPrices: [
              { minQuantity: 5, unitAmount: 21_000n },
              { minQuantity: 20, unitAmount: 18_000n },
            ],
            taxRateBps: 825,
          },
        ],
      },
    });

    assert.equal(autoRes.decision, "APPROVED_AUTO");
    assert.equal(autoRes.pricing.lines[0]?.effectiveBaseUnitPrice, 21_000n);
    assert.equal(autoRes.pricing.totalGrossAmount, 99_750n);
    assert.equal(autoRes.taxExemptSavingsAmount, 8_229n);
    assert.equal(autoRes.netTermsDueDays, 30);

    const pendingRes = evaluateB2bPurchasePolicy({
      company: {
        companyId: "comp-acme-ind",
        paymentTerms: "NET_30",
        creditLimit: 5_000_000n,
        creditUsed: 1_000_000n,
        creditReserved: 0n,
        contractDiscountBps: 500,
        taxExemptVerified: true,
      },
      costCenter: {
        costCenterId: "cc-hw-eng",
        monthlyBudget: 1_500_000n,
        monthlySpent: 200_000n,
        monthlyReserved: 0n,
      },
      buyer: {
        buyerId: "buyer-alice",
        role: "BUYER",
        singleOrderAutoApproveLimit: 250_000n,
      },
      cart: {
        currencyCode: "USD",
        taxMode: "TAX_EXCLUSIVE",
        shippingBaseAmount: 0n,
        shippingTaxRateBps: 825,
        lines: [
          {
            lineId: "L-1",
            variantId: "KR-KB75-TI",
            quantity: 25,
            baseUnitPrice: 24_000n,
            tierPrices: [
              { minQuantity: 5, unitAmount: 21_000n },
              { minQuantity: 20, unitAmount: 18_000n },
            ],
            taxRateBps: 825,
          },
        ],
      },
    });

    assert.equal(pendingRes.decision, "PENDING_APPROVAL");
    assert.equal(pendingRes.pricing.totalGrossAmount, 427_500n);
    assert.equal(pendingRes.recommendedReservationTtlSeconds, 259_200);
  });

  it("compiles full commerce-kernel to WebAssembly (commerce_kernel.wasm) with bit-for-bit cart & RMA parity", async () => {
    const wasmKernel = await instantiateWasmPricingKernel();
    assert.equal(wasmKernel.isCompiledFromRustCrate, true);
    assert.ok(wasmKernel.calculateCart, "Expected full calculateCart export on Rust WASM kernel");

    const cartInput = {
      currencyCode: "EUR",
      taxMode: "TAX_INCLUSIVE" as const,
      shippingBaseAmount: 1200n,
      shippingTaxRateBps: 2000,
      lines: [
        {
          lineId: "L-1",
          variantId: "VAR-A",
          quantity: 1,
          baseUnitPrice: 1000n,
          taxRateBps: 2000,
        },
        {
          lineId: "L-2",
          variantId: "VAR-B",
          quantity: 1,
          baseUnitPrice: 1000n,
          taxRateBps: 2000,
        },
        {
          lineId: "L-3",
          variantId: "VAR-C",
          quantity: 1,
          baseUnitPrice: 1000n,
          taxRateBps: 2000,
        },
      ],
      candidateOrderDiscounts: [
        {
          discountId: "v-1000",
          name: "10 EUR Voucher",
          kind: "ORDER_VOUCHER" as const,
          value: { type: "FIXED" as const, amount: 1000n },
        },
      ],
    };

    const nativeRes = calculateCart(cartInput);
    const wasmRes = wasmKernel.calculateCart!(cartInput);
    assert.deepEqual(wasmRes, nativeRes);
  });

  it("enforces ISO-4217 multi-currency exponents, Gross Margin Floor Guard, N-API argument safety, and wire injection immunity", () => {
    assert.equal(currencyExponent("JPY"), 0);
    assert.equal(currencyExponent("USD"), 2);
    assert.equal(currencyExponent("KWD"), 3);
    assert.equal(formatMinorUnits(15800n, "JPY"), "15800");
    assert.equal(formatMinorUnits(1999n, "USD"), "19.99");
    assert.equal(formatMinorUnits(12345n, "KWD"), "12.345");

    // Hostile tab/newline injection in discount name & Gross Margin Floor Guard clamping
    const hostileName = "VIP\t999999\nODISC\tinject-999\tInjected\tMANUAL_ORDER\tFIXED\t99999";
    const guarded = calculateCart({
      currencyCode: "USD",
      taxMode: "TAX_EXCLUSIVE",
      shippingBaseAmount: 0n,
      shippingTaxRateBps: 0,
      lines: [
        {
          lineId: "L\t1\nX",
          variantId: "SKU\tTI",
          quantity: 1,
          baseUnitPrice: 15_000n,
          unitCostAmount: 8_000n,
          minMarginBps: 2_000, // 20% gross margin floor => min net $100.00 (10_000)
          taxRateBps: 0,
          candidateLineDiscounts: [
            {
              discountId: "d\t1",
              name: hostileName,
              kind: "CATALOGUE_PROMOTION",
              value: { type: "PERCENTAGE", bps: 5000 }, // Tries $75 off -> clamped to $50 off!
            },
          ],
        },
      ],
    });

    assert.equal(guarded.appliedOrderDiscounts.length, 0);
    assert.equal(guarded.lines[0]?.lineId, "L\t1\nX");
    assert.equal(guarded.lines[0]?.discountAttributions[0]?.name, hostileName);
    assert.equal(guarded.lines[0]?.lineLevelDiscountAmount, 5_000n);
    assert.equal(guarded.lines[0]?.marginGuardClampedAmount, 2_500n);
    assert.equal(guarded.lines[0]?.totalNetAmount, 10_000n);

    // N-API null/missing argument guard throws TypeError cleanly instead of Segfaulting
    const rawNative = getNativeRustKernel() as unknown as Record<string, (...args: unknown[]) => unknown>;
    assert.throws(() => rawNative["rustCalculateCart"]!(), TypeError);
    assert.throws(() => rawNative["rustApplyBps"]!("not-a-bigint", 500), TypeError);
  });
});
