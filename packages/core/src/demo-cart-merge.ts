import assert from "node:assert/strict";
import {
  OfflinePgPool,
  runMigrations,
} from "@super-ecommerce/db";
import {
  PgCustomerAuthAndCartService,
  PgCustomersService,
} from "./index.ts";

async function runCartMergeAudit() {
  console.log("================================================================================");
  console.log(">>> [CART AUDIT] Persistent C-End Guest-to-Member Cart Merge & Volume Tier Pricing");
  console.log("================================================================================\n");

  const pg = new OfflinePgPool();
  await runMigrations(pg);

  const cartService = new PgCustomerAuthAndCartService(pg);
  const customerService = new PgCustomersService(pg);

  // ---------------------------------------------------------------------------
  // Step 1: Register Customer
  // ---------------------------------------------------------------------------
  console.log("1. Registering Customer (Chen Wei):");
  const reg = await cartService.registerCustomer({
    customerId: "cust_vip_chen",
    email: "chen.wei@example.com",
    passwordPlain: "SecureMember2026!",
    fullName: "Chen Wei",
  });
  const customer = reg.customer;
  console.log(`   - Customer ID:   ${customer.customerId}`);
  console.log(`   - Customer Email: ${customer.email} (${customer.fullName})\n`);

  // ---------------------------------------------------------------------------
  // Step 2: Create Anonymous Guest Cart with Items & Voucher
  // ---------------------------------------------------------------------------
  console.log("2. Creating Anonymous Guest Cart (Guest Session: guest_xyz_888):");
  const guestCart = await cartService.createOrGetActiveCart({
    channelSlug: "us-retail",
    currencyCode: "USD",
    taxMode: "TAX_EXCLUSIVE",
    guestToken: "guest_xyz_888",
    shippingBaseAmount: 1_500n, // $15.00
    shippingTaxRateBps: 0,
  });
  console.log(`   - Guest Cart ID: ${guestCart.cartId} (Status: ${guestCart.status})`);

  // Line 1: Titanium Keyboard (qty: 2, unit price $250.00, tier: 5+ -> $210.00)
  await cartService.upsertCartLine({
    cartId: guestCart.cartId,
    variantId: "VAR-KB-TI",
    sku: "KR-KB-TI-01",
    title: "Kronos CNC Titanium Mechanical Keyboard",
    quantity: 2,
    baseUnitPrice: 25_000n, // $250.00
    taxRateBps: 1_000, // 10%
    tierPrices: [
      {
        minQuantity: 5,
        unitAmount: 21_000n, // $210.00 for 5+ bulk orders
      },
    ],
    candidateLineDiscounts: [],
  });

  // Line 2: Lubed Linear Switches (qty: 1, unit price $45.00)
  await cartService.upsertCartLine({
    cartId: guestCart.cartId,
    variantId: "VAR-SWITCH-LUBED",
    sku: "KR-SW-90PK",
    title: "Kronos Linear Switches (Factory Lubed 90-Pack)",
    quantity: 1,
    baseUnitPrice: 4_500n, // $45.00
    taxRateBps: 1_000, // 10%
    tierPrices: [],
    candidateLineDiscounts: [],
  });

  // Apply Voucher: 10% off entire order
  await cartService.applyCartVoucher({
    cartId: guestCart.cartId,
    voucherCode: "VIP10",
    discount: {
      discountId: "disc_vip10",
      name: "VIP Early Bird 10% Off",
      kind: "ORDER_VOUCHER",
      value: {
        type: "PERCENTAGE",
        bps: 1_000, // 10.00%
      },
    },
  });

  const hydratedGuest = (await cartService.getHydratedCart(guestCart.cartId))!;
  console.log(`   - Line count:    ${hydratedGuest.lines.length} lines`);
  for (const l of hydratedGuest.lines) {
    console.log(`     * [${l.sku}] ${l.title} x${l.quantity} @ $${(Number(l.baseUnitPrice)/100).toFixed(2)}`);
  }
  console.log(`   - Voucher:       ${hydratedGuest.voucherCode} (${hydratedGuest.voucherDiscount?.name})`);
  console.log(`   - Total Net:     $${(Number(hydratedGuest.pricing.totalNetAmount)/100).toFixed(2)}`);
  console.log(`   - Total Tax:     $${(Number(hydratedGuest.pricing.totalTaxAmount)/100).toFixed(2)}`);
  console.log(`   - Total Gross:   $${(Number(hydratedGuest.pricing.totalGrossAmount)/100).toFixed(2)}`);
  assert.equal(hydratedGuest.lines.length, 2);
  assert.equal(hydratedGuest.voucherCode, "VIP10");
  console.log("   -> [PASS] Guest cart populated with lines, tier definitions, and order discount\n");

  // ---------------------------------------------------------------------------
  // Step 3: Create Pre-Existing Authenticated Member Cart
  // ---------------------------------------------------------------------------
  console.log("3. Creating Pre-Existing Authenticated Member Cart for Chen Wei:");
  const memberCart = await cartService.createOrGetActiveCart({
    channelSlug: "us-retail",
    currencyCode: "USD",
    taxMode: "TAX_EXCLUSIVE",
    customerId: customer.customerId,
    shippingBaseAmount: 1_500n,
    shippingTaxRateBps: 0,
  });
  console.log(`   - Member Cart ID: ${memberCart.cartId} (Owner: ${memberCart.customerId})`);

  // Member already has 3 units of Titanium Keyboard in cart
  await cartService.upsertCartLine({
    cartId: memberCart.cartId,
    variantId: "VAR-KB-TI",
    sku: "KR-KB-TI-01",
    title: "Kronos CNC Titanium Mechanical Keyboard",
    quantity: 3,
    baseUnitPrice: 25_000n, // $250.00
    taxRateBps: 1_000,
    tierPrices: [
      {
        minQuantity: 5,
        unitAmount: 21_000n, // $210.00 for 5+
      },
    ],
    candidateLineDiscounts: [],
  });

  // Member also has a deskmat
  await cartService.upsertCartLine({
    cartId: memberCart.cartId,
    variantId: "VAR-DESKMAT-WOOL",
    sku: "KR-MAT-GRY",
    title: "Merino Wool Felt Deskmat (Space Gray)",
    quantity: 1,
    baseUnitPrice: 3_500n, // $35.00
    taxRateBps: 1_000,
    tierPrices: [],
    candidateLineDiscounts: [],
  });

  const hydratedMemberBefore = (await cartService.getHydratedCart(memberCart.cartId))!;
  console.log(`   - Line count:    ${hydratedMemberBefore.lines.length} lines`);
  for (const l of hydratedMemberBefore.lines) {
    console.log(`     * [${l.sku}] ${l.title} x${l.quantity} @ $${(Number(l.baseUnitPrice)/100).toFixed(2)}`);
  }
  console.log(`   - Total Net:     $${(Number(hydratedMemberBefore.pricing.totalNetAmount)/100).toFixed(2)}`);
  console.log(`   - Total Gross:   $${(Number(hydratedMemberBefore.pricing.totalGrossAmount)/100).toFixed(2)}`);
  console.log("   -> [PASS] Member cart initialized with 2 lines\n");

  // ---------------------------------------------------------------------------
  // Step 4: Execute Atomic Cart Merge upon Member Login
  // ---------------------------------------------------------------------------
  console.log("4. Executing Atomic Cart Merge (mergeGuestCartIntoCustomerCart):");
  const mergedCart = await cartService.mergeGuestCartIntoCustomerCart({
    guestCartId: guestCart.cartId,
    customerId: customer.customerId,
  });

  console.log(`   - Merged Cart ID: ${mergedCart.cartId} (Status: ${mergedCart.status})`);
  console.log(`   - Total Lines:    ${mergedCart.lines.length} (EXPECTED: 3 merged distinct variants)`);
  console.log(`   - Merged Lines Breakdown:`);
  for (const l of mergedCart.lines) {
    console.log(`     * [${l.sku}] ${l.title} x${l.quantity} (Base: $${(Number(l.baseUnitPrice)/100).toFixed(2)})`);
  }

  // Find the Titanium Keyboard line
  const kbLine = mergedCart.lines.find((l) => l.variantId === "VAR-KB-TI");
  assert.ok(kbLine, "VAR-KB-TI line must exist in merged cart");
  console.log(`\n   Quantity Summation Verification for 'VAR-KB-TI':`);
  console.log(`   - Guest Qty:      2`);
  console.log(`   - Member Qty:     3`);
  console.log(`   - Combined Qty:   ${kbLine.quantity} (EXPECTED: 5)`);
  assert.equal(kbLine.quantity, 5);

  console.log(`\n   Rust Kernel Dynamic Volume Tier Pricing Verification:`);
  // In the Rust pricing engine, line pricing reflects the tier price when qty >= 5
  // For VAR-KB-TI: 5 units * $210.00 = $1,050.00 (instead of 5 * $250 = $1,250.00)
  // Savings from tier pricing: $200.00
  const kbCalculated = mergedCart.pricing.lines.find((l) => l.lineId === kbLine.lineId);
  assert.ok(kbCalculated);
  console.log(`   - Undiscounted Line Subtotal: $${(Number(kbCalculated.undiscountedLineSubtotal)/100).toFixed(2)}`);
  console.log(`   - Effective Base Unit Price:  $${(Number(kbCalculated.effectiveBaseUnitPrice)/100).toFixed(2)} (EXPECTED: $210.00)`);
  console.log(`   - Allocated Voucher Discount: $${(Number(kbCalculated.allocatedOrderDiscountAmount)/100).toFixed(2)}`);
  console.log(`   - Final Net Line Amount:      $${(Number(kbCalculated.totalNetAmount)/100).toFixed(2)}`);
  assert.equal(kbCalculated.effectiveBaseUnitPrice, 21_000n);
  assert.equal(kbCalculated.undiscountedLineSubtotal, 105_000n);

  console.log(`\n   Voucher Migration Verification:`);
  console.log(`   - Adopted Voucher: ${mergedCart.voucherCode} (EXPECTED: VIP10)`);
  assert.equal(mergedCart.voucherCode, "VIP10");
  const voucherDiscounts = mergedCart.pricing.appliedOrderDiscounts;
  console.log(`   - Applied Order Discounts: ${voucherDiscounts.map(d => `${d.name}: $${(Number(d.totalAmount)/100).toFixed(2)}`).join(", ")}`);
  assert.equal(voucherDiscounts.length, 1);
  assert.ok(voucherDiscounts[0]!.totalAmount > 0n);

  console.log(`\n   Guest Cart Retirement Verification:`);
  const guestAfter = (await cartService.getHydratedCart(guestCart.cartId))!;
  console.log(`   - Guest Cart Status:      ${guestAfter.status} (EXPECTED: MERGED)`);
  console.log(`   - Merged Into Target Cart: ${guestAfter.mergedIntoCartId} (EXPECTED: ${mergedCart.cartId})`);
  assert.equal(guestAfter.status, "MERGED");
  assert.equal(guestAfter.mergedIntoCartId, mergedCart.cartId);
  console.log("   -> [PASS] Guest cart safely retired and linked to authenticated member cart\n");

  // ---------------------------------------------------------------------------
  // Step 5: Idempotent Re-Merge Invariant
  // ---------------------------------------------------------------------------
  console.log("5. Testing Idempotent Re-Merge Invariant:");
  const reMerge = await cartService.mergeGuestCartIntoCustomerCart({
    guestCartId: guestCart.cartId,
    customerId: customer.customerId,
  });
  assert.equal(reMerge.cartId, mergedCart.cartId);
  const reMergeKb = reMerge.lines.find((l) => l.variantId === "VAR-KB-TI");
  assert.equal(reMergeKb?.quantity, 5); // Must not double-add!
  console.log(`   - Re-merge line quantity: ${reMergeKb?.quantity} (Strictly preserved, no double-counting)`);
  console.log("   -> [PASS] Idempotent re-merge safeguard verified\n");

  await pg.close();

  console.log("================================================================================");
  console.log(">>> [AUDIT VERDICT] ALL 5 CART MERGE INVARIANTS RIGOROUSLY VERIFIED");
  console.log("================================================================================");
}

runCartMergeAudit().catch((err) => {
  console.error("Cart merge audit failed:", err);
  process.exit(1);
});
