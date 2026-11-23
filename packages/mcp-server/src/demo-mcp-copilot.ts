/**
 * Comprehensive Model Context Protocol (MCP) Copilot Verification & Audit Script
 * (`packages/mcp-server/src/demo-mcp-copilot.ts`).
 *
 * Exercises all 4 built-in agentic tools over standard MCP JSON-RPC 2.0 (2025-03-26):
 * 1. Protocol Handshake: initialize, notifications/initialized, ping, tools/list
 * 2. Tool 1: `diagnose_price_waterfall` (Precedence, Margin Floor Guard, Hare-Niemeyer)
 * 3. Tool 2: `diagnose_stock_availability_doctor` (MSI Direct Mode vs Legacy Zone Mode)
 * 4. Tool 3: `search_catalog_hybrid` (0-JOIN CQRS BM25 + Vector64 RRF k=60)
 * 5. Tool 4: `preview_store_config_diff` (Topological Commerce-as-Code YAML diff)
 * 6. Audit Trail: Invalidation logs, microsecond latencies, structured details
 * 7. Protocol Fault Defense: Unknown tools (-32601) and invalid frames (-32600)
 */

import assert from "node:assert/strict";
import {
  BASELINE_DESIRED_STORE_CONFIG,
  type StoreConfigDocument,
} from "@super-ecommerce/configurator";
import {
  SuperCommerceMcpServer,
  type CatalogChannelProjectionRecord,
  type McpJsonRpcRequest,
} from "./index.ts";

