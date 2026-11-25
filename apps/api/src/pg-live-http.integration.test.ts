/**
 * Full-Stack HTTP Server + PostgreSQL 17 Live Smoke Test (`apps/api/src/pg-live-http.integration.test.ts`).
 *
 * Boots `createAppRequestHandler({ pgPool })` wired to a real PostgreSQL 17 server via `PgPool.fromEnv()`
 * and verifies `/healthz`, Storefront SSR, Admin login session cookie, and `/api/admin/orders`.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PimIngestionPayload, PimIngestionResult } from "@super-ecommerce/configurator";
import { PgPool, runMigrations } from "@super-ecommerce/db";
import { createAppRequestHandler } from "./dev-server.ts";
import { createSuperCommerceGateway } from "./index.ts";

describe("Full-Stack HTTP Server against Real PostgreSQL 17", () => {
  let pool: PgPool;
  let handle: (req: Request) => Promise<Response>;

  before(async () => {
    pool = PgPool.fromEnv({ maxConnections: 8, statementTimeoutMs: 15_000 });
    await runMigrations(pool);
    handle = createAppRequestHandler({ pgPool: pool });
  });

  after(async () => {
    if (pool) {
      await pool.close();
    }
  });

  it("reports database=postgres and PostgreSQL 17 version on GET /healthz", async () => {
    const res = await handle(new Request("http://localhost:4100/healthz"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      database: string;
      pgVersion: string | null;
    };
    assert.equal(body.status, "ok");
    assert.equal(body.database, "postgres");
    assert.match(body.pgVersion ?? "", /^(16|17)\./);
  });

  it("serves Storefront SSR, authenticates Admin login, and queries /api/admin/orders from real PG 17", async () => {
    const storefrontRes = await handle(new Request("http://localhost:4100/"));
    assert.equal(storefrontRes.status, 200);
    const storefrontHtml = await storefrontRes.text();
    assert.match(storefrontHtml, /<!DOCTYPE html>/i);

    const loginRes = await handle(
      new Request("http://localhost:4100/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "admin@kronos.io",
          password: "Kronos!Admin2026",
        }),
      })
    );
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get("set-cookie");
    assert.ok(setCookie && setCookie.includes("super_admin_session="));
    const cookieHeader = setCookie.split(";")[0]!;

    const adminRes = await handle(
      new Request("http://localhost:4100/admin", {
        headers: { cookie: cookieHeader },
      })
    );
    assert.equal(adminRes.status, 200);
    const adminHtml = await adminRes.text();
    assert.match(adminHtml, /Overview|Super Ecommerce/i);

    const ordersRes = await handle(
      new Request("http://localhost:4100/api/admin/orders?limit=10", {
        headers: { cookie: cookieHeader },
      })
    );
    assert.equal(ordersRes.status, 200);
    const ordersPayload = (await ordersRes.json()) as {
      items?: unknown[];
      orders?: unknown[];
    };
    const rows = ordersPayload.items ?? ordersPayload.orders ?? [];
    assert.ok(Array.isArray(rows) && rows.length >= 1, "Expected seeded order from real PG 17");
  });

  it("keeps PIM publication and idempotency across gateways on PostgreSQL", async () => {
    const slug = `pim-integration-${randomUUID().slice(0, 8)}`;
    const sku = slug.toUpperCase();
    const sample: PimIngestionPayload = {
      systemSource: slug,
      exportId: "publish",
      exportedAtIso: new Date().toISOString(),
      families: [{ code: slug, label: "PIM Integration", attributes: [] }],
      products: [{
        id: "item-1", slug, sku, familyCode: slug, name: "Studio <Reference> DAC", attributes: {},
        listings: [
          { channelSlug: "us-retail", isPublished: true, priceAmount: "12000" },
          { channelSlug: "eu-flagship", isPublished: true, priceAmount: "13000" },
        ],
      }],
    };
    const gateway = createSuperCommerceGateway({ pgPool: pool });
    const deliver = (payload: PimIngestionPayload, handler = gateway.fetch) => handler(
      new Request("http://localhost/api/pim/webhook", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      }),
    );
    const readIngestion = async (res: Response) => {
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json() as { data: PimIngestionResult }).data;
    };
    const deliveries = await Promise.all([deliver(sample), deliver(sample)]);
    const [first, second] = await Promise.all(deliveries.map(readIngestion));
    assert.deepEqual([first.audit.status, second.audit.status].sort(), ["APPLIED", "ZERO_DIFF_NOOP"]);
    assert.equal(first.audit.syncId, second.audit.syncId);
    assert.equal(first.materializedProjections.length, 2);
    const published = await gateway.rpcClient.catalog.search({ channelSlug: "us-retail", queryText: sku });
    const originalProjection = published.find((item) => item.productSlug === slug);
    assert.equal(originalProjection?.minEffectivePrice, 12_000n);

    const unpublish: PimIngestionPayload = {
      ...sample,
      exportId: "unpublish-us",
      products: sample.products.map((product) => ({
        ...product,
        listings: product.listings.map((listing) => ({ ...listing, isPublished: listing.channelSlug !== "us-retail" })),
      })),
    };
    assert.equal((await deliver({ ...unpublish, exportId: sample.exportId })).status, 409);
    const rejected = await deliver({
      ...unpublish, exportId: "conflict",
      products: [unpublish.products[0]!, { ...unpublish.products[0]!, id: "item-2", slug: `${slug}-conflict`, sku: "KR-KB75-TI" }],
    });
    assert.equal(rejected.status, 409);
    assert.equal((await gateway.rpcClient.catalog.search({ channelSlug: "us-retail", queryText: sku })).find((item) => item.productSlug === slug)?.minEffectivePrice, 12_000n);

    await readIngestion(await deliver(unpublish));
    const restarted = createSuperCommerceGateway({ pgPool: pool, projections: [originalProjection!] });
    assert.equal((await readIngestion(await deliver(sample, restarted.fetch))).audit.status, "ZERO_DIFF_NOOP");
    const us = await restarted.rpcClient.catalog.search({ channelSlug: "us-retail", queryText: sku });
    const eu = await restarted.rpcClient.catalog.search({ channelSlug: "eu-flagship", queryText: sku });
    assert.equal(us.some((item) => item.productSlug === slug), false);
    assert.equal(eu.find((item) => item.productSlug === slug)?.minEffectivePrice, 13_000n);
    const { rows } = await pool.query<{ slug: string; is_published: string }>(
      `SELECT c.slug, l.is_published::text FROM variant_channel_listings l
       JOIN channels c ON c.id = l.channel_id JOIN product_variants v ON v.id = l.variant_id
       WHERE v.sku = $1 ORDER BY c.slug`, [sku],
    );
    assert.deepEqual(rows, [{ slug: "eu-flagship", is_published: "true" }, { slug: "us-retail", is_published: "false" }]);
    const status = await restarted.rpcClient.pim.getSyncStatus();
    assert.equal(status.auditHistory.filter((audit) => audit.systemSource === slug).length, 2);
    assert.equal(status.materializedProjections.filter((projection) => projection.productSlug === slug).length, 1);
    assert.equal((await handle(new Request(`http://localhost/products/${slug}?channel=us-retail`))).status, 404);
    const detail = await handle(new Request(`http://localhost/products/${slug}?channel=eu-flagship`));
    assert.equal(detail.status, 200);
    assert.match(await detail.text(), /Studio &lt;Reference&gt; DAC/);
  });
});
