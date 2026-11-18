import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createServer as createViteServer } from "vite";
import { OfflinePgPool } from "@super-ecommerce/db";
import { createSuperCommerceGateway } from "../../api/src/index.ts";
import {
  currencyExponent,
  formatMinorUnits,
  parseDecimalToMinorUnits,
} from "./lib/money.ts";
import { createAdminRpcClient } from "./api/rpc-client.ts";

const SPA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("@super-ecommerce/admin-spa (React 19 + TanStack Backoffice)", () => {
  it("formats and parses ISO-4217 0/2/3/4-decimal currencies with zero floating-point math", () => {
    assert.equal(currencyExponent("JPY"), 0);
    assert.equal(currencyExponent("USD"), 2);
    assert.equal(currencyExponent("KWD"), 3);
    assert.equal(currencyExponent("CLF"), 4);

    assert.equal(formatMinorUnits("28000", "USD"), "USD 280.00");
    assert.equal(formatMinorUnits("-16500", "USD"), "-USD 165.00");
    assert.equal(formatMinorUnits("15800", "JPY"), "JPY 15800");
    assert.equal(formatMinorUnits("12345", "KWD"), "KWD 12.345");

    assert.equal(parseDecimalToMinorUnits("25.50", "USD"), 2_550n);
    assert.equal(parseDecimalToMinorUnits("1500", "JPY"), 1_500n);
    assert.equal(parseDecimalToMinorUnits("9.875", "KWD"), 9_875n);
    assert.throws(() => parseDecimalToMinorUnits("12.5", "JPY"));
  });

  it("executes typed AdminRpcClient against gateway (/rpc/*, /mcp, /healthz) and serves /admin-spa bundle safely", async () => {
    const pg = new OfflinePgPool();
    const gw = createSuperCommerceGateway({ pgPool: pg });
    await gw.ready();

    await gw.inventoryService.upsertExternalSlots([
      {
        warehouseId: "WH-SPA-1",
        priorityRank: 1,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "SKU-SPA-KB",
        quantityOnHand: 20,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
      {
        warehouseId: "WH-SPA-1",
        priorityRank: 1,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "SKU-SPA-CAP",
        quantityOnHand: 15,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
    ]);

    // Seed a checkout via gateway so Orders, SKU Analytics, and Trial Balance have live data
    await gw.rpcClient.checkout.complete({
      idempotencyKey: "spa-seed-chk-1",
      input: {
        checkoutId: "chk_spa_1",
        channelSlug: "us-retail",
        stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        paymentToken: "pm_card_visa",
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 1_000n,
          shippingTaxRateBps: 0,
          lines: [
            {
              lineId: "L-KB",
              variantId: "SKU-SPA-KB",
              quantity: 1,
              baseUnitPrice: 20_000n,
              taxRateBps: 1000,
            },
          ],
        },
      },
    });

    const rpc = createAdminRpcClient({
      baseUrl: "http://localhost",
      fetchImpl: (input, init) => gw.fetch(new Request(String(input), init)),
    });

    const health = await rpc.getHealth();
    assert.equal(health.status, "ok");
    assert.equal(health.version, "0.4.0");

    const tbBefore = await rpc.ledger.getTrialBalance("USD");
    assert.equal(tbBefore.isBalanced, true);
    assert.equal(tbBefore.grandTotalDebits, "23000");

    const page = await rpc.orders.list({ limit: 10 });
    assert.equal(page.items.length, 1);
    const orderId = page.items[0]!.orderId;

    // Perform OMS Order Edit through AdminRpcClient
    const editRes = await rpc.orders.edit({
      idempotencyKey: "spa-rpc-edit-1",
      input: {
        editId: "oe_spa_1",
        orderId,
        editedBy: "admin-spa@kronos.io",
        reason: "Add keycap set via Admin SPA",
        paymentTokenForIncrementalCapture: "pm_card_visa_inc",
        lineMutations: [
          {
            lineId: "L-CAP",
            variantId: "SKU-SPA-CAP",
            quantity: 1,
            baseUnitPrice: "4000",
            taxRateBps: 1000,
          },
        ],
      },
    });
    assert.equal(editRes.status, "COMPLETED");
    assert.equal(editRes.output?.deltaGrossAmount, "4400");

    const tbAfter = await rpc.ledger.getTrialBalance("USD");
    assert.equal(tbAfter.isBalanced, true);
    assert.equal(tbAfter.grandTotalDebits, "27400");

    const tools = await rpc.mcp.listToolsJsonRpc();
    assert.ok(tools.some((t) => t.name === "diagnose_price_waterfall"));

    // Verify compiled dist assets & gateway static mounting at /admin-spa
    const distDir = resolve(SPA_ROOT, "dist");
    assert.equal(existsSync(distDir), true, "Expected apps/admin-spa/dist to be built");

    const rootHtmlRes = await gw.fetch(new Request("http://localhost/admin-spa"));
    assert.equal(rootHtmlRes.status, 200);
    const rootHtml = await rootHtmlRes.text();
    assert.match(rootHtml, /<meta name="color-scheme" content="light dark"/);
    assert.match(rootHtml, /\/admin-spa\/assets\//);

    // Client-side TanStack Router deep link (/admin-spa/orders) falls back to index.html
    const deepLinkRes = await gw.fetch(new Request("http://localhost/admin-spa/orders"));
    assert.equal(deepLinkRes.status, 200);
    assert.match(await deepLinkRes.text(), /<div id="root"><\/div>/);

    // Hashed asset serves with immutable Cache-Control
    const assetsFiles = readdirSync(resolve(distDir, "assets"));
    const jsAsset = assetsFiles.find((f) => f.endsWith(".js"));
    const cssAsset = assetsFiles.find((f) => f.endsWith(".css"));
    assert.ok(jsAsset && cssAsset);

    const jsRes = await gw.fetch(new Request(`http://localhost/admin-spa/assets/${jsAsset}`));
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get("cache-control") ?? "", /immutable/);

    const cssContent = readFileSync(resolve(distDir, "assets", cssAsset), "utf8");
    assert.match(cssContent, /light-dark\(/);
    assert.match(cssContent, /@container/);
    assert.match(cssContent, /:user-invalid/);
  });

  it("renders React 19 + TanStack Table/Query modular views with accessible semantic HTML", async () => {
    const vite = await createViteServer({
      root: SPA_ROOT,
      logLevel: "silent",
      server: { middlewareMode: true },
      appType: "custom",
    });

    try {
      const { OverviewPage } = await vite.ssrLoadModule("/src/routes/OverviewPage.tsx");
      const { OrdersOmsPage } = await vite.ssrLoadModule("/src/routes/OrdersOmsPage.tsx");
      const { McpCopilotPage } = await vite.ssrLoadModule("/src/routes/McpCopilotPage.tsx");

      const queryClient = new QueryClient();
      queryClient.setQueryData(["ledger", "trialBalance", "USD"], {
        currencyCode: "USD",
        isBalanced: true,
        grandTotalDebits: "27400",
        grandTotalCredits: "27400",
        accounts: [
          {
            accountCode: "CASH_CLEARING",
            normalBalance: "DEBIT",
            debitTotal: "27400",
            creditTotal: "0",
            netBalance: "27400",
          },
        ],
      });
      queryClient.setQueryData(["orders", "list", "", undefined], {
        items: [
          {
            orderId: "ord_chk_spa_1",
            checkoutId: "chk_spa_1",
            channelSlug: "us-retail",
            currencyCode: "USD",
            paymentStatus: "CAPTURED",
            fulfillmentStatus: "UNFULFILLED",
            totalGrossAmount: "27400",
            createdAt: "2026-11-18T10:00:00.000Z",
          },
        ],
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
      });

      const dummyRpc = createAdminRpcClient({
        fetchImpl: async () => new Response(JSON.stringify({ ok: true, data: [] })),
      });

      const overviewHtml = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(OverviewPage, { rpc: dummyRpc })
        )
      );
      assert.match(overviewHtml, /Operations &amp; Double-Entry Subledger/);
      assert.match(overviewHtml, /CASH_CLEARING/);
      assert.match(overviewHtml, /USD 274\.00/);
      assert.match(overviewHtml, /role="region"/);

      const ordersHtml = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(OrdersOmsPage, { rpc: dummyRpc })
        )
      );
      assert.match(ordersHtml, /Orders &amp; Pre-Fulfillment OMS Studio/);
      assert.match(ordersHtml, /ord_chk_spa_1/);
      assert.match(ordersHtml, /class="sort-btn"/);
      assert.match(ordersHtml, /closedby="any"/);

      const mcpHtml = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(McpCopilotPage, { rpc: dummyRpc })
        )
      );
      assert.match(mcpHtml, /Model Context Protocol \(MCP\) Copilot Inspector/);
    } finally {
      await vite.close();
    }
  });
});
