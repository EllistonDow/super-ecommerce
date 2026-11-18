import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SuperCommerceMcpServer } from "./index.ts";

describe("@super-ecommerce/mcp-server", () => {
  it("diagnoses three-pass price waterfall, suppressed discount precedence, stock availability modes, and CQRS facets", () => {
    const mcp = new SuperCommerceMcpServer([
      {
        channelSlug: "us-retail",
        productId: "p-1",
        productSlug: "pro-keyboard",
        productName: "Pro Mechanical Keyboard",
        currencyCode: "USD",
        minEffectivePrice: 15_000n,
        maxEffectivePrice: 18_000n,
        isInStock: true,
        totalAvailableQty: 12,
        mergedAttributes: {
          switch: ["linear", "tactile"],
          wireless: [true],
        },
        variantsSnapshot: [],
      },
      {
        channelSlug: "us-retail",
        productId: "p-2",
        productSlug: "wired-mouse",
        productName: "Ultralight Wired Mouse",
        currencyCode: "USD",
        minEffectivePrice: 6_900n,
        maxEffectivePrice: 6_900n,
        isInStock: true,
        totalAvailableQty: 30,
        mergedAttributes: {
          wireless: [false],
        },
        variantsSnapshot: [],
      },
    ]);

    assert.equal(mcp.listTools().length, 4);

    const hits = mcp.searchCatalogHybrid({
      channelSlug: "us-retail",
      inStockOnly: true,
      attributeFilters: { wireless: true, switch: "linear" },
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.productSlug, "pro-keyboard");

    const waterfall = mcp.diagnosePriceWaterfall({
      currencyCode: "USD",
      taxMode: "TAX_EXCLUSIVE",
      shippingBaseAmount: 0n,
      shippingTaxRateBps: 0,
      lines: [
        {
          lineId: "L1",
          variantId: "V1",
          quantity: 1,
          baseUnitPrice: 1000n,
          taxRateBps: 0,
        },
        {
          lineId: "L2",
          variantId: "V2",
          quantity: 1,
          baseUnitPrice: 1000n,
          taxRateBps: 0,
        },
        {
          lineId: "L3",
          variantId: "V3",
          quantity: 1,
          baseUnitPrice: 1000n,
          taxRateBps: 0,
        },
      ],
      candidateOrderDiscounts: [
        {
          discountId: "v-10",
          name: "$10 Off Voucher",
          kind: "ORDER_VOUCHER",
          value: { type: "FIXED", amount: 1000n },
        },
        {
          discountId: "promo-5pct",
          name: "5% Order Promo",
          kind: "ORDER_PROMOTION",
          value: { type: "PERCENTAGE", bps: 500 },
        },
      ],
    });

    assert.equal(waterfall.totalGrossAmount, "2000");
    assert.equal(waterfall.lines[0]?.pass2.allocatedOrderDiscountAmount, "334");
    assert.equal(waterfall.lines[1]?.pass2.allocatedOrderDiscountAmount, "333");
    assert.equal(waterfall.lines[2]?.pass2.allocatedOrderDiscountAmount, "333");
    assert.equal(waterfall.suppressedCandidateDiscounts.length, 1);
    assert.equal(waterfall.suppressedCandidateDiscounts[0]?.discountId, "promo-5pct");

    const doctor = mcp.diagnoseStockAvailabilityDoctor({
      variantId: "KR-KB75-TI",
      requestedQuantity: 35,
      availabilityMode: "LEGACY_SHIPPING_ZONE_WAREHOUSES",
      slots: [
        {
          warehouseId: "US-EAST",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "KR-KB75-TI",
          quantityOnHand: 6,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
        {
          warehouseId: "US-CENTRAL",
          priorityRank: 2,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "KR-KB75-TI",
          quantityOnHand: 24,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
        {
          warehouseId: "EU-ROTTERDAM-OVERFLOW",
          priorityRank: 3,
          linkedToChannel: true,
          supportsShippingZone: false,
          variantId: "KR-KB75-TI",
          quantityOnHand: 15,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ],
    });

    assert.equal(doctor.purchasableUnitsDirectMode, 45);
    assert.equal(doctor.shippableUnitsLegacyZoneMode, 30);
    assert.equal(doctor.modeDiscrepancyDetected, true);
    assert.equal(doctor.isFulfillable, false);
    assert.equal(mcp.listInvocationLogs().length, 3);

    // Phase 7 Hybrid BM25 + 64D Vector RRF Semantic Search through MCP
    const rrfReport = mcp.searchCatalogHybridDetailed({
      channelSlug: "us-retail",
      queryText: "quiet mechanical typing",
      inStockOnly: true,
      rrfK: 60,
    });
    assert.equal(rrfReport.rrfK, 60);
    assert.equal(rrfReport.hits[0]?.projection.productSlug, "pro-keyboard");
    assert.equal(rrfReport.hits[0]?.rrfScore > 0, true);
    assert.match(mcp.listInvocationLogs()[0]?.headlineFinding ?? "", /HYBRID RRF SEARCH/);
  });

  it("handles standard MCP JSON-RPC 2.0 initialize, notifications, tools/list with JSON Schema, and tools/call", async () => {
    const mcp = new SuperCommerceMcpServer([
      {
        channelSlug: "us-retail",
        productId: "p-1",
        productSlug: "cnc-dac",
        productName: "CNC Desktop DAC",
        currencyCode: "USD",
        minEffectivePrice: 59_000n,
        maxEffectivePrice: 59_000n,
        isInStock: true,
        totalAvailableQty: 5,
        mergedAttributes: { chassis: ["cnc-aluminum"] },
        variantsSnapshot: [],
      },
    ]);

    const initRes = await mcp.handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    assert.equal(initRes?.id, 1);
    assert.equal((initRes?.result as { protocolVersion: string }).protocolVersion, "2025-03-26");

    // Notification returns null (no response frame)
    const notifRes = await mcp.handleJsonRpcMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(notifRes, null);

    const listRes = await mcp.handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (listRes?.result as { tools: { name: string; inputSchema: Record<string, unknown> }[] }).tools;
    assert.equal(tools.length, 4);
    assert.equal(tools[0]?.inputSchema["type"], "object");

    const callRes = await mcp.handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "search_catalog_hybrid",
        arguments: { channelSlug: "us-retail", queryText: "aluminum dac" },
      },
    });
    const callPayload = callRes?.result as { isError: boolean; content: { type: string; text: string }[] };
    assert.equal(callPayload.isError, false);
    const decoded = JSON.parse(callPayload.content[0]!.text) as { totalReturned: number };
    assert.equal(decoded.totalReturned, 1);
  });
});
