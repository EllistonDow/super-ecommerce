import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateCart } from "@super-ecommerce/kernel";
import {
  renderStorefrontHtml,
  renderProductDetailHtml,
  renderCheckoutPageHtml,
  renderOrdersListHtml,
  renderOrderDetailRmaHtml,
} from "./index.ts";

describe("@super-ecommerce/storefront", () => {
  it("renders SSR storefront with CQRS projections, Hare-Niemeyer waterfall, and passes Pre-Flight checks", () => {
    const channel = {
      id: "ch-us",
      slug: "us-retail",
      name: "US Flagship",
      currencyCode: "USD",
      defaultCountry: "US",
      taxInclusionMode: "TAX_EXCLUSIVE" as const,
      stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES" as const,
      allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK" as const,
      reservationTtlSeconds: 900,
      isActive: true,
    };

    const pricing = calculateCart({
      currencyCode: "USD",
      taxMode: "TAX_EXCLUSIVE",
      shippingBaseAmount: 0n,
      shippingTaxRateBps: 0,
      lines: [
        {
          lineId: "L1",
          variantId: "KR-KB75-TI",
          quantity: 1,
          baseUnitPrice: 10_000n,
          taxRateBps: 825,
        },
      ],
    });

    const html = renderStorefrontHtml({
      activeChannel: channel,
      channels: [channel],
      projections: [
        {
          channelSlug: "us-retail",
          productId: "p-1",
          productSlug: "kronos-field-75",
          productName: "Kronos Field 75 CNC Keyboard",
          currencyCode: "USD",
          minEffectivePrice: 35_100n,
          maxEffectivePrice: 35_100n,
          isInStock: true,
          totalAvailableQty: 30,
          mergedAttributes: { chassis: ["grade-5-titanium"] },
          variantsSnapshot: [],
        },
      ],
      initialCartPricing: pricing,
    });

    assert.match(html, /Kronos Field 75 CNC Keyboard/);
    assert.match(html, /\/products\/kronos-field-75\?channel=us-retail/);
    assert.match(html, /\/checkout\?channel=us-retail/);
    assert.match(html, /\/orders\?channel=us-retail/);
    assert.match(html, /Complete Saga Checkout/);
    assert.match(html, /PG 17 GIN jsonb_path_ops/);
    assert.match(html, /facet-sql-preview/);
    // Emil Kowalski tactile button press & reduced-motion checks
    assert.match(html, /transform:\s*scale\(0\.97\)/);
    assert.match(html, /prefers-reduced-motion:\s*reduce/);
    // Anti-slop Pre-Flight Check: zero em-dashes or en-dashes
    assert.equal(html.includes("—"), false, "Storefront HTML must contain zero em-dashes");
    assert.equal(html.includes("–"), false, "Storefront HTML must contain zero en-dashes");
  });

  it("renders Phase 8 PDP (/products/:slug), Dedicated Checkout (/checkout), Orders (/orders), and Self-Service RMA (/orders/:id) with zero em-dashes", () => {
    const channel = {
      id: "ch-us",
      slug: "us-retail",
      name: "US Flagship",
      currencyCode: "USD",
      defaultCountry: "US",
      taxInclusionMode: "TAX_EXCLUSIVE" as const,
      stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES" as const,
      allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK" as const,
      reservationTtlSeconds: 900,
      isActive: true,
    };

    const projection = {
      channelSlug: "us-retail",
      productId: "p-1",
      productSlug: "kronos-field-75",
      productName: "Kronos Field 75 CNC Keyboard",
      currencyCode: "USD",
      minEffectivePrice: 35_100n,
      maxEffectivePrice: 37_900n,
      isInStock: true,
      totalAvailableQty: 42,
      mergedAttributes: { chassis: ["grade-5-titanium"], switch_feel: ["linear-45g", "tactile-55g"] },
      variantsSnapshot: [
        {
          variantId: "var-kb-1",
          sku: "KR-KB75-TI",
          name: "Raw Titanium / Linear 45g",
          effectivePrice: 35_100n,
          compareAtAmount: 39_000n,
          availableQuantity: 30,
          isInStock: true,
          attributes: { switch_feel: "linear-45g" },
        },
        {
          variantId: "var-kb-2",
          sku: "KR-KB75-BLK",
          name: "Stealth Obsidian / Tactile 55g",
          effectivePrice: 37_900n,
          availableQuantity: 12,
          isInStock: true,
          attributes: { switch_feel: "tactile-55g" },
        },
      ],
    };

    const pdpHtml = renderProductDetailHtml({
      activeChannel: channel,
      channels: [channel],
      projection,
      selectedVariantSku: "KR-KB75-BLK",
      tierPricesBySku: {
        "KR-KB75-TI": [
          { minQuantity: 5, unitAmount: 33_000n },
          { minQuantity: 10, unitAmount: 31_000n },
        ],
      },
      warehouseStocksBySku: {
        "KR-KB75-BLK": [
          {
            warehouseId: "US-EAST",
            priorityRank: 1,
            linkedToChannel: true,
            supportsShippingZone: true,
            variantId: "KR-KB75-BLK",
            quantityOnHand: 15,
            quantityReserved: 1,
            quantityAllocated: 2,
          },
        ],
      },
    });

    assert.match(pdpHtml, /VARIANT SELECTION MATRIX/);
    assert.match(pdpHtml, /KR-KB75-TI/);
    assert.match(pdpHtml, /KR-KB75-BLK/);
    assert.match(pdpHtml, /Live Multi-Source Inventory \(MSI\) Warehouse Allocation/);
    assert.match(pdpHtml, /B2B &amp; VOLUME TIER PRICING/);
    assert.equal(pdpHtml.includes("—"), false);
    assert.equal(pdpHtml.includes("–"), false);

    const pricing = calculateCart({
      currencyCode: "USD",
      taxMode: "TAX_EXCLUSIVE",
      shippingBaseAmount: 0n,
      shippingTaxRateBps: 0,
      lines: [
        {
          lineId: "L1",
          variantId: "KR-KB75-TI",
          quantity: 3,
          baseUnitPrice: 10_000n,
          taxRateBps: 0,
        },
      ],
    });

    const checkoutHtml = renderCheckoutPageHtml({
      activeChannel: channel,
      channels: [channel],
      initialCartPricing: pricing,
      catalogItems: [{ sku: "KR-KB75-TI", name: "Kronos Keyboard", unitPriceCents: "35100" }],
    });
    assert.match(checkoutHtml, /Durable Checkout &amp; Two-Pass Kernel Workbench/);
    assert.match(checkoutHtml, /Authorize &amp; Complete 5-Step Saga/);
    assert.equal(checkoutHtml.includes("—"), false);
    assert.equal(checkoutHtml.includes("–"), false);

    const orderRecord = {
      orderId: "ord_phase8_demo_1",
      checkoutId: "chk_phase8_demo_1",
      channelSlug: "us-retail",
      currencyCode: "USD",
      pricing,
      shipments: [
        {
          warehouseId: "US-EAST",
          lineId: "L1",
          variantId: "KR-KB75-TI",
          quantityAllocated: 3,
        },
      ],
      paymentTransactionId: "pay_phase8_1",
      paymentCapturedAmount: 30_000n,
      storeCreditRedeemedAmount: 0n,
      paymentStatus: "CAPTURED" as const,
      createdAt: "2026-11-16T00:00:00.000Z",
    };

    const ordersHtml = renderOrdersListHtml({
      activeChannel: channel,
      channels: [channel],
      orders: [orderRecord],
      returnsByOrderId: {},
    });
    assert.match(ordersHtml, /ord_phase8_demo_1/);
    assert.match(ordersHtml, /Manage &amp; Return/);
    assert.equal(ordersHtml.includes("—"), false);
    assert.equal(ordersHtml.includes("–"), false);

    const orderDetailHtml = renderOrderDetailRmaHtml({
      activeChannel: channel,
      channels: [channel],
      order: orderRecord,
      priorReturns: [],
      warehousePriorityById: { "US-EAST": 1 },
    });
    assert.match(orderDetailHtml, /Self-Service RMA Return Estimator/);
    assert.match(orderDetailHtml, /Submit Self-Service RMA/);
    assert.match(orderDetailHtml, /RESELLABLE/);
    assert.match(orderDetailHtml, /#1/);
    assert.equal(orderDetailHtml.includes("#undefined"), false);
    assert.equal(orderDetailHtml.includes("—"), false);
    assert.equal(orderDetailHtml.includes("–"), false);
  });

  it("renders keyset pagination controls and preserves active channel parameters", () => {
    const channel: ChannelRecord = {
      id: "ch-1",
      slug: "us-retail",
      name: "US Retail",
      currencyCode: "USD",
      defaultCountry: "US",
      taxInclusionMode: "TAX_EXCLUSIVE",
      stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
      allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
      reservationTtlSeconds: 900,
      isActive: true,
    };
    const orderRecord: OrderRecord = {
      orderId: "ord_page_1",
      checkoutId: "chk_page_1",
      channelSlug: "us-retail",
      currencyCode: "USD",
      pricing: {
        currencyCode: "USD",
        taxMode: "TAX_EXCLUSIVE",
        subtotalNetAmount: 10_000n,
        subtotalGrossAmount: 10_000n,
        shippingNetAmount: 0n,
        shippingGrossAmount: 0n,
        totalTaxAmount: 0n,
        totalDiscountAmount: 0n,
        totalNetAmount: 10_000n,
        totalGrossAmount: 10_000n,
        winningOrderDiscount: null,
        lines: [
          {
            lineId: "L1",
            variantId: "KR-KB75-TI",
            quantity: 1,
            unitNetAmount: 10_000n,
            unitGrossAmount: 10_000n,
            totalNetAmount: 10_000n,
            totalGrossAmount: 10_000n,
            taxRateBps: 0,
            unitDiscountAmount: 0n,
            isGift: false,
          },
        ],
      },
      shipments: [
        {
          warehouseId: "US-EAST",
          lineId: "L1",
          variantId: "KR-KB75-TI",
          quantityAllocated: 1,
        },
      ],
      paymentTransactionId: "pay_page_1",
      paymentCapturedAmount: 10_000n,
      storeCreditRedeemedAmount: 0n,
      paymentStatus: "CAPTURED" as const,
      createdAt: "2026-11-16T00:00:00.000Z",
    };

    const paginatedHtml = renderOrdersListHtml({
      activeChannel: channel,
      channels: [channel],
      orders: [orderRecord],
      returnsByOrderId: {},
      pagination: {
        limit: 1,
        hasMore: true,
        hasPrev: true,
        nextCursor: "cursor_next_token_abc",
        prevCursor: "cursor_prev_token_xyz",
        totalMatchingCount: 5,
      },
    });

    assert.match(paginatedHtml, /Showing 1 of 5 order\(s\)/);
    assert.match(paginatedHtml, /cursor_next_token_abc/);
    assert.match(paginatedHtml, /cursor_prev_token_xyz/);
    assert.match(paginatedHtml, /direction=next/);
    assert.match(paginatedHtml, /direction=prev/);
    assert.equal(paginatedHtml.includes("—"), false);
    assert.equal(paginatedHtml.includes("–"), false);
  });
});

