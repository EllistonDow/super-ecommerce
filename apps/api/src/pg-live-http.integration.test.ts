/**
 * Full-Stack HTTP Server + PostgreSQL 17 Live Smoke Test (`apps/api/src/pg-live-http.integration.test.ts`).
 *
 * Boots `createAppRequestHandler({ pgPool })` wired to a real PostgreSQL 17 server via `PgPool.fromEnv()`
 * and verifies `/healthz`, Storefront SSR, Admin login session cookie, and `/api/admin/orders`.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PgPool, runMigrations } from "@super-ecommerce/db";
import { createAppRequestHandler } from "./dev-server.ts";

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
    assert.match(body.pgVersion ?? "", /^17\./);
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
});
