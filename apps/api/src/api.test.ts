import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OfflinePgPool, runMigrations } from "@super-ecommerce/db";
import { MsiInventoryService, signStripeWebhookPayload } from "@super-ecommerce/core";
import {
  createSuperCommerceGateway,
  inspectGraphQlQuerySecurity,
  runGatewayProtocolStressBenchmark,
} from "./index.ts";
import { createAppRequestHandler } from "./dev-server.ts";
import { startProductionApiServer } from "./prod-server.ts";
import { createBackgroundMaintenanceDaemon } from "./worker.ts";

describe("@super-ecommerce/api — Dual-Protocol Gateway", () => {
  const gateway = createSuperCommerceGateway({
    projections: [
      {
        channelSlug: "us-retail",
        productId: "prod-1",
        productSlug: "titanium-watch",
        productName: "Titanium Field Watch",
        currencyCode: "USD",
        minEffectivePrice: 49_900n,
        maxEffectivePrice: 49_900n,
        isInStock: true,
        totalAvailableQty: 8,
        mergedAttributes: { case_material: ["titanium"], water_resistant: [true] },
        variantsSnapshot: [],
      },
    ],
    inventoryService: new MsiInventoryService([
      {
        warehouseId: "WH-US-1",
        priorityRank: 1,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "VAR-WATCH",
        quantityOnHand: 8,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
    ]),
  });

  it("serves CQRS read projections over both HTTP /rpc/catalog.search and /graphql", async () => {
    // 1. Test /rpc/catalog.search
    const rpcRes = await gateway.fetch(
      new Request("http://localhost/rpc/catalog.search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelSlug: "us-retail",
          inStockOnly: true,
          attributeFilters: { case_material: "titanium" },
        }),
      })
    );
    assert.equal(rpcRes.status, 200);
    const rpcJson = (await rpcRes.json()) as {
      ok: boolean;
      data: { productSlug: string; minEffectivePrice: string }[];
    };
    assert.equal(rpcJson.ok, true);
    assert.equal(rpcJson.data.length, 1);
    assert.equal(rpcJson.data[0]?.productSlug, "titanium-watch");
    assert.equal(rpcJson.data[0]?.minEffectivePrice, "49900");

    // 2. Test Saleor-compatible /graphql products(channel: "us-retail")
    const gqlRes = await gateway.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query { products(channel: "us-retail") { edges { node { slug isAvailable } } } }`,
        }),
      })
    );
    assert.equal(gqlRes.status, 200);
    const gqlJson = (await gqlRes.json()) as {
      data: { products: { edges: { node: { slug: string; isAvailable: boolean } }[] } };
    };
    assert.equal(gqlJson.data.products.edges[0]?.node.slug, "titanium-watch");
    assert.equal(gqlJson.data.products.edges[0]?.node.isAvailable, true);
  });

  it("executes end-to-end checkout via direct typed rpcClient.checkout.complete", async () => {
    const checkoutRes = await gateway.rpcClient.checkout.complete({
      idempotencyKey: "api-chk-1",
      input: {
        checkoutId: "chk-watch-1",
        channelSlug: "us-retail",
        stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        paymentToken: "tok_amex",
        expectedTotalGrossAmount: 49_900n,
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 0,
          lines: [
            {
              lineId: "L1",
              variantId: "VAR-WATCH",
              quantity: 1,
              baseUnitPrice: 49_900n,
              taxRateBps: 0,
            },
          ],
        },
      },
    });

    assert.equal(checkoutRes.status, "COMPLETED");
    assert.equal(checkoutRes.output?.orderId, "ord_chk-watch-1");
    assert.equal((await gateway.outboxService.listPending()).length, 1);

    // Execute RMA partial/full return via rpcClient.rma.processReturn
    const rmaRes = await gateway.rpcClient.rma.processReturn({
      idempotencyKey: "api-rma-1",
      input: {
        rmaId: "rma-watch-1",
        orderId: "ord_chk-watch-1",
        linesToReturn: [{ lineId: "L1", quantity: 1, condition: "RESELLABLE" }],
      },
    });
    assert.equal(rmaRes.status, "COMPLETED");
    assert.equal(rmaRes.output?.calculation.totalRefundGrossAmount, 49_900n);
    assert.equal(rmaRes.output?.orderPaymentStatusAfter, "REFUNDED");
  });

  it("verifies POST /webhooks/stripe HMAC-SHA256 signatures, rejects tampered/replayed requests with 401, and reconciles order status", async () => {
    const rawBody = JSON.stringify({
      id: "evt_api_refund_01",
      type: "charge.refunded",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "ch_watch_refund_01",
          amount: 49900,
          currency: "usd",
          metadata: {
            orderId: "ord_chk-watch-1",
            checkoutId: "chk-watch-1",
            channelSlug: "us-retail",
          },
        },
      },
    });

    const validSig = signStripeWebhookPayload({
      rawBody,
      secret: "whsec_super_ecommerce_2026_active",
    });

    // 1. Tampered payload -> 401 SIGNATURE_MISMATCH
    const tamperedRes = await gateway.fetch(
      new Request("http://localhost/webhooks/stripe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": validSig,
        },
        body: rawBody.replace("49900", "99900"),
      })
    );
    assert.equal(tamperedRes.status, 401);
    const tamperedJson = (await tamperedRes.json()) as { code: string };
    assert.equal(tamperedJson.code, "SIGNATURE_MISMATCH");

    // 2. Valid signature -> 200 OK & Order paymentStatus updated to REFUNDED
    const okRes = await gateway.fetch(
      new Request("http://localhost/webhooks/stripe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": validSig,
        },
        body: rawBody,
      })
    );
    assert.equal(okRes.status, 200);
    const okJson = (await okRes.json()) as {
      ok: boolean;
      data: { duplicate: boolean; updatedPaymentStatus: string };
    };
    assert.equal(okJson.ok, true);
    assert.equal(okJson.data.duplicate, false);
    assert.equal(okJson.data.updatedPaymentStatus, "REFUNDED");
    const reloadedWatchOrder = await gateway.rpcClient.orders.get({ orderId: "ord_chk-watch-1" });
    assert.equal(reloadedWatchOrder?.order.paymentStatus, "REFUNDED");
  });

  it("blocks GraphQL AST depth bombs and field alias amplification attacks while running protocol stress benchmark", async () => {
    const depthCheck = inspectGraphQlQuerySecurity(
      "query { a { b { c { d { e { f { g { id } } } } } } } }",
      6,
      8
    );
    assert.equal(depthCheck.allowed, false);
    assert.equal(depthCheck.violationCode, "GRAPHQL_DEPTH_LIMIT_EXCEEDED");

    const aliasCheck = inspectGraphQlQuerySecurity(
      "query { a1:products{id} a2:products{id} a3:products{id} a4:products{id} a5:products{id} a6:products{id} a7:products{id} a8:products{id} a9:products{id} }",
      6,
      8
    );
    assert.equal(aliasCheck.allowed, false);
    assert.equal(aliasCheck.violationCode, "GRAPHQL_ALIAS_AMPLIFICATION_BLOCKED");

    const report = await runGatewayProtocolStressBenchmark({
      projections: [
        {
          channelSlug: "us-retail",
          productId: "prod-1",
          productSlug: "titanium-watch",
          productName: "Titanium Field Watch",
          currencyCode: "USD",
          minEffectivePrice: 49_900n,
          maxEffectivePrice: 49_900n,
          isInStock: true,
          totalAvailableQty: 8,
          mergedAttributes: { case_material: ["titanium"] },
          variantsSnapshot: [],
        },
      ],
      scale: 0.25,
      forceRefresh: true,
    });
    assert.equal(report.tiers.length, 5);
    assert.equal(report.dosAttacksBlockedCount > 0, true);
    assert.equal(report.inProcessOrpcReqPerSec > 0, true);
  });

  it("evaluates and approves B2B Net-30 purchase orders via typed rpcClient.b2b", async () => {
    const b2bGateway = createSuperCommerceGateway({
      inventoryService: new MsiInventoryService([
        {
          warehouseId: "WH-B2B-1",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "VAR-B2B-WATCH",
          quantityOnHand: 20,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]),
    });

    const companies = await b2bGateway.rpcClient.b2b.listCompanies();
    assert.equal(companies.length, 1);
    assert.equal(companies[0]?.companyId, "comp-kronos-b2b");

    // Buyer Elena orders 10 units at $300.00 tier -> $3,000.00 - 5% = $2,850.00 (> $2,500 limit -> PENDING_APPROVAL)
    const pendingRes = await b2bGateway.rpcClient.b2b.submitPo({
      idempotencyKey: "api-b2b-po-1",
      input: {
        poId: "po_api_1",
        poNumber: "PO-API-001",
        companyId: "comp-kronos-b2b",
        costCenterId: "cc-hw-lab",
        buyerId: "buyer-elena",
        channelSlug: "us-b2b",
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 825,
          lines: [
            {
              lineId: "L-1",
              variantId: "VAR-B2B-WATCH",
              quantity: 10,
              baseUnitPrice: 32_000n,
              tierPrices: [{ minQuantity: 10, unitAmount: 30_000n }],
              taxRateBps: 825,
            },
          ],
        },
      },
    });
    assert.equal(pendingRes.po.status, "PENDING_APPROVAL");
    assert.equal(pendingRes.po.pricing.totalGrossAmount, 285_000n);

    // Approver Marcus approves the PO via Saga -> APPROVED_BY_SUPERVISOR
    const approvedRes = await b2bGateway.rpcClient.b2b.decidePo({
      idempotencyKey: "api-b2b-decide-1",
      poId: "po_api_1",
      approverId: "approver-marcus",
      decision: "APPROVE",
    });
    assert.equal(approvedRes.po.status, "APPROVED_BY_SUPERVISOR");
    assert.equal(approvedRes.order?.orderId, "ord_po_api_1");
  });

  it("exposes Phase 7 /rpc/catalog.hybridSearch and /rpc/inventory.reapExpiredReservations", async () => {
    // 1. Test /rpc/catalog.hybridSearch with semantic query ("waterproof timepiece") matching titanium-watch
    const searchRes = await gateway.fetch(
      new Request("http://localhost/rpc/catalog.hybridSearch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelSlug: "us-retail",
          queryText: "waterproof timepiece",
          inStockOnly: true,
          rrfK: 60,
        }),
      })
    );
    assert.equal(searchRes.status, 200);
    const searchJson = (await searchRes.json()) as {
      ok: boolean;
      data: {
        rrfK: number;
        hits: { projection: { productSlug: string }; rrfScore: number; matchedBy: string }[];
      };
    };
    assert.equal(searchJson.ok, true);
    assert.equal(searchJson.data.rrfK, 60);
    assert.equal(searchJson.data.hits[0]?.projection.productSlug, "titanium-watch");
    assert.equal(searchJson.data.hits[0]?.rrfScore > 0, true);

    // 2. Test /rpc/inventory.reapExpiredReservations on an expired B2B PO hold
    const ttlGateway = createSuperCommerceGateway({
      inventoryService: new MsiInventoryService([
        {
          warehouseId: "WH-TTL-1",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "VAR-TTL-1",
          quantityOnHand: 20,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]),
    });

    const tNow = 1_763_400_000_000;
    await ttlGateway.rpcClient.b2b.submitPo({
      idempotencyKey: "api-ttl-po-1",
      input: {
        poId: "po_api_ttl_1",
        poNumber: "PO-API-TTL-1",
        companyId: "comp-kronos-b2b",
        costCenterId: "cc-hw-lab",
        buyerId: "buyer-elena",
        channelSlug: "us-b2b",
        ttlSecondsOverride: 60,
        nowMs: tNow - 180_000,
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 825,
          lines: [
            {
              lineId: "L-TTL",
              variantId: "VAR-TTL-1",
              quantity: 5,
              baseUnitPrice: 65_000n,
              taxRateBps: 825,
            },
          ],
        },
      },
    });
    assert.equal(
      (await ttlGateway.inventoryService.getSlot("WH-TTL-1", "VAR-TTL-1"))?.quantityReserved,
      5
    );

    const reapRes = await ttlGateway.fetch(
      new Request("http://localhost/rpc/inventory.reapExpiredReservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nowMs: tNow }),
      })
    );
    assert.equal(reapRes.status, 200);
    const reapJson = (await reapRes.json()) as {
      ok: boolean;
      data: {
        stockReap: { reapedReservationCount: number; totalUnitsReleased: number };
        expiredPos: { poNumber: string; status: string }[];
      };
    };
    assert.equal(reapJson.ok, true);
    assert.equal(reapJson.data.stockReap.reapedReservationCount, 1);
    assert.equal(reapJson.data.stockReap.totalUnitsReleased, 5);
    assert.equal(reapJson.data.expiredPos[0]?.status, "EXPIRED_TTL");
    assert.equal(
      (await ttlGateway.inventoryService.getSlot("WH-TTL-1", "VAR-TTL-1"))?.quantityReserved,
      0
    );
  });

  it("persists orders, RMAs, outbox, inventory, and B2B POs across gateway restarts in PostgreSQL and serves keyset cursor paginated /rpc/orders.list & /rpc/orders.get", async () => {
    const pgPool = new OfflinePgPool();
    await runMigrations(pgPool);

    const gw1 = createSuperCommerceGateway({
      pgPool,
      inventoryService: new MsiInventoryService([
        {
          warehouseId: "WH-PG-1",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "VAR-PG-1",
          quantityOnHand: 20,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]),
    });

    const chk1 = await gw1.rpcClient.checkout.complete({
      idempotencyKey: "pg-gw-chk-1",
      input: {
        checkoutId: "pg-watch-1",
        channelSlug: "us-retail",
        customerId: "cust_pg_1",
        stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        paymentToken: "tok_visa",
        expectedTotalGrossAmount: 25_000n,
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 0,
          lines: [
            { lineId: "L1", variantId: "VAR-PG-1", quantity: 2, baseUnitPrice: 12_500n, taxRateBps: 0 },
          ],
        },
      },
    });
    assert.equal(chk1.status, "COMPLETED");

    const rma1 = await gw1.rpcClient.rma.processReturn({
      idempotencyKey: "pg-gw-rma-1",
      input: {
        rmaId: "rma-pg-1",
        orderId: "ord_pg-watch-1",
        linesToReturn: [{ lineId: "L1", quantity: 1, condition: "RESELLABLE" }],
      },
    });
    assert.equal(rma1.status, "COMPLETED");

    // Seed 4 additional orders with deterministic timestamps (including tie on ts_tie) to test keyset pagination
    const seededRows = [
      { id: "ord_ks_1", checkoutId: "ks_1", channel: "us-retail", status: "CAPTURED", createdAt: "2026-11-16T10:00:00.000Z" },
      { id: "ord_ks_2", checkoutId: "ks_2", channel: "eu-flagship", status: "CAPTURED", createdAt: "2026-11-16T10:05:00.000Z" },
      { id: "ord_ks_3a", checkoutId: "ks_3a", channel: "us-retail", status: "PARTIALLY_REFUNDED", createdAt: "2026-11-16T10:10:00.000Z" },
      { id: "ord_ks_3b", checkoutId: "ks_3b", channel: "us-retail", status: "CAPTURED", createdAt: "2026-11-16T10:10:00.000Z" },
    ];
    for (const s of seededRows) {
      const payload = {
        orderId: s.id,
        checkoutId: s.checkoutId,
        channelSlug: s.channel,
        customerId: `cust_${s.checkoutId}`,
        currencyCode: s.channel === "eu-flagship" ? "EUR" : "USD",
        pricing: {
          currencyCode: s.channel === "eu-flagship" ? "EUR" : "USD",
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
          lines: [],
        },
        shipments: [],
        paymentStatus: s.status,
        paymentTransactionId: `tx_${s.checkoutId}`,
        paymentCapturedAmount: 10_000n,
        createdAt: s.createdAt,
      };
      await pgPool.query(
        `INSERT INTO orders (
           id, checkout_id, channel_slug, customer_id, currency_code,
           total_gross_amount, payment_transaction_id, payment_status,
           allocations_json, payload_json, fulfillment_status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]'::jsonb, $9::jsonb, 'UNFULFILLED', $10::timestamptz, $10::timestamptz)`,
        [
          s.id,
          s.checkoutId,
          s.channel,
          `cust_${s.checkoutId}`,
          payload.currencyCode,
          "10000",
          payload.paymentTransactionId,
          s.status,
          JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v)),
          s.createdAt,
        ]
      );
    }

    // Fresh gateway sharing ONLY pgPool sees all persisted PG state
    const gw2 = createSuperCommerceGateway({ pgPool });

    const fetchedOrderRes = await gw2.fetch(
      new Request("http://localhost/rpc/orders.get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: "ord_pg-watch-1" }),
      })
    );
    assert.equal(fetchedOrderRes.status, 200);
    const fetchedOrderJson = (await fetchedOrderRes.json()) as {
      ok: boolean;
      data: {
        order: { orderId: string; paymentStatus: string };
        returns: { rmaId: string }[];
      };
    };
    assert.equal(fetchedOrderJson.ok, true);
    assert.equal(fetchedOrderJson.data.order.orderId, "ord_pg-watch-1");
    assert.equal(fetchedOrderJson.data.order.paymentStatus, "PARTIALLY_REFUNDED");
    assert.equal(fetchedOrderJson.data.returns.length, 1);
    assert.equal(fetchedOrderJson.data.returns[0]?.rmaId, "rma-pg-1");

    const slotInGw2 = await gw2.inventoryService.getSlot("WH-PG-1", "VAR-PG-1");
    assert.equal(slotInGw2?.quantityAllocated, 1);

    // Keyset pagination page 1 -> page 2 -> page 3 over HTTP POST /rpc/orders.list
    const seenIds: string[] = [];
    const p1Res = await gw2.fetch(
      new Request("http://localhost/rpc/orders.list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2 }),
      })
    );
    assert.equal(p1Res.status, 200);
    const p1 = (await p1Res.json()) as {
      ok: boolean;
      data: {
        items: { order: { orderId: string } }[];
        hasMore: boolean;
        hasPrev: boolean;
        nextCursor: string | null;
        prevCursor: string | null;
        totalMatchingCount: number;
      };
    };
    assert.equal(p1.data.totalMatchingCount, 5);
    assert.equal(p1.data.items.length, 2);
    assert.equal(p1.data.hasMore, true);
    assert.equal(p1.data.hasPrev, false);
    assert.ok(p1.data.nextCursor);
    seenIds.push(...p1.data.items.map((it) => it.order.orderId));

    const p2Res = await gw2.fetch(
      new Request("http://localhost/rpc/orders.list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2, cursor: p1.data.nextCursor }),
      })
    );
    const p2 = (await p2Res.json()) as typeof p1;
    assert.equal(p2.data.items.length, 2);
    assert.equal(p2.data.hasMore, true);
    assert.equal(p2.data.hasPrev, true);
    assert.ok(p2.data.nextCursor);
    assert.ok(p2.data.prevCursor);
    seenIds.push(...p2.data.items.map((it) => it.order.orderId));

    // Verify backward cursor navigation from Page 2 returns exact Page 1 items
    const backRes = await gw2.rpcClient.orders.list({
      limit: 2,
      cursor: p2.data.prevCursor!,
      direction: "prev",
    });
    assert.deepEqual(
      backRes.items.map((i) => i.order.orderId),
      p1.data.items.map((i) => i.order.orderId)
    );

    const p3 = await gw2.rpcClient.orders.list({ limit: 2, cursor: p2.data.nextCursor! });
    assert.equal(p3.items.length, 1);
    assert.equal(p3.hasMore, false);
    assert.equal(p3.hasPrev, true);
    seenIds.push(...p3.items.map((it) => it.order.orderId));

    // Exact 5 unique orders, tie-broken cleanly by (created_at DESC, id DESC)
    assert.equal(new Set(seenIds).size, 5);
    assert.deepEqual(seenIds, [
      "ord_pg-watch-1",
      "ord_ks_3b",
      "ord_ks_3a",
      "ord_ks_2",
      "ord_ks_1",
    ]);

    // Channel + search filtering
    const filtered = await gw2.rpcClient.orders.list({
      limit: 10,
      channelSlug: "eu-flagship",
      q: "ks_2",
    });
    assert.equal(filtered.totalMatchingCount, 1);
    assert.equal(filtered.items[0]?.order.orderId, "ord_ks_2");

    // Invalid cursor returns HTTP 400
    const badCursorRes = await gw2.fetch(
      new Request("http://localhost/rpc/orders.list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2, cursor: "not-valid-base64-cursor!!!" }),
      })
    );
    assert.equal(badCursorRes.status, 400);

    await pgPool.close();
  });

  it("serves Phase 8 Storefront PDP/Checkout/Orders SSR routes, Self-Service RMA estimator/submitter, Online YAML Configurator, and live Admin SSE stream", async () => {
    const appHandler = createAppRequestHandler();

    // 1. Dedicated PDP route with URL-synced multi-variant SKU selection & MSI stock table
    const pdpRes = await appHandler(
      new Request("http://localhost/products/kronos-field-75?variant=KR-KB75-BLK&channel=us-retail")
    );
    assert.equal(pdpRes.status, 200);
    const pdpHtml = await pdpRes.text();
    assert.match(pdpHtml, /KR-KB75-BLK/);
    assert.match(pdpHtml, /Kronos Field 75 CNC Keyboard/);
    assert.match(pdpHtml, /Live Multi-Source Inventory \(MSI\) Warehouse Allocation/);

    // 2. Dedicated Checkout route + Live Two-Pass Recalculation Tax Formatting
    const checkoutPageRes = await appHandler(
      new Request("http://localhost/checkout?channel=us-retail")
    );
    assert.equal(checkoutPageRes.status, 200);
    const checkoutHtml = await checkoutPageRes.text();
    assert.match(checkoutHtml, /Durable Checkout &amp; Two-Pass Kernel Workbench/);

    const recalcRes = await appHandler(
      new Request("http://localhost/api/demo/recalculate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelSlug: "us-retail",
          includePromo: true,
          includeVoucher: true,
          includeManual: false,
        }),
      })
    );
    assert.equal(recalcRes.status, 200);
    const recalcJson = (await recalcRes.json()) as {
      totalTaxFormatted: string;
      lines: { taxFormatted: string; totalNetFormatted: string }[];
    };
    assert.equal(recalcJson.totalTaxFormatted.includes("NaN"), false);
    assert.ok(recalcJson.lines.length > 0);
    for (const line of recalcJson.lines) {
      assert.equal(line.taxFormatted.includes("NaN"), false);
      assert.match(line.taxFormatted, /^\$\d+\.\d{2}$/);
    }

    // 3. Seeded Orders Ledger & Order Detail RMA Portal (ord_chk-100: 3x $10.00 - $20.00 voucher = $10.00)
    const ordersListRes = await appHandler(new Request("http://localhost/orders"));
    assert.equal(ordersListRes.status, 200);
    assert.match(await ordersListRes.text(), /ord_chk-100/);

    const orderDetailRes = await appHandler(new Request("http://localhost/orders/ord_chk-100"));
    assert.equal(orderDetailRes.status, 200);
    const orderDetailHtml = await orderDetailRes.text();
    assert.match(orderDetailHtml, /Self-Service RMA Return Estimator/);
    assert.equal(orderDetailHtml.includes("#undefined"), false);

    // 4. Live Rust N-API RMA Estimate on ord_chk-100 -> 1 of 3 units on $10.00 = $3.34 (334 cents Hare-Niemeyer ceiling)
    const estRes = await appHandler(
      new Request("http://localhost/api/demo/rma-estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: "ord_chk-100",
          tenderPriority: "GATEWAY_CASH_FIRST",
          linesToReturn: [{ lineId: "L-SEED-1", quantity: 1, condition: "RESELLABLE", restockingFeeBps: 0 }],
        }),
      })
    );
    assert.equal(estRes.status, 200);
    const estJson = (await estRes.json()) as {
      ok: boolean;
      preview: { totalRefundGrossAmount: string; totalRefundGrossFormatted: string };
    };
    assert.equal(estJson.ok, true);
    assert.equal(estJson.preview.totalRefundGrossAmount, "334");
    assert.equal(estJson.preview.totalRefundGrossFormatted, "$3.34");

    // 5. Full Closed-Loop: Execute Checkout -> Self-Service RMA Submit -> REFUNDED
    const chkExecRes = await appHandler(
      new Request("http://localhost/api/demo/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelSlug: "us-retail",
          includePromo: false,
          includeVoucher: false,
          includeManual: false,
          storeCreditToRedeemCents: 2500,
          customLines: [
            { variantId: "KR-DAC-BLK", quantity: 2, baseUnitPrice: 10_000, isGift: false },
          ],
        }),
      })
    );
    assert.equal(chkExecRes.status, 200);
    const chkExecJson = (await chkExecRes.json()) as { status: string; orderId: string };
    assert.equal(chkExecJson.status, "COMPLETED");
    assert.ok(chkExecJson.orderId);

    const submitRmaRes = await appHandler(
      new Request("http://localhost/api/demo/rma-submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: chkExecJson.orderId,
          tenderPriority: "GATEWAY_CASH_FIRST",
          reason: "Phase 8 Automated RMA Verification",
          linesToReturn: [{ lineId: "L-1", quantity: 2, condition: "RESELLABLE", restockingFeeBps: 0 }],
        }),
      })
    );
    assert.equal(submitRmaRes.status, 200);
    const submitRmaJson = (await submitRmaRes.json()) as {
      ok: boolean;
      orderPaymentStatusAfter: string;
    };
    assert.equal(submitRmaJson.ok, true);
    assert.equal(submitRmaJson.orderPaymentStatusAfter, "REFUNDED");

    // 6. Live Admin SSE Stream (/api/admin/events) + Ping (/api/admin/events/ping)
    const abortCtrl = new AbortController();
    const sseRes = await appHandler(
      new Request("http://localhost/api/admin/events", {
        signal: abortCtrl.signal,
      })
    );
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    const snapshotText = decoder.decode(firstChunk.value);
    assert.match(snapshotText, /event: snapshot/);

    const pingRes = await appHandler(
      new Request("http://localhost/api/admin/events/ping", { method: "POST" })
    );
    assert.equal(pingRes.status, 200);

    const secondChunk = await reader.read();
    assert.equal(secondChunk.done, false);
    const telemetryText = decoder.decode(secondChunk.value);
    assert.match(telemetryText, /event: telemetry/);
    assert.match(telemetryText, /Live SSE Operator Ping Verified/);
    abortCtrl.abort();
    await reader.cancel();

    // 7. Online YAML/JSON Configurator Dry-Run Preview, Deploy, and Pre-Flight Rejection
    const adminRes = await appHandler(new Request("http://localhost/admin"));
    assert.equal(adminRes.status, 200);
    const adminHtml = await adminRes.text();
    assert.match(adminHtml, /Live Server-Sent Events \(SSE\) Telemetry Stream/);
    const configuratorPage = await appHandler(new Request("http://localhost/admin/configurator"));
    assert.equal(configuratorPage.status, 200);
    assert.match(await configuratorPage.text(), /Interactive Online YAML \/ JSON Configurator Diff &amp; Deploy Editor/);
    const signIn = await appHandler(new Request("http://localhost/api/admin/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@kronos.io", password: "Kronos!Admin2026" }),
    }));
    assert.equal(signIn.status, 200);
    const adminCookie = signIn.headers.get("set-cookie")!.split(";")[0]!;

    const yamlUpdateRes = await appHandler(
      new Request("http://localhost/api/demo/configurator", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adminCookie },
        body: JSON.stringify({
          action: "preview_custom_text",
          rawText: [
            "warehouses:",
            "  - slug: us-east",
            "    name: US East Hub (NJ)",
            "    countryCode: US",
            "channels:",
            "  - slug: us-retail",
            "    name: US Flagship YAML Preview",
            "    currencyCode: USD",
            "    defaultCountry: US",
            "    warehouseSlugs: [us-east]",
            "productTypes: []",
            "products: []",
          ].join("\n"),
        }),
      })
    );
    assert.equal(yamlUpdateRes.status, 200);
    const yamlUpdateJson = (await yamlUpdateRes.json()) as {
      ok: boolean;
      format: string;
      plan: { totalChanges: number };
    };
    assert.equal(yamlUpdateJson.ok, true);
    assert.equal(yamlUpdateJson.format, "yaml");
    assert.equal(yamlUpdateJson.plan.totalChanges, 2);

    const badYamlRes = await appHandler(
      new Request("http://localhost/api/demo/configurator", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adminCookie },
        body: JSON.stringify({
          action: "deploy_custom_text",
          rawText: [
            "warehouses: []",
            "channels:",
            "  - slug: broken-channel",
            "    name: Broken Channel",
            "    currencyCode: USD",
            "    defaultCountry: US",
            "    warehouseSlugs: [ghost-warehouse]",
            "productTypes: []",
            "products: []",
          ].join("\n"),
        }),
      })
    );
    assert.equal(badYamlRes.status, 200);
    const badYamlJson = (await badYamlRes.json()) as { ok: boolean; issues: string[] };
    assert.equal(badYamlJson.ok, false);
    assert.equal(badYamlJson.issues.some((i) => i.includes("ghost-warehouse")), true);
  });
});

