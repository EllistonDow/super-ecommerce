import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildCatalogChannelProjection,
  createLoopbackPgWireStream,
  deserializeWithBigInt,
  HybridCatalogSearchEngine,
  interpolatePgSql,
  OfflinePgPool,
  PgPool,
  PgWireClient,
  runMigrations,
  serializeWithBigInt,
  validateDynamicAttributes,
} from "./index.ts";
import type { AttributeDefinition, CatalogChannelProjectionRecord, ChannelRecord } from "./index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("@super-ecommerce/db", () => {
  const apparelVariantSchema: readonly AttributeDefinition[] = [
    {
      slug: "color",
      name: "Color",
      type: "ENUM",
      required: true,
      allowedValues: ["obsidian", "ivory", "cobalt"],
    },
    {
      slug: "size",
      name: "Size",
      type: "ENUM",
      required: true,
      allowedValues: ["S", "M", "L", "XL"],
    },
    {
      slug: "gsm_weight",
      name: "Fabric GSM",
      type: "NUMBER",
      required: false,
      minNumber: 100,
      maxNumber: 600,
    },
  ];

  it("validates ProductType JSONB attributes and rejects undeclared or out-of-range fields", () => {
    const valid = validateDynamicAttributes(apparelVariantSchema, {
      color: "obsidian",
      size: "XL",
      gsm_weight: 280,
    });
    assert.equal(valid.valid, true);
    assert.equal(valid.errors.length, 0);

    const invalid = validateDynamicAttributes(apparelVariantSchema, {
      color: "neon-pink",
      gsm_weight: 950,
      undeclared_field: "foo",
    });
    assert.equal(invalid.valid, false);
    assert.equal(invalid.errors.length, 4);
  });

  it("builds CQRS CatalogChannelProjection with merged facets and effective prices", () => {
    const channel: ChannelRecord = {
      id: "ch-us",
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

    const projection = buildCatalogChannelProjection({
      channel,
      product: {
        id: "prod-hoodie",
        productTypeId: "pt-apparel",
        slug: "heavyweight-hoodie",
        name: "Heavyweight Hoodie",
        attributes: { material: "organic-cotton", pre_shrunk: true },
      },
      variants: [
        {
          id: "var-m",
          productId: "prod-hoodie",
          sku: "HD-OBS-M",
          name: "Obsidian / M",
          attributes: { color: "obsidian", size: "M" },
        },
        {
          id: "var-xl",
          productId: "prod-hoodie",
          sku: "HD-IVR-XL",
          name: "Ivory / XL",
          attributes: { color: "ivory", size: "XL" },
        },
      ],
      listingsByVariantId: new Map([
        [
          "var-m",
          {
            variantId: "var-m",
            channelId: "ch-us",
            isPublished: true,
            priceAmount: 10_000n,
            tierPrices: [],
          },
        ],
        [
          "var-xl",
          {
            variantId: "var-xl",
            channelId: "ch-us",
            isPublished: true,
            priceAmount: 12_000n,
            tierPrices: [],
          },
        ],
      ]),
      availableQtyByVariantId: new Map([
        ["var-m", 15],
        ["var-xl", 5],
      ]),
      activeCatalogueDiscountBps: 2000,
    });

    assert.ok(projection);
    assert.equal(projection.minEffectivePrice, 8_000n);
    assert.equal(projection.maxEffectivePrice, 9_600n);
    assert.equal(projection.totalAvailableQty, 20);
    assert.equal(projection.isInStock, true);
    assert.deepEqual(projection.mergedAttributes["color"], ["obsidian", "ivory"]);
    assert.deepEqual(projection.mergedAttributes["size"], ["M", "XL"]);
  });

  it("ships PostgreSQL 17 DDL with GIN indexes, partial indexes, and CHECK constraints", () => {
    const sqlPath = join(__dirname, "../migrations/0001_phase1_core_schema.sql");
    const ddl = readFileSync(sqlPath, "utf8");

    assert.match(ddl, /CREATE TABLE IF NOT EXISTS channels/);
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS catalog_channel_projections/);
    assert.match(ddl, /USING GIN \(attributes jsonb_path_ops\)/);
    assert.match(ddl, /WHERE status = 'PENDING'/);
    assert.match(ddl, /WHERE status = 'ACTIVE'/);
  });

  it("speaks PostgreSQL v3 Wire Protocol (0x00030000) with BEGIN / FOR UPDATE SKIP LOCKED / COMMIT", async () => {
    const executedSql: string[] = [];
    const stream = createLoopbackPgWireStream((sql) => {
      executedSql.push(sql);
      if (sql.includes("SELECT warehouse_id")) {
        return {
          commandTag: "SELECT 1",
          columns: ["warehouse_id", "available_qty"],
          rows: [["wh-us-east", "37"]],
        };
      }
      return {
        commandTag: sql,
        columns: [],
        rows: [],
      };
    });

    const client = new PgWireClient({
      host: "127.0.0.1",
      port: 5432,
      user: "postgres",
      database: "super_ecommerce",
      stream,
    });
    await client.connect();

    const rows = await client.withTransaction(async (tx) => {
      const res = await tx.query<{ warehouse_id: string; available_qty: string }>(
        "SELECT warehouse_id, (quantity_on_hand - quantity_reserved - quantity_allocated) AS available_qty FROM stock_quants WHERE variant_id = $1 FOR UPDATE SKIP LOCKED",
        ["var-obsidian-m"]
      );
      return res.rows;
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.warehouse_id, "wh-us-east");
    assert.equal(rows[0]?.available_qty, "37");
    assert.equal(executedSql[0], "BEGIN");
    assert.match(executedSql[1]!, /FOR UPDATE SKIP LOCKED/);
    assert.equal(executedSql[2], "COMMIT");

    await client.close();
  });

  it("enforces ACID PostgreSQL transactions and CHECK constraints in OfflinePgPool", async () => {
    const pgPool = new OfflinePgPool();
    await runMigrations(pgPool);
    try {
      await pgPool.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO msi_stock_slots (warehouse_id, priority_rank, linked_to_channel, supports_shipping_zone, variant_id, quantity_on_hand, quantity_reserved, quantity_allocated)
           VALUES ($1, $2, true, true, $3, $4, 0, 0)`,
          ["wh-1", 10, "var-1", 25]
        );
      });

      // Violating CHECK (quantity_reserved >= 0) inside a transaction rolls back atomically
      await assert.rejects(async () => {
        await pgPool.withTransaction(async (tx) => {
          await tx.query(
            `UPDATE msi_stock_slots SET quantity_reserved = -5 WHERE warehouse_id = $1 AND variant_id = $2`,
            ["wh-1", "var-1"]
          );
        });
      });

      const res = await pgPool.query<{ quantity_on_hand: string; quantity_reserved: string }>(
        `SELECT quantity_on_hand, quantity_reserved FROM msi_stock_slots WHERE warehouse_id = $1`,
        ["wh-1"]
      );
      assert.equal(Number(res.rows[0]?.quantity_on_hand), 25);
      assert.equal(Number(res.rows[0]?.quantity_reserved), 0);
    } finally {
      await pgPool.close();
    }
  });

  it("serializes concurrent runMigrations calls via PostgreSQL transactional advisory lock without catalog races", async () => {
    const pgPool = new OfflinePgPool();
    try {
      // Concurrently run 3 parallel runMigrations calls as would occur when multiple container replicas boot
      const reports = await Promise.all([
        runMigrations(pgPool),
        runMigrations(pgPool),
        runMigrations(pgPool),
      ]);

      assert.equal(reports.length, 3);
      // All versions in schema_migrations are applied
      const rows = await pgPool.query<{ version: string }>(
        `SELECT version FROM schema_migrations ORDER BY version ASC`
      );
      assert.ok(rows.rows.length >= 3);
      assert.ok(rows.rows.some((r) => r.version === "0001"));
      assert.ok(rows.rows.some((r) => r.version === "0002"));
      assert.ok(rows.rows.some((r) => r.version === "0003"));
    } finally {
      await pgPool.close();
    }
  });

  it("ranks hybrid catalog projections via Okapi BM25 + 64D semantic vector cosine and Reciprocal Rank Fusion (RRF k=60)", () => {
    const corpus: CatalogChannelProjectionRecord[] = [
      {
        channelSlug: "us-retail",
        productId: "prod-kb",
        productSlug: "kronos-field-75",
        productName: "Kronos Field 75 CNC Keyboard",
        currencyCode: "USD",
        minEffectivePrice: 35_100n,
        maxEffectivePrice: 35_100n,
        isInStock: true,
        totalAvailableQty: 30,
        mergedAttributes: {
          chassis: ["grade-5-titanium"],
          switch: ["linear"],
          gasket_mount: [true],
        },
        variantsSnapshot: [
          {
            variantId: "var-kb-1",
            sku: "KR-KB75-TI",
            name: "Raw Titanium / Linear",
            effectivePrice: 35_100n,
            availableQty: 30,
            attributes: { switch: "linear" },
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
          category: ["desktop-audio"],
          balanced_xlr: [true],
        },
        variantsSnapshot: [
          {
            variantId: "var-dac-1",
            sku: "KR-DAC-BLK",
            name: "Obsidian Anodized",
            effectivePrice: 53_100n,
            availableQty: 18,
            attributes: {},
          },
        ],
      },
      {
        channelSlug: "us-retail",
        productId: "prod-hoodie",
        productSlug: "heavyweight-cotton-hoodie",
        productName: "Heavyweight Organic Cotton Pullover",
        currencyCode: "USD",
        minEffectivePrice: 9_800n,
        maxEffectivePrice: 9_800n,
        isInStock: true,
        totalAvailableQty: 50,
        mergedAttributes: { material: ["organic-cotton"], color: ["obsidian"] },
        variantsSnapshot: [],
      },
    ];

    const engine = new HybridCatalogSearchEngine(corpus);

    // 1. Pure Semantic Vector Recall: query uses synonyms ("quiet mechanical typing") NOT present verbatim in product name/slug
    const semanticReport = engine.search({
      channelSlug: "us-retail",
      queryText: "quiet mechanical typing",
      inStockOnly: true,
      rrfK: 60,
    });
    assert.equal(semanticReport.hits.length >= 1, true);
    assert.equal(semanticReport.hits[0]?.projection.productSlug, "kronos-field-75");
    assert.equal(semanticReport.hits[0]?.matchedBy, "VECTOR_SEMANTIC");
    assert.equal((semanticReport.hits[0]?.vectorSimilarity ?? 0) > 0.25, true);
    assert.match(semanticReport.pgHybridRrfSql, /FULL OUTER JOIN vector_semantic/);

    // 2. Dual-Signal RRF Fusion ("titanium keyboard"): matches both BM25 & 64D Vector -> HYBRID_BOTH with highest RRF score
    const hybridReport = engine.search({
      channelSlug: "us-retail",
      queryText: "titanium keyboard",
      inStockOnly: true,
      rrfK: 60,
    });
    assert.equal(hybridReport.hits[0]?.projection.productSlug, "kronos-field-75");
    assert.equal(hybridReport.hits[0]?.matchedBy, "HYBRID_BOTH");
    assert.equal(hybridReport.hits[0]?.bm25Rank, 1);
    assert.equal(hybridReport.hits[0]?.vectorRank, 1);
    assert.equal(
      Math.abs((hybridReport.hits[0]?.rrfScore ?? 0) - 2 / 61) < 1e-5,
      true
    );

    // 3. Partial index & EXPIRED_TTL checks in DDL
    const ddl = readFileSync(
      join(__dirname, "../migrations/0001_phase1_core_schema.sql"),
      "utf8"
    );
    assert.match(ddl, /idx_ccp_fts_gin/);
    assert.match(ddl, /EXPIRED_TTL/);
  });

  it("interpolates PostgreSQL params safely without touching quoted literals, Date, or bigint JSON", () => {
    const dt = new Date("2026-11-16T08:30:00.000Z");
    const sql = interpolatePgSql(
      "SELECT '$1 literal', $tag$skip $2$tag$, $1 AS id, $2 AS ts, $3 AS payload -- comment $1",
      ["ord-'1", dt, { total: 4200n, nested: "$1" }]
    );

    assert.match(sql, /'\$1 literal'/);
    assert.match(sql, /\$tag\$skip \$2\$tag\$/);
    assert.match(sql, /-- comment \$1$/);
    assert.match(sql, /'ord-''1' AS id/);
    assert.match(sql, /'2026-11-16T08:30:00\.000Z'::timestamptz AS ts/);
    assert.match(sql, /\{"total":\{"__bigint__":"4200"\},"nested":"\$1"\}'::jsonb AS payload/);

    const roundtrip = deserializeWithBigInt<{ total: bigint }>(
      serializeWithBigInt({ total: 4200n })
    );
    assert.equal(roundtrip.total, 4200n);
  });

  it("serializes concurrent PgWireClient queries and bounds PgPool concurrency with nested SAVEPOINTs", async () => {
    const connectionSqlLogs: string[][] = [];
    let connSeq = 0;

    const pool = new PgPool({
      host: "127.0.0.1",
      port: 5438,
      user: "super",
      database: "super_ecommerce",
      maxConnections: 2,
      statementTimeoutMs: 5000,
      idleTimeoutMs: 0,
      createClient: (opts) => {
        const idx = connSeq++;
        const log: string[] = [];
        connectionSqlLogs.push(log);
        const stream = createLoopbackPgWireStream((sql, boundParams) => {
          log.push(sql);
          if (sql === "SELECT $1 AS val" && boundParams?.[0]?.startsWith("item-")) {
            return {
              commandTag: "SELECT 1",
              columns: ["val"],
              rows: [[boundParams[0]]],
            };
          }
          return {
            commandTag: sql,
            columns: [],
            rows: [],
          };
        });
        return new PgWireClient({ ...opts, stream });
      },
    });

    // Fire 6 concurrent queries across maxConnections=2
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        pool.query<{ val: string }>("SELECT $1 AS val", [`item-${n}`])
      )
    );
    assert.equal(results.length, 6);
    assert.equal(pool.getStats().totalConnections <= 2, true);
    assert.equal(pool.getStats().activeConnections, 0);

    // Every created connection received SET statement_timeout = 5000
    for (const log of connectionSqlLogs) {
      assert.equal(log[0], "SET statement_timeout = 5000");
    }

    // Nested transaction uses SAVEPOINT and recovers outer transaction on inner rollback
    const txLog: string[] = [];
    const txPool = new PgPool({
      host: "127.0.0.1",
      port: 5438,
      user: "super",
      database: "super_ecommerce",
      maxConnections: 1,
      statementTimeoutMs: 0,
      idleTimeoutMs: 0,
      createClient: (opts) =>
        new PgWireClient({
          ...opts,
          stream: createLoopbackPgWireStream((sql) => {
            txLog.push(sql);
            return { commandTag: sql, columns: [], rows: [] };
          }),
        }),
    });

    await txPool.withTransaction(async (outer) => {
      await outer.query("INSERT INTO outer_t VALUES (1)");
      await assert.rejects(async () => {
        await outer.withTransaction(async (inner) => {
          await inner.query("INSERT INTO inner_t VALUES (2)");
          throw new Error("inner fail");
        });
      }, /inner fail/);
      await outer.query("INSERT INTO outer_t VALUES (3)");
    });

    assert.equal(txLog[0], "BEGIN");
    assert.equal(txLog[1], "INSERT INTO outer_t VALUES (1)");
    assert.match(txLog[2]!, /^SAVEPOINT sp_/);
    assert.equal(txLog[3], "INSERT INTO inner_t VALUES (2)");
    assert.match(txLog[4]!, /^ROLLBACK TO SAVEPOINT sp_/);
    assert.match(txLog[5]!, /^RELEASE SAVEPOINT sp_/);
    assert.equal(txLog[6], "INSERT INTO outer_t VALUES (3)");
    assert.equal(txLog[7], "COMMIT");

    await pool.close();
    await txPool.close();

    // Direct single-client concurrent Extended Query serialization without SQL text interpolation
    const directClient = new PgWireClient({
      host: "127.0.0.1",
      port: 5438,
      user: "super",
      database: "super_ecommerce",
      stream: createLoopbackPgWireStream((sql, boundParams) => ({
        commandTag: "SELECT 1",
        columns: ["q", "param0"],
        rows: [[sql, boundParams?.[0] ?? null]],
      })),
    });
    await directClient.connect();
    const [r1, r2, r3] = await Promise.all([
      directClient.query<{ q: string; param0: string }>("SELECT $1", ["alpha"]),
      directClient.query<{ q: string; param0: string }>("SELECT $1", ["beta'; DROP TABLE orders; --"]),
      directClient.query<{ q: string; param0: string }>("SELECT $1", ["gamma"]),
    ]);
    assert.equal(r1.rows[0]?.q, "SELECT $1");
    assert.equal(r1.rows[0]?.param0, "alpha");
    assert.equal(r2.rows[0]?.q, "SELECT $1");
    assert.equal(r2.rows[0]?.param0, "beta'; DROP TABLE orders; --");
    assert.equal(r3.rows[0]?.q, "SELECT $1");
    assert.equal(r3.rows[0]?.param0, "gamma");
    await directClient.close();

    // SSLRequest ('0x04d2162f') negotiation: ssl='require' succeeds on 'S' and rejects 'N'
    const sslSupportedClient = new PgWireClient({
      host: "db.cloud.example",
      port: 5432,
      user: "super",
      database: "super_ecommerce",
      ssl: "require",
      stream: createLoopbackPgWireStream(
        () => ({ commandTag: "SELECT 1", columns: ["tls"], rows: [["1"]] }),
        { sslSupported: true }
      ),
    });
    await sslSupportedClient.connect();
    assert.equal(sslSupportedClient.isTlsEncrypted(), true);
    await sslSupportedClient.close();

    const sslRejectedClient = new PgWireClient({
      host: "db.cloud.example",
      port: 5432,
      user: "super",
      database: "super_ecommerce",
      ssl: "require",
      stream: createLoopbackPgWireStream(
        () => ({ commandTag: "SELECT 1", columns: [], rows: [] }),
        { sslSupported: false }
      ),
    });
    await assert.rejects(() => sslRejectedClient.connect(), /SSL\/TLS/);
  });

  it("applies versioned PostgreSQL migrations idempotently on OfflinePgPool and enforces ACID rollback, keyset pagination, and CHECK constraints", async () => {
    const pg = new OfflinePgPool();
    try {
      const firstRun = await runMigrations(pg);
      assert.deepEqual(firstRun.appliedVersions, ["0001", "0002", "0003", "0004"]);

      const secondRun = await runMigrations(pg);
      assert.deepEqual(secondRun.appliedVersions, []);
      assert.deepEqual(secondRun.alreadyAppliedVersions, ["0001", "0002", "0003", "0004"]);

      // 1. CHECK constraint rollback on msi_stock_slots
      await pg.query(
        `INSERT INTO msi_stock_slots (warehouse_id, variant_id, priority_rank, linked_to_channel, supports_shipping_zone, quantity_on_hand, quantity_reserved, quantity_allocated)
         VALUES ($1, $2, 10, true, true, $3, 0, 0)`,
        ["WH-EAST", "SKU-KB-75", 25]
      );

      await assert.rejects(async () => {
        await pg.withTransaction(async (tx) => {
          await tx.query(
            `UPDATE msi_stock_slots SET quantity_on_hand = 30 WHERE warehouse_id = $1 AND variant_id = $2`,
            ["WH-EAST", "SKU-KB-75"]
          );
          await tx.query(
            `UPDATE msi_stock_slots SET quantity_reserved = -5 WHERE warehouse_id = $1 AND variant_id = $2`,
            ["WH-EAST", "SKU-KB-75"]
          );
        });
      });

      const afterRollback = await pg.query<{
        quantity_on_hand: string;
        quantity_reserved: string;
      }>(
        `SELECT quantity_on_hand, quantity_reserved FROM msi_stock_slots WHERE warehouse_id = $1 AND variant_id = $2`,
        ["WH-EAST", "SKU-KB-75"]
      );
      assert.equal(afterRollback.rows[0]?.quantity_on_hand, "25");
      assert.equal(afterRollback.rows[0]?.quantity_reserved, "0");

      // 2. Keyset pagination (created_at DESC, id DESC) on orders
      const t1 = "2026-11-16T01:00:00.000Z";
      const t2 = "2026-11-16T02:00:00.000Z";
      for (const [id, ch, ts] of [
        ["ord-1", "us-retail", t1],
        ["ord-2", "us-retail", t2],
        ["ord-3", "us-retail", t2],
      ] as const) {
        await pg.query(
          `INSERT INTO orders (id, checkout_id, channel_slug, currency_code, total_gross_amount, payment_status, payload_json, created_at, updated_at)
           VALUES ($1, $2, $3, 'USD', 1000, 'CAPTURED', $4::jsonb, $5::timestamptz, $5::timestamptz)`,
          [id, `chk-${id}`, ch, serializeWithBigInt({ orderId: id, total: 1000n }), ts]
        );
      }

      const page1 = await pg.query<{ id: string; created_at: string }>(
        `SELECT id, created_at FROM orders ORDER BY created_at DESC, id DESC LIMIT 2`
      );
      assert.deepEqual(
        page1.rows.map((r) => r.id),
        ["ord-3", "ord-2"]
      );

      const last = page1.rows[page1.rows.length - 1]!;
      const page2 = await pg.query<{ id: string }>(
        `SELECT id FROM orders WHERE (created_at, id) < ($1::timestamptz, $2) ORDER BY created_at DESC, id DESC LIMIT 2`,
        [last.created_at, last.id]
      );
      assert.deepEqual(
        page2.rows.map((r) => r.id),
        ["ord-1"]
      );

      // 3. Concurrent FOR UPDATE SKIP LOCKED outbox claim without duplicate delivery
      for (const id of ["evt-1", "evt-2", "evt-3"]) {
        await pg.query(
          `INSERT INTO transactional_outbox_events (id, event_type, aggregate_type, aggregate_id, payload, status)
           VALUES ($1, 'OrderConfirmed', 'Order', 'ord-1', '{"ok":true}'::jsonb, 'PENDING')`,
          [id]
        );
      }
      const [claimA, claimB] = await Promise.all([
        pg.withTransaction(async (tx) => {
          const picked = await tx.query<{ id: string }>(
            `SELECT id FROM transactional_outbox_events WHERE status = 'PENDING' ORDER BY id ASC LIMIT 2 FOR UPDATE SKIP LOCKED`
          );
          await Promise.resolve(); // Yield so worker B overlaps while worker A holds row locks
          for (const row of picked.rows) {
            await tx.query(
              `UPDATE transactional_outbox_events SET status = 'PUBLISHED' WHERE id = $1`,
              [row.id]
            );
          }
          return picked.rows.map((r) => r.id);
        }),
        pg.withTransaction(async (tx) => {
          const picked = await tx.query<{ id: string }>(
            `SELECT id FROM transactional_outbox_events WHERE status = 'PENDING' ORDER BY id ASC LIMIT 2 FOR UPDATE SKIP LOCKED`
          );
          for (const row of picked.rows) {
            await tx.query(
              `UPDATE transactional_outbox_events SET status = 'PUBLISHED' WHERE id = $1`,
              [row.id]
            );
          }
          return picked.rows.map((r) => r.id);
        }),
      ]);
      assert.deepEqual(claimA, ["evt-1", "evt-2"]);
      assert.deepEqual(claimB, ["evt-3"]);

      // 4. Scalar JSONB & JSON null vs SQL NULL round-trip fidelity (matching PG 17 wire text)
      const jsonSamples = [
        { key: "str", raw: serializeWithBigInt("ok"), expected: "ok" },
        { key: "bool_t", raw: serializeWithBigInt(true), expected: true },
        { key: "bool_f", raw: serializeWithBigInt(false), expected: false },
        { key: "num", raw: serializeWithBigInt(123), expected: 123 },
        { key: "jnull", raw: serializeWithBigInt(null), expected: null },
      ] as const;

      for (const s of jsonSamples) {
        await pg.query(
          `INSERT INTO transactional_outbox_events (id, event_type, aggregate_type, aggregate_id, payload, status)
           VALUES ($1, 'ScalarTest', 'Test', $1, $2::jsonb, 'PENDING')`,
          [s.key, s.raw]
        );
        const row = await pg.query<{ payload: string | null }>(
          `SELECT payload FROM transactional_outbox_events WHERE id = $1`,
          [s.key]
        );
        assert.notEqual(row.rows[0]?.payload, null);
        assert.equal(deserializeWithBigInt(row.rows[0]!.payload!), s.expected);
      }

      const castRes = await pg.query<{
        s: string | null;
        b: string | null;
        n: string | null;
        sql_null: string | null;
      }>(
        `SELECT $1::jsonb AS s, $2::jsonb AS b, $3::jsonb AS n, NULL::jsonb AS sql_null`,
        [serializeWithBigInt("hello"), serializeWithBigInt(false), serializeWithBigInt(null)]
      );
      assert.equal(deserializeWithBigInt(castRes.rows[0]!.s!), "hello");
      assert.equal(deserializeWithBigInt(castRes.rows[0]!.b!), false);
      assert.equal(deserializeWithBigInt(castRes.rows[0]!.n!), null);
      assert.equal(castRes.rows[0]!.sql_null, null);
    } finally {
      await pg.close();
    }
  });
});