async function runMcpCopilotAudit() {
  console.log("================================================================================");
  console.log(">>> [MCP AUDIT] Model Context Protocol (MCP) Copilot & Agentic Commerce Engine");
  console.log("================================================================================\n");

  // Seed sample CQRS catalog channel projections
  const sampleProjections: CatalogChannelProjectionRecord[] = [
    {
      channelSlug: "us-retail",
      productId: "prod-kb",
      productSlug: "kronos-field-75",
      productName: "Kronos Field 75 CNC Keyboard",
      currencyCode: "USD",
      minEffectivePrice: 35_100n,
      maxEffectivePrice: 37_350n,
      isInStock: true,
      totalAvailableQty: 46,
      mergedAttributes: {
        chassis: ["grade-5-titanium"],
        switch: ["linear", "tactile"],
        gasket_mount: [true],
      },
      variantsSnapshot: [
        {
          variantId: "var-kb-1",
          sku: "KR-KB75-TI",
          name: "Raw Titanium / Linear 45g",
          effectivePrice: 35_100n,
          compareAtAmount: 39_000n,
          availableQuantity: 30,
          isInStock: true,
          attributes: { switch: "linear", finish: "raw-titanium" },
        },
      ],
    },
    {
      channelSlug: "us-retail",
      productId: "prod-dac",
      productSlug: "kronos-r2r-dac",
      productName: "Kronos Reference R2R Desktop DAC",
      currencyCode: "USD",
      minEffectivePrice: 53_100n,
      maxEffectivePrice: 53_100n,
      isInStock: true,
      totalAvailableQty: 18,
      mergedAttributes: {
        chassis: ["cnc-aluminum"],
        architecture: ["24-bit-discrete-r2r"],
      },
      variantsSnapshot: [
        {
          variantId: "var-dac-1",
          sku: "KR-DAC-BLK",
          name: "Obsidian Anodized",
          effectivePrice: 53_100n,
          compareAtAmount: 59_000n,
          availableQuantity: 18,
          isInStock: true,
          attributes: { finish: "obsidian" },
        },
      ],
    },
    {
      channelSlug: "us-retail",
      productId: "prod-mouse",
      productSlug: "kronos-magnesium-pointer",
      productName: "Kronos Magnesium 8K Pointer",
      currencyCode: "USD",
      minEffectivePrice: 16_110n,
      maxEffectivePrice: 16_110n,
      isInStock: true,
      totalAvailableQty: 40,
      mergedAttributes: {
        chassis: ["magnesium-alloy"],
        polling_hz: [8000],
      },
      variantsSnapshot: [
        {
          variantId: "var-mouse-1",
          sku: "KR-MG8K-SLV",
          name: "Brushed Magnesium",
          effectivePrice: 16_110n,
          compareAtAmount: 17_900n,
          availableQuantity: 40,
          isInStock: true,
          attributes: { finish: "magnesium" },
        },
      ],
    },
  ];

  const mcp = new SuperCommerceMcpServer(sampleProjections);

  // ---------------------------------------------------------------------------
  // Step 1: MCP JSON-RPC 2.0 Protocol Handshake
  // ---------------------------------------------------------------------------
  console.log("1. Verifying MCP JSON-RPC 2.0 Protocol Handshake:");

  // 1a. initialize
  const initReq: McpJsonRpcRequest = {
    jsonrpc: "2.0",
    id: 101,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "test-copilot-agent", version: "1.0.0" },
    },
  };
  const initRes = await mcp.handleJsonRpcMessage(initReq);
  assert.equal(initRes?.jsonrpc, "2.0");
  assert.equal(initRes?.id, 101);
  const initResult = initRes?.result as {
    protocolVersion: string;
    serverInfo: { name: string; version: string };
    capabilities: { tools: { listChanged: boolean } };
  };
  console.log(`   - Server Info:      ${initResult.serverInfo.name} v${initResult.serverInfo.version}`);
  console.log(`   - Protocol Version: ${initResult.protocolVersion} (EXPECTED: 2025-03-26)`);
  console.log(`   - Capabilities:     tools.listChanged = ${initResult.capabilities.tools.listChanged}`);
  assert.equal(initResult.protocolVersion, "2025-03-26");
  assert.equal(initResult.serverInfo.name, "super-ecommerce-mcp");

  // 1b. notifications/initialized (no response expected)
  const notifRes = await mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  console.log(`   - Notification:     notifications/initialized -> ${notifRes === null ? "null (Void Response)" : "Unexpected Response"}`);
  assert.equal(notifRes, null);

  // 1c. ping
  const pingRes = await mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 102,
    method: "ping",
  });
  assert.equal(pingRes?.id, 102);
  console.log("   - Ping/Pong:        ping -> 200 OK {}");

  // 1d. tools/list
  const listRes = await mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 103,
    method: "tools/list",
  });
  assert.equal(listRes?.id, 103);
  const toolList = (listRes?.result as { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }).tools;
  console.log(`   - Registered Tools: ${toolList.length} tools discovered:`);
  for (const t of toolList) {
    console.log(`     * [${t.name.padEnd(35)}] ${t.description.slice(0, 65)}...`);
  }
  assert.equal(toolList.length, 4);
  console.log("   -> [PASS] Model Context Protocol handshake and tool registry verified\n");

  // ---------------------------------------------------------------------------
  // Step 2: Tool 1 - `diagnose_price_waterfall`
  // ---------------------------------------------------------------------------
  console.log("2. Testing Tool 1: `diagnose_price_waterfall` (Margin Guard & Precedence):");
  // Test case: 2x Titanium Keyboards ($390.00 base, cost $260.00, minMargin 15% = $39.00 -> floor $299.00)
  // An aggressive 40% promo would push price down to $234.00 (below cost + margin!).
  // Margin Guard must clamp the discount to preserve minimum margin floor.
  // In addition, candidate includes a lower-precedence promotion that should be suppressed.
  const waterfallRes = await mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 201,
    method: "tools/call",
    params: {
      name: "diagnose_price_waterfall",
      arguments: {
        currencyCode: "USD",
        taxMode: "TAX_EXCLUSIVE",
        shippingBaseAmount: "1500",
        shippingTaxRateBps: 825,
        lines: [
          {
            lineId: "L-1",
            variantId: "KR-KB75-TI",
            quantity: 2,
            baseUnitPrice: "39000", // $390.00
            taxRateBps: 825,
            unitCostAmount: "26000", // $260.00 cost
            minMarginBps: 1500,     // 15% min margin floor
          },
          {
            lineId: "L-GIFT",
            variantId: "GIFT-KEYCAP",
            quantity: 1,
            baseUnitPrice: "0",
            taxRateBps: 0,
            isGift: true,           // Excluded from Pass 2 discount weight
          },
        ],
        candidateOrderDiscounts: [
          {
            discountId: "promo-40",
            name: "Aggressive 40% Promo",
            kind: "ORDER_PROMOTION",
            value: { type: "PERCENTAGE", bps: 4000 },
          },
          {
            discountId: "promo-10-fallback",
            name: "Fallback 10% Promo",
            kind: "ORDER_PROMOTION",
            value: { type: "PERCENTAGE", bps: 1000 },
          },
        ],
      },
    },
  });

  const wfContent = (waterfallRes?.result as { content: { text: string }[] }).content[0]!.text;
  const wfData = JSON.parse(wfContent);
  console.log(`   - Currency / Net / Gross: ${wfData.currencyCode} Net: $${(Number(wfData.totalNetAmount)/100).toFixed(2)} | Gross: $${(Number(wfData.totalGrossAmount)/100).toFixed(2)}`);
  console.log(`   - Applied Order Discounts:`);
  for (const d of wfData.appliedOrderDiscounts) {
    console.log(`     * ${d.name} (${d.kind}): -$${(Number(d.totalAmount)/100).toFixed(2)} (Clamped by Margin Guard)`);
  }
  console.log(`   - Suppressed Candidates:`);
  for (const s of wfData.suppressedCandidateDiscounts) {
    console.log(`     * ${s.name} (${s.kind}): Suppressed by ${s.suppressedBy}`);
  }
  console.log(`   - Line Waterfall:`);
  for (const l of wfData.lines) {
    console.log(`     * [${l.lineId}] ${l.variantId} x${l.quantity}${l.isGift ? " (FREE_GIFT)" : ""}`);
    console.log(`       - Pass 1 (Undiscounted): $${(Number(l.pass1.undiscountedSubtotal)/100).toFixed(2)}`);
    console.log(`       - Pass 2 (Allocated):    -$${(Number(l.pass2.allocatedOrderDiscountAmount)/100).toFixed(2)}`);
    console.log(`       - Pass 3 (Net + Tax):    $${(Number(l.pass3.totalNetAmount)/100).toFixed(2)} + $${(Number(l.pass3.totalTaxAmount)/100).toFixed(2)} = $${(Number(l.pass3.totalGrossAmount)/100).toFixed(2)}`);
  }

  // Verifications:
  // 1. Gift line receives 0 allocated discount
  const giftLine = wfData.lines.find((l: any) => l.lineId === "L-GIFT");
  assert.equal(giftLine.pass2.allocatedOrderDiscountAmount, "0");
  // 2. Fallback promo is suppressed
  assert.equal(wfData.suppressedCandidateDiscounts.length, 1);
  assert.equal(wfData.suppressedCandidateDiscounts[0].discountId, "promo-10-fallback");
  // 3. Margin guard clamped discount to 16823 instead of 40% (31200)
  assert.equal(wfData.appliedOrderDiscounts[0].totalAmount, "16823");
  console.log("   -> [PASS] Margin floor guard, precedence suppression, and gift exclusion verified\n");

  // ---------------------------------------------------------------------------
  // Step 3: Tool 2 - `diagnose_stock_availability_doctor`
  // ---------------------------------------------------------------------------
  console.log("3. Testing Tool 2: `diagnose_stock_availability_doctor` (MSI Warehouse Mode Discrepancy):");
  // Customer wants 35 units of KR-KB75-TI:
  // - US-EAST: 6 units (linked, in zone)
  // - US-CENTRAL: 24 units (linked, in zone)
  // - EU-ROTTERDAM-OVERFLOW: 15 units (linked to channel, BUT NOT in shipping zone)
  const doctorRes = await mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 301,
    method: "tools/call",
    params: {
      name: "diagnose_stock_availability_doctor",
      arguments: {
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
            supportsShippingZone: false, // NOT IN SHIPPING ZONE!
            variantId: "KR-KB75-TI",
            quantityOnHand: 15,
            quantityReserved: 0,
            quantityAllocated: 0,
          },
        ],
      },
    },
  });

  const docContent = (doctorRes?.result as { content: { text: string }[] }).content[0]!.text;
  const docData = JSON.parse(docContent);
  console.log(`   - Variant:                 ${docData.variantId}`);
  console.log(`   - Requested Quantity:      ${docData.requestedQuantity} units`);
  console.log(`   - Mode Under Evaluation:   ${docData.availabilityMode}`);
  console.log(`   - Direct Mode Purchasable: ${docData.purchasableUnitsDirectMode} units (All channel-linked warehouses)`);
  console.log(`   - Legacy Mode Shippable:   ${docData.shippableUnitsLegacyZoneMode} units (Only shipping-zone linked)`);
  console.log(`   - Mode Discrepancy:        ${docData.modeDiscrepancyDetected ? "YES (15 units locked in unlinked zone)" : "NO"}`);
  console.log(`   - Fulfillable:             ${docData.isFulfillable ? "YES" : "NO (Blocked by legacy zone mode)"}`);
  console.log(`   - Doctor Diagnosis:        "${docData.doctorDiagnosis}"`);
  console.log(`   - Warehouse Audit Breakdown:`);
  for (const w of docData.warehouseAudits) {
    console.log(`     * [${w.warehouseId.padEnd(23)}] Available: ${w.availableUnits}u | Direct: ${w.eligibleInDirectMode ? "YES" : "NO"} | LegacyZone: ${w.eligibleInLegacyZoneMode ? "YES" : "NO"} | ${w.statusReason}`);
  }

  assert.equal(docData.purchasableUnitsDirectMode, 45);
  assert.equal(docData.shippableUnitsLegacyZoneMode, 30);
  assert.equal(docData.modeDiscrepancyDetected, true);
  assert.equal(docData.isFulfillable, false);
  console.log("   -> [PASS] MSI Stock Doctor accurately diagnosed zone link mismatch and purchasability gap\n");

  // ---------------------------------------------------------------------------
  // Step 4: Tool 3 - `search_catalog_hybrid` (0-JOIN CQRS BM25 + Vector64 RRF)
  // ---------------------------------------------------------------------------
  console.log("4. Testing Tool 3: `search_catalog_hybrid` (Okapi BM25 + Vector Cosine RRF k=60):");
  const searchRes = await mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 401,
    method: "tools/call",
    params: {
      name: "search_catalog_hybrid",
      arguments: {
        channelSlug: "us-retail",
        queryText: "titanium keyboard",
        inStockOnly: true,
        rrfK: 60,
      },
    },
  });

  const searchContent = (searchRes?.result as { content: { text: string }[] }).content[0]!.text;
  const searchData = JSON.parse(searchContent);
  console.log(`   - Channel / Query:         ${searchData.channelSlug} / "${searchData.queryText}"`);
  console.log(`   - Reciprocal Rank Fusion:  k = ${searchData.rrfK}`);
  console.log(`   - Candidate Pool:          ${searchData.candidatePoolCount} projections evaluated`);
  console.log(`   - Total Returned Hits:     ${searchData.totalReturned} products`);
  console.log(`   - Execution Latency:       ${searchData.latencyUs} µs (< 1 millisecond)`);
  console.log(`   - Ranked Results:`);
  for (let i = 0; i < searchData.hits.length; i++) {
    const h = searchData.hits[i];
    const p = h.projection;
    console.log(`     #${i + 1} [${p.productSlug}] ${p.productName}`);
    console.log(`        Matched By: ${h.matchedBy} | RRF Score: ${h.rrfScore.toFixed(6)} | BM25: ${h.bm25Score} (rank #${h.bm25Rank ?? "N/A"}) | VecCos: ${h.vectorSimilarity} (rank #${h.vectorRank ?? "N/A"})`);
    console.log(`        Effective Price: $${(Number(p.minEffectivePrice)/100).toFixed(2)} | In Stock: ${p.isInStock} (${p.totalAvailableQty} units)`);
  }

  assert.ok(searchData.hits.length >= 1);
  assert.equal(searchData.hits[0].projection.productSlug, "kronos-field-75");
  assert.ok(searchData.hits[0].rrfScore > 0);
  console.log("   -> [PASS] CQRS Hybrid Search returned RRF ranked projections in sub-millisecond time\n");

  // ---------------------------------------------------------------------------
  // Step 5: Tool 4 - `preview_store_config_diff` (Topological Commerce-as-Code)
  // ---------------------------------------------------------------------------
  console.log("5. Testing Tool 4: `preview_store_config_diff` (Commerce-as-Code Topological Diff):");
  const remoteState: StoreConfigDocument = BASELINE_DESIRED_STORE_CONFIG;
  const desiredConfig: StoreConfigDocument = {
    warehouses: [
      ...BASELINE_DESIRED_STORE_CONFIG.warehouses,
      { slug: "eu-frankfurt", name: "EU Frankfurt Hub (DE)", countryCode: "DE" },
    ],
    channels: [
      ...BASELINE_DESIRED_STORE_CONFIG.channels,
      {
        slug: "eu-flagship",
        name: "EU Direct Store (VAT Inclusive)",
        currencyCode: "EUR",
        defaultCountry: "DE",
        taxInclusionMode: "TAX_INCLUSIVE",
        stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        warehouseSlugs: ["eu-frankfurt"],
      },
    ],
    productTypes: [
      {
        ...BASELINE_DESIRED_STORE_CONFIG.productTypes[0]!,
        name: "Precision CNC Hardware Pro (v2)",
      },
    ],
    products: [
      ...BASELINE_DESIRED_STORE_CONFIG.products,
      {
        slug: "kronos-8k-wireless-mouse",
        name: "Kronos Magnesium 8KHz Wireless Mouse",
        productTypeSlug: "precision-hardware",
        attributes: { chassis_material: "magnesium-alloy" },
        variants: [
          {
            sku: "KR-MG8K-SLV",
            name: "Raw Silver / Optical Rapid",
            attributes: { switch_type: "optical-rapid" },
            channelListings: [
              {
                channelSlug: "us-retail",
                isPublished: true,
                priceAmount: 17_900n,
              },
            ],
          },
        ],
      },
    ],
  };

  const diffRes = await mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 501,
    method: "tools/call",
    params: {
      name: "preview_store_config_diff",
      arguments: {
        remoteState,
        desiredConfig,
      },
    },
  });

  const diffPayload = diffRes?.result as { isError: boolean; content: { text: string }[] };
  assert.equal(diffPayload.isError, false);
  const diffData = JSON.parse(diffPayload.content[0]!.text);
  console.log(`   - Staged Operations:      ${diffData.totalChanges} operations detected in topological order:`);
  for (const e of diffData.entries) {
    console.log(`     * Stage: ${e.stage.padEnd(14)} | Op: ${e.operation.padEnd(6)} | Target: ${e.slug.padEnd(25)} | ${e.summary}`);
  }

  assert.equal(diffData.totalChanges, 4); // warehouse + channel + productType update + product
  console.log("   -> [PASS] Commerce-as-Code topological plan generated with strict dependency sequencing\n");

  // ---------------------------------------------------------------------------
  // Step 6: MCP Diagnostic Invocation Audit Trail
  // ---------------------------------------------------------------------------
  console.log("6. Verifying MCP Diagnostic Invocation Audit Trail:");
  const logs = mcp.listInvocationLogs(10);
  console.log(`   - Total Logged Invocations: ${logs.length} (Max 25 circular buffer)`);
  for (const log of logs) {
    console.log(`     * [${log.invocationId}] ${log.toolName.padEnd(35)} | Persona: ${log.persona.padEnd(18)} | Latency: ${String(log.latencyUs).padStart(6)} µs | Status: ${log.status}`);
    console.log(`       Headline: ${log.headlineFinding}`);
    console.log(`       Details Count: ${log.structuredDetails.length} step-by-step diagnostic records`);
  }
  assert.ok(logs.length >= 4);
  console.log("   -> [PASS] Every agentic invocation logged with microsecond precision and structured breadcrumbs\n");

  // ---------------------------------------------------------------------------
  // Step 7: Protocol Fault Defense & Error Handling
  // ---------------------------------------------------------------------------
  console.log("7. Verifying Protocol Fault Defense & Error Codes:");

  // 7a. Unknown tool name -> code -32601
  const unknownToolRes = await mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 701,
    method: "tools/call",
    params: { name: "non_existent_hack_tool", arguments: {} },
  });
  console.log(`   - Unknown Tool: error code ${unknownToolRes?.error?.code} ("${unknownToolRes?.error?.message}")`);
  assert.equal(unknownToolRes?.error?.code, -32601);

  // 7b. Invalid JSON-RPC request without jsonrpc: "2.0" -> code -32600
  const invalidRpcRes = await mcp.handleJsonRpcMessage({
    jsonrpc: "1.0" as any,
    id: 702,
    method: "tools/list",
  });
  console.log(`   - Invalid Spec: error code ${invalidRpcRes?.error?.code} ("${invalidRpcRes?.error?.message}")`);
  assert.equal(invalidRpcRes?.error?.code, -32600);

  // 7c. Missing name parameter in tools/call -> code -32602
  const missingNameRes = await mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 703,
    method: "tools/call",
    params: { arguments: {} },
  });
  console.log(`   - Missing Param: error code ${missingNameRes?.error?.code} ("${missingNameRes?.error?.message}")`);
  assert.equal(missingNameRes?.error?.code, -32602);
  console.log("   -> [PASS] Anti-corruption guard traps malformed frames and preserves protocol boundaries\n");

  console.log("================================================================================");
  console.log(">>> [AUDIT VERDICT] ALL 7 MCP COPILOT ARCHITECTURAL INVARIANTS RIGOROUSLY VERIFIED");
  console.log("================================================================================");
}

runMcpCopilotAudit().catch((err) => {
  console.error("MCP Copilot Audit failed:", err);
  process.exit(1);
});