describe("Multi-route Merchant Backoffice", () => {
  const app = createAppRequestHandler();
  const credentials = {
    super: { email: "admin@kronos.io", password: "Kronos!Admin2026" },
    ops: { email: "ops@kronos.io", password: "Kronos!Ops2026" },
    audit: { email: "audit@kronos.io", password: "Kronos!Audit2026" },
  };
  async function post(path: string, body: unknown, cookie?: string) {
    return app(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }));
  }
  async function login(role: keyof typeof credentials) {
    const res = await post("/api/admin/login", credentials[role]);
    assert.equal(res.status, 200);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }
  async function createProduct(slug: string, cookie: string, quantity = 5) {
    const sku = slug.toUpperCase();
    const res = await post("/api/admin/catalog/product-create", {
      productName: `Test ${slug}`, productSlug: slug, sku, priceAmountCents: "10000", initialOnHandQty: quantity,
    }, cookie);
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as { productId: string; variantId: string; sku: string; pgSynced: boolean };
  }
  type Projection = { productSlug: string; minEffectivePrice: string; totalAvailableQty: number; mergedAttributes: Record<string, unknown>; variantsSnapshot: { sku: string; effectivePrice: string }[] };
  async function search(channelSlug = "us-retail", inStockOnly = false) {
    const res = await post("/rpc/catalog.search", { channelSlug, inStockOnly });
    assert.equal(res.status, 200);
    return (await res.json() as { data: Projection[] }).data;
  }

  it("serves all ten routes, preserves deep links, and never auto-logs-in guests", async () => {
    const guest = await app(new Request("http://localhost/admin"));
    assert.equal(guest.status, 200);
    assert.equal(guest.headers.get("set-cookie"), null);
    assert.match(await guest.text(), /guest@anonymous/);
    const cookie = await login("super");
    const cases = [
      ["/admin", /Merchant Operations Overview/],
      ["/admin/orders", /Committed Orders Ledger/],
      ["/admin/orders/ord_chk-100", /Two-Pass Hare-Niemeyer Price Waterfall/],
      ["/admin/catalog", /Product &amp; Variant SKU Matrix/],
      ["/admin/discounts", /Active Vouchers &amp; Promotion Registry/],
      ["/admin/inventory", /MSI 3-Tier Inventory Matrix/],
      ["/admin/b2b", /B2B Enterprise Organizations/],
      ["/admin/configurator", /Sales Channel Settings/],
      ["/admin/settings", /RBAC Permission Gate/],
      ["/admin/lab", /Engineering, Chaos &amp; Benchmark Lab/],
    ] as const;
    for (const [path, expected] of cases) {
      const res = await app(new Request(`http://localhost${path}`, { headers: { cookie } }));
      assert.equal(res.status, 200, `${path}: ${res.status === 200 ? "OK" : await res.clone().text()}`);
      const html = await res.text();
      assert.match(html, expected, path);
      assert.match(html, /aria-current="page"/, path);
      assert.doesNotMatch(html, /[–—]/, path);
      if (path === "/admin/b2b") {
        assert.match(html, /Elena Vance \(Procurement Buyer\)/);
        assert.match(html, /CAN_APPROVE_PO/);
        assert.doesNotMatch(html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "", /NaN|undefined/);
      }
    }
    for (const path of ["/admin/unknown", "/admin/orders/missing-order"]) {
      const res = await app(new Request(`http://localhost${path}`));
      assert.equal(res.status, 404);
    }
    for (const cookie of [undefined, await login("ops"), await login("audit")]) {
      const res = await app(new Request("http://localhost/admin/lab", { headers: cookie ? { cookie } : {} }));
      assert.equal(res.status, 403);
      const html = await res.text();
      assert.match(html, /403 FORBIDDEN/);
      assert.doesNotMatch(html, /id="btn-pg-stress"/);
    }
    const loginPage = await app(new Request("http://localhost/admin/login?next=%2Fadmin%2Finventory"));
    assert.match(await loginPage.text(), /const NEXT_TARGET = "\/admin\/inventory"/);
  });

  it("enforces 401 and 403 for every merchant write and protects lab APIs", async () => {
    const auditor = await login("audit");
    for (const path of [
      "/api/admin/catalog/product-create", "/api/admin/catalog/save", "/api/admin/discounts/upsert",
      "/api/admin/discounts/toggle", "/api/admin/inventory/adjust", "/api/admin/channels/update",
      "/api/admin/orders/ord_chk-100/rma",
      "/api/demo/benchmark", "/api/demo/pg-stress", "/api/demo/wasm-sandbox", "/api/demo/gateway-stress", "/api/demo/configurator",
    ]) {
      assert.equal((await post(path, {})).status, 401, path);
      const forbidden = await post(path, {}, auditor);
      assert.equal(forbidden.status, 403, path);
      assert.equal((await forbidden.json() as { ok: boolean }).ok, false);
    }
    assert.equal((await post("/api/admin/channels/update", {}, await login("ops"))).status, 403);
    assert.equal((await post("/api/demo/checkout", { scenario: "step5_commit_fault_lifo" })).status, 401);
    const malformed = await app(new Request("http://localhost/api/admin/catalog/save", { method: "POST", headers: { "content-type": "application/json", cookie: await login("ops") }, body: "{" }));
    assert.equal(malformed.status, 400);
  });

  it("propagates channel prices, facets, and publication to PDP, PostgreSQL facets, RPC, GraphQL, and hybrid search", async () => {
    const cookie = await login("ops");
    const product = await createProduct("admin-catalog-probe", cookie);
    const save = { ...product, channelSlug: "us-retail", priceAmountCents: "12000", isPublished: true, chassis: "brushed-magnesium" };
    assert.equal((await post("/api/admin/catalog/save", save, cookie)).status, 200);
    const us = (await search()).find((p) => p.productSlug === "admin-catalog-probe")!;
    const eu = (await search("eu-flagship")).find((p) => p.productSlug === "admin-catalog-probe")!;
    assert.equal(us.minEffectivePrice, "10800");
    assert.equal(eu.minEffectivePrice, "9000");
    const euCatalog = await app(new Request("http://localhost/admin/catalog?channel=eu-flagship", { headers: { cookie } }));
    const euHtml = await euCatalog.text();
    assert.match(euHtml, /€100\.00/);
    assert.match(euHtml, /<option value="eu-flagship" selected>/);
    assert.deepEqual(us.mergedAttributes["chassis"], ["brushed-magnesium"]);
    const pdp = await app(new Request("http://localhost/products/admin-catalog-probe"));
    assert.equal(pdp.status, 200);
    assert.match(await pdp.text(), /\$108\.00/);
    const hybrid = await post("/rpc/catalog.hybridSearch", { channelSlug: "us-retail", queryText: "admin-catalog-probe", inStockOnly: true, limit: 50 });
    assert.ok((await hybrid.json() as { data: { hits: { projection: Projection }[] } }).data.hits.some((h) => h.projection.productSlug === "admin-catalog-probe"));
    const facets = await post("/api/demo/facet-search", { channelSlug: "us-retail", searchQuery: "admin-catalog-probe", selectedFacets: { chassis: ["brushed-magnesium"] } });
    assert.equal((await facets.json() as { items: unknown[] }).items.length, 1);
    const recalc = await post("/api/demo/recalculate", { channelSlug: "us-retail", customLines: [{ variantId: product.sku, quantity: 1, baseUnitPrice: 1 }] });
    assert.equal((await recalc.json() as { lines: { baseUnitPrice: string }[] }).lines[0]!.baseUnitPrice, "10800");

    assert.equal((await post("/api/admin/catalog/save", { ...save, isPublished: false }, cookie)).status, 200);
    assert.equal((await search()).some((p) => p.productSlug === "admin-catalog-probe"), false);
    assert.equal((await app(new Request("http://localhost/products/admin-catalog-probe"))).status, 404);
    const gql = await post("/graphql", { query: 'query { products(channel: "us-retail") { edges { node { slug } } } }' });
    assert.equal((await gql.json() as { data: { products: { edges: { node: { slug: string } }[] } } }).data.products.edges.some((e) => e.node.slug === "admin-catalog-probe"), false);
    const hiddenFacets = await post("/api/demo/facet-search", { channelSlug: "us-retail", searchQuery: "admin-catalog-probe" });
    assert.equal((await hiddenFacets.json() as { items: unknown[] }).items.length, 0);
    assert.equal((await post("/api/demo/checkout", { customLines: [{ variantId: product.sku, quantity: 1, baseUnitPrice: 1 }] })).status, 400);
    assert.equal((await search("eu-flagship")).some((p) => p.productSlug === "admin-catalog-probe"), true);
    assert.equal((await post("/api/admin/catalog/save", save, cookie)).status, 200);
    assert.equal((await app(new Request("http://localhost/products/admin-catalog-probe"))).status, 200);
    assert.equal((await post("/api/admin/catalog/product-create", { productName: "Duplicate", productSlug: "admin-catalog-probe", sku: "DUP", priceAmountCents: 1, initialOnHandQty: 0 }, cookie)).status, 409);
    assert.equal((await post("/api/admin/catalog/save", { ...save, priceAmountCents: "NaN" }, cookie)).status, 400);
  });

  it("applies edited vouchers, respects pause and manual precedence, and counts committed redemptions", async () => {
    const cookie = await login("ops");
    const product = await createProduct("admin-voucher-probe", cookie);
    const voucher = { code: "BACKOFFICE25", name: "Backoffice twenty-five", valueType: "FIXED", valueRaw: 2500 };
    assert.equal((await post("/api/admin/discounts/upsert", voucher, cookie)).status, 200);
    const cart = { channelSlug: "us-retail", includePromo: true, includeVoucher: true, voucherCode: voucher.code, storeCreditToRedeemCents: 0, customLines: [{ variantId: product.sku, quantity: 1, baseUnitPrice: 1 }] };
    const recalc = await post("/api/demo/recalculate", cart);
    assert.match((await recalc.json() as { winningDiscountLabel: string }).winningDiscountLabel, /Backoffice twenty-five/);
    assert.equal((await post("/api/admin/discounts/toggle", { code: voucher.code }, cookie)).status, 200);
    const paused = await post("/api/demo/recalculate", cart);
    assert.match((await paused.json() as { winningDiscountLabel: string }).winningDiscountLabel, /10% Order Promo/);
    assert.equal((await post("/api/admin/discounts/toggle", { code: voucher.code }, cookie)).status, 200);
    const manual = await post("/api/demo/recalculate", { ...cart, includeManual: true });
    assert.match((await manual.json() as { winningDiscountLabel: string }).winningDiscountLabel, /Manual Agent Discount/);
    const checkout = await post("/api/demo/checkout", cart);
    assert.equal(checkout.status, 200, await checkout.clone().text());
    const updated = await post("/api/admin/discounts/upsert", { ...voucher, valueRaw: 2000 }, cookie);
    assert.equal((await updated.json() as { voucher: { usageCount: number } }).voucher.usageCount, 1);
    assert.equal((await post("/api/admin/discounts/upsert", { ...voucher, valueType: "PERCENTAGE", valueRaw: 10001 }, cookie)).status, 400);
  });

  it("uses channel stock mode through reads and checkout without replenishing inventory", async () => {
    const ops = await login("ops");
    const admin = await login("super");
    const product = await createProduct("admin-stock-probe", ops, 2);
    const stock = { warehouseId: "US-EAST", variantId: product.sku, quantityOnHand: 2, linkedToChannel: true, supportsShippingZone: false };
    const channel = { slug: "us-retail", stockAvailabilityMode: "SHIPPING_ZONE_INTERSECTION", taxInclusionMode: "TAX_EXCLUSIVE", reservationTtlSeconds: 600 };
    assert.equal((await post("/api/admin/inventory/adjust", stock, ops)).status, 200);
    assert.equal((await search()).find((p) => p.productSlug === "admin-stock-probe")!.totalAvailableQty, 2);
    const cart = { channelSlug: "us-retail", includePromo: false, includeVoucher: false, storeCreditToRedeemCents: 0, customLines: [{ variantId: product.sku, quantity: 1, baseUnitPrice: 1 }] };
    try {
      assert.equal((await post("/api/admin/channels/update", channel, admin)).status, 200);
      assert.equal((await search()).find((p) => p.productSlug === "admin-stock-probe")!.totalAvailableQty, 0);
      assert.equal((await search("us-retail", true)).some((p) => p.productSlug === "admin-stock-probe"), false);
      const deniedCheckout = await post("/api/demo/checkout", cart);
      assert.equal(deniedCheckout.status, 409);
      assert.doesNotMatch((await deniedCheckout.json() as { summary: string }).summary, /SAGA COMPLETED/);
      const directChannel = { ...channel, stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES" };
      assert.equal((await post("/api/admin/channels/update", directChannel, admin)).status, 200);
      const exclusive = await post("/api/demo/recalculate", cart);
      assert.equal((await exclusive.json() as { lines: { totalGrossFormatted: string }[] }).lines[0]!.totalGrossFormatted, "$97.43");
      const inclusiveUpdate = await post("/api/admin/channels/update", { ...directChannel, taxInclusionMode: "TAX_INCLUSIVE" }, admin);
      assert.equal(inclusiveUpdate.status, 200);
      assert.equal((await inclusiveUpdate.json() as { channel: { reservationTtlSeconds: number } }).channel.reservationTtlSeconds, 600);
      const inclusive = await post("/api/demo/recalculate", cart);
      assert.equal((await inclusive.json() as { lines: { totalGrossFormatted: string }[] }).lines[0]!.totalGrossFormatted, "$90.00");
      assert.equal((await post("/api/admin/channels/update", directChannel, admin)).status, 200);
      assert.equal((await post("/api/demo/checkout", cart)).status, 200);
      const adjust = await post("/api/admin/inventory/adjust", { ...stock, quantityOnHand: 1 }, ops);
      assert.equal(adjust.status, 200);
      assert.equal((await adjust.json() as { slot: { quantityAllocated: number } }).slot.quantityAllocated, 1);
      assert.equal((await post("/api/admin/inventory/adjust", { ...stock, quantityOnHand: 0 }, ops)).status, 400);
      assert.equal((await post("/api/demo/checkout", cart)).status, 409);
      const pdp = await app(new Request("http://localhost/products/admin-stock-probe"));
      assert.match(await pdp.text(), /Out of Stock/);
      assert.equal((await post("/api/demo/checkout", { ...cart, customLines: [{ variantId: "UNKNOWN-SKU", quantity: 1, baseUnitPrice: 1 }] })).status, 400);
    } finally {
      await post("/api/admin/channels/update", { ...channel, stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES", reservationTtlSeconds: 900 }, admin);
    }
  });

  it("executes Admin RMA against real orders and updates Storefront status and inventory", async () => {
    const cookie = await login("ops");
    const product = await createProduct("admin-rma-probe", cookie, 3);
    const checkout = await post("/api/demo/checkout", { includePromo: false, includeVoucher: false, storeCreditToRedeemCents: 0, customLines: [{ variantId: product.sku, quantity: 2, baseUnitPrice: 1 }] });
    assert.equal(checkout.status, 200);
    const { orderId } = await checkout.json() as { orderId: string };
    const rma = { lineId: "L-1", quantity: 1, condition: "RESELLABLE", restockingFeeBps: 0 };
    const returned = await post(`/api/admin/orders/${orderId}/rma`, rma, cookie);
    assert.equal(returned.status, 200, await returned.clone().text());
    assert.equal((await returned.json() as { orderPaymentStatusAfter: string }).orderPaymentStatusAfter, "PARTIALLY_REFUNDED");
    const storefrontOrder = await app(new Request(`http://localhost/orders/${orderId}`));
    assert.match(await storefrontOrder.text(), /PARTIALLY_REFUNDED/);
    assert.equal((await search()).find((p) => p.productSlug === "admin-rma-probe")!.totalAvailableQty, 2);
    const finalReturn = await post(`/api/admin/orders/${orderId}/rma`, rma, cookie);
    assert.equal((await finalReturn.json() as { orderPaymentStatusAfter: string }).orderPaymentStatusAfter, "REFUNDED");
    assert.equal((await post(`/api/admin/orders/${orderId}/rma`, rma, cookie)).status, 400);
    assert.equal((await post(`/api/admin/orders/${orderId}/rma`, { ...rma, lineId: "OTHER-LINE" }, cookie)).status, 400);
    assert.equal((await post("/api/admin/orders/missing/rma", rma, cookie)).status, 404);
  });

  it("paginates orders via SQL keyset pagination endpoint and rejects invalid cursors", async () => {
    const res = await app(new Request("http://localhost/api/admin/orders?limit=1"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      items: { order: { orderId: string } }[];
      limit: number;
      totalMatchingCount: number;
      hasMore: boolean;
      hasPrev: boolean;
      nextCursor: string | null;
      prevCursor: string | null;
    };
    assert.equal(body.ok, true);
    assert.equal(body.limit, 1);
    assert.ok(body.totalMatchingCount >= 1);
    assert.ok(body.items.length >= 1);

    const badCursorRes = await app(
      new Request("http://localhost/api/admin/orders?cursor=not-a-valid-cursor!!")
    );
    assert.equal(badCursorRes.status, 400);
    const badJson = (await badCursorRes.json()) as { ok: boolean; error: string };
    assert.equal(badJson.ok, false);
    assert.match(badJson.error, /cursor/i);

    const ssrAdminRes = await app(new Request("http://localhost/admin/orders?limit=1"));
    assert.equal(ssrAdminRes.status, 200);
    const ssrAdminHtml = await ssrAdminRes.text();
    assert.match(ssrAdminHtml, /Committed Orders Ledger/);
    assert.equal(ssrAdminHtml.includes("—"), false);
    assert.equal(ssrAdminHtml.includes("–"), false);

    const ssrStorefrontRes = await app(new Request("http://localhost/orders?limit=1"));
    assert.equal(ssrStorefrontRes.status, 200);
    const ssrStorefrontHtml = await ssrStorefrontRes.text();
    assert.match(ssrStorefrontHtml, /Committed Orders &amp; Self-Service RMA Portal/);
    assert.equal(ssrStorefrontHtml.includes("—"), false);
    assert.equal(ssrStorefrontHtml.includes("–"), false);
  });

  it("persists orders, stock allocations, and outbox events in PostgreSQL across handler restarts", async () => {
    const sharedPool = new OfflinePgPool();
    await runMigrations(sharedPool);

    const app1 = createAppRequestHandler({ pgPool: sharedPool });
    const opsLogin = await app1(
      new Request("http://localhost/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(credentials.ops),
      })
    );
    assert.equal(opsLogin.status, 200);
    const cookie = opsLogin.headers.get("set-cookie")!.split(";")[0]!;

    const checkoutRes = await app1(
      new Request("http://localhost/api/demo/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          channelSlug: "us-retail",
          includePromo: false,
          includeVoucher: false,
          storeCreditToRedeemCents: 0,
        }),
      })
    );
    assert.equal(checkoutRes.status, 200, await checkoutRes.clone().text());
    const { orderId } = (await checkoutRes.json()) as { orderId: string };
    assert.ok(orderId);

    // Create a new handler instance with the exact same pgPool (simulating restart)
    const app2 = createAppRequestHandler({ pgPool: sharedPool });

    const orderQuery = await app2(
      new Request(`http://localhost/api/admin/orders?q=${encodeURIComponent(orderId)}`)
    );
    assert.equal(orderQuery.status, 200);
    const orderData = (await orderQuery.json()) as {
      items: { order: { orderId: string } }[];
      totalMatchingCount: number;
    };
    assert.equal(orderData.totalMatchingCount, 1);
    assert.equal(orderData.items[0]?.order.orderId, orderId);

    const storefrontDetail = await app2(
      new Request(`http://localhost/orders/${encodeURIComponent(orderId)}`)
    );
    assert.equal(storefrontDetail.status, 200);
    const storefrontDetailHtml = await storefrontDetail.text();
    assert.match(storefrontDetailHtml, new RegExp(orderId));
    assert.match(storefrontDetailHtml, /Self-Service RMA Return Estimator/);

    const adminDetail = await app2(
      new Request(`http://localhost/admin/orders/${encodeURIComponent(orderId)}`, {
        headers: { cookie },
      })
    );
    assert.equal(adminDetail.status, 200);
    const adminDetailHtml = await adminDetail.text();
    assert.match(adminDetailHtml, new RegExp(orderId));
    assert.match(adminDetailHtml, /Two-Pass Hare-Niemeyer Price Waterfall/);
  });

  it("manages PostgreSQL customers ledger, dynamic RBAC roles, order cancellations, and fulfillment dispatch", async () => {
    const sharedPool = new OfflinePgPool();
    await runMigrations(sharedPool);
    const testApp = createAppRequestHandler({ pgPool: sharedPool });

    // 1. Authenticate as SUPER_ADMIN
    const loginRes = await testApp(
      new Request("http://localhost/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(credentials.super),
      })
    );
    assert.equal(loginRes.status, 200);
    const superCookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

    // 2. Dynamic RBAC role creation in PostgreSQL
    const createRoleRes = await testApp(
      new Request("http://localhost/api/admin/rbac/roles", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: superCookie },
        body: JSON.stringify({
          roleSlug: "SECURITY_OPERATOR",
          displayName: "Security Operator",
          permissions: ["cockpit:read", "mcp:diagnose", "finance:audit_webhooks"],
        }),
      })
    );
    assert.equal(createRoleRes.status, 200);
    const roleJson = (await createRoleRes.json()) as { ok: boolean; role: { roleSlug: string; permissions: string[] } };
    assert.equal(roleJson.ok, true);
    assert.equal(roleJson.role.roleSlug, "SECURITY_OPERATOR");
    assert.deepEqual(roleJson.role.permissions, ["cockpit:read", "mcp:diagnose", "finance:audit_webhooks"]);

    // Verify GET /api/admin/rbac/roles returns the new role
    const getRolesRes = await testApp(new Request("http://localhost/api/admin/rbac/roles"));
    assert.equal(getRolesRes.status, 200);
    const getRolesJson = (await getRolesRes.json()) as { ok: boolean; roles: { roleSlug: string }[] };
    assert.ok(getRolesJson.roles.some((r) => r.roleSlug === "SECURITY_OPERATOR"));

    // 3. Customer creation in PostgreSQL
    const createCustRes = await testApp(
      new Request("http://localhost/api/admin/customers", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: superCookie },
        body: JSON.stringify({
          fullName: "Grace Hopper",
          email: "grace@kronos.io",
          initialCreditCents: 5000,
        }),
      })
    );
    assert.equal(createCustRes.status, 200);
    const custJson = (await createCustRes.json()) as {
      ok: boolean;
      customer: { customerId: string; email: string; storeCreditBalance: string };
    };
    assert.equal(custJson.ok, true);
    assert.equal(custJson.customer.email, "grace@kronos.io");
    assert.equal(custJson.customer.storeCreditBalance, "5000");

    // 4. Quick add store credit
    const addCreditRes = await testApp(
      new Request(`http://localhost/api/admin/customers/${encodeURIComponent(custJson.customer.customerId)}/credit`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: superCookie },
        body: JSON.stringify({
          deltaCents: 2500,
          reason: "INTEGRATION_TEST_BONUS",
        }),
      })
    );
    assert.equal(addCreditRes.status, 200);
    const creditJson = (await addCreditRes.json()) as {
      ok: boolean;
      entry: { balanceAfter: string; deltaAmount: string };
      customer: { storeCreditBalance: string };
    };
    assert.equal(creditJson.ok, true);
    assert.equal(creditJson.entry.balanceAfter, "7500");
    assert.equal(creditJson.customer.storeCreditBalance, "7500");

    // Verify GET /api/admin/customers
    const listCustRes = await testApp(new Request("http://localhost/api/admin/customers?limit=10"));
    assert.equal(listCustRes.status, 200);
    const listCustJson = (await listCustRes.json()) as {
      ok: boolean;
      customers: { customerId: string; email: string }[];
    };
    assert.ok(listCustJson.customers.some((c) => c.email === "grace@kronos.io"));

    // 5. Test pre-fulfillment order cancellation
    // Checkout an order first
    const checkoutRes = await testApp(
      new Request("http://localhost/api/demo/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: superCookie },
        body: JSON.stringify({
          channelSlug: "us-retail",
          includePromo: false,
          includeVoucher: false,
          storeCreditToRedeemCents: 0,
        }),
      })
    );
    assert.equal(checkoutRes.status, 200);
    const { orderId } = (await checkoutRes.json()) as { orderId: string };

    // Cancel the order
    const cancelRes = await testApp(
      new Request(`http://localhost/api/admin/orders/${encodeURIComponent(orderId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: superCookie },
        body: JSON.stringify({
          reason: "Customer changed mind prior to warehouse dispatch",
        }),
      })
    );
    assert.equal(cancelRes.status, 200);
    const cancelJson = (await cancelRes.json()) as {
      ok: boolean;
      fulfillmentStatus: string;
      paymentStatus: string;
    };
    assert.equal(cancelJson.ok, true);
    assert.equal(cancelJson.fulfillmentStatus, "CANCELLED");
    assert.equal(cancelJson.paymentStatus, "VOIDED");

    // Verify Settings & RBAC HTML renders the newly created customer and role with zero em/en-dashes
    const settingsHtmlRes = await testApp(
      new Request("http://localhost/admin/settings", {
        headers: { cookie: superCookie },
      })
    );
    assert.equal(settingsHtmlRes.status, 200);
    const settingsHtml = await settingsHtmlRes.text();
    assert.match(settingsHtml, /SECURITY_OPERATOR/);
    assert.match(settingsHtml, /Grace Hopper/);
    assert.match(settingsHtml, /grace@kronos\.io/);
    assert.equal(settingsHtml.includes("—"), false);
    assert.equal(settingsHtml.includes("–"), false);
  });

  it("exposes GET /healthz with database mode probe for container readiness checks", async () => {
    const testApp = createAppRequestHandler({ pgPool: new OfflinePgPool() });
    const res = await testApp(new Request("http://localhost/healthz"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      database: string;
      pgVersion: string | null;
      timestamp: string;
    };
    assert.equal(body.status, "ok");
    assert.equal(body.database, "offline");
    assert.equal(body.pgVersion, null);
    assert.ok(Date.parse(body.timestamp) > 0);
  });

  it("serves OpenAPI 3.1, Streamable HTTP MCP (/mcp), SKU analytics, Trial Balance, and decoupled prod-server + worker", async () => {
    const pg = new OfflinePgPool();
    const prod = await startProductionApiServer({ port: 0, host: "127.0.0.1", pgPool: pg });
    try {
      const addr = prod.server.address();
      assert.ok(addr && typeof addr === "object");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // 1. OpenAPI 3.1 specification
      const openApiRes = await fetch(`${baseUrl}/openapi.json`);
      assert.equal(openApiRes.status, 200);
      const spec = (await openApiRes.json()) as { openapi: string; paths: Record<string, unknown> };
      assert.equal(spec.openapi, "3.1.0");
      assert.ok(spec.paths["/mcp"]);
      assert.ok(spec.paths["/rpc/ledger.getTrialBalance"]);

      // 2. Streamable HTTP MCP JSON-RPC 2.0
      const mcpInitRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 101, method: "initialize" }),
      });
      assert.equal(mcpInitRes.status, 200);
      const mcpInit = (await mcpInitRes.json()) as { result: { serverInfo: { name: string } } };
      assert.equal(mcpInit.result.serverInfo.name, "super-ecommerce-mcp");

      // Seed stock & complete a checkout over HTTP /rpc/checkout.complete
      await prod.gateway.inventoryService.upsertExternalSlots([
        {
          warehouseId: "WH-PROD-1",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "SKU-PROD-DAC",
          quantityOnHand: 5,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]);

      const chkRes = await fetch(`${baseUrl}/rpc/checkout.complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "prod-http-chk-1",
          input: {
            checkoutId: "chk-prod-1",
            channelSlug: "us-retail",
            stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
            allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
            paymentToken: "tok_prod_1",
            cart: {
              currencyCode: "USD",
              taxMode: "TAX_EXCLUSIVE",
              shippingBaseAmount: 500,
              shippingTaxRateBps: 0,
              lines: [
                {
                  lineId: "L-DAC",
                  variantId: "SKU-PROD-DAC",
                  quantity: 1,
                  baseUnitPrice: 25000,
                  taxRateBps: 1000,
                },
              ],
            },
          },
        }),
      });
      assert.equal(chkRes.status, 200);

      // Verify normalized SKU analytics & Double-Entry Trial Balance over HTTP RPC
      const skuRes = await fetch(`${baseUrl}/rpc/orders.analyticsBySku`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelSlug: "us-retail" }),
      });
      const skuBody = (await skuRes.json()) as { ok: boolean; data: { variantId: string; totalGrossAmount: string }[] };
      assert.equal(skuBody.ok, true);
      assert.equal(skuBody.data[0]?.variantId, "SKU-PROD-DAC");
      assert.equal(skuBody.data[0]?.totalGrossAmount, "27500");

      const tbRes = await fetch(`${baseUrl}/rpc/ledger.getTrialBalance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currencyCode: "USD" }),
      });
      const tbBody = (await tbRes.json()) as {
        ok: boolean;
        data: { isBalanced: boolean; grandTotalDebits: string; grandTotalCredits: string };
      };
      assert.equal(tbBody.ok, true);
      assert.equal(tbBody.data.isBalanced, true);
      assert.equal(tbBody.data.grandTotalDebits, "28000");
      assert.equal(tbBody.data.grandTotalCredits, "28000");

      // Run decoupled background worker daemon single cycle to drain the pending order.created outbox event
      const deliveredEvents: string[] = [];
      const workerDaemon = createBackgroundMaintenanceDaemon({
        pgPool: pg,
        outboxSubscribers: [
          {
            name: "erp-sync",
            eventPattern: "order.*",
            handle: (env) => {
              deliveredEvents.push(env.event.eventType);
            },
          },
        ],
      });
      const cycle = await workerDaemon.runSingleCycle();
      assert.equal(cycle.outbox.publishedCount, 1);
      assert.deepEqual(deliveredEvents, ["order.created"]);
      await workerDaemon.stop(false);
    } finally {
      await prod.close();
    }
  });
});
