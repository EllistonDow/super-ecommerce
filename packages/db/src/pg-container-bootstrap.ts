/**
 * Apple Container PostgreSQL Bootstrap & Live Wire-Protocol Probe (`packages/db/src/pg-container-bootstrap.ts`).
 *
 * Connects to the local Apple Container `super-postgres` instance (`127.0.0.1:5438`) over
 * raw PostgreSQL v3 Wire Protocol (`PgWireClient` with SCRAM-SHA-256), applies
 * `0001_phase1_core_schema.sql`, seeds baseline MSI `stock_quants` & CQRS projections,
 * and measures live `SELECT ... FOR UPDATE SKIP LOCKED` row-locking latency.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PgWireClient } from "./pg-wire-driver.ts";
import type { PgPoolLike } from "./pg-pool.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppleContainerPgStatus {
  readonly connected: boolean;
  readonly containerName: string;
  readonly endpoint: string;
  readonly database: string;
  readonly serverVersion: string;
  readonly tableCount: number;
  readonly ginIndexCount: number;
  readonly lockedStockRows: readonly {
    readonly warehouse_slug: string;
    readonly sku: string;
    readonly quantity_on_hand: string;
    readonly quantity_reserved: string;
    readonly quantity_allocated: string;
    readonly available_qty: string;
  }[];
  readonly forUpdateLatencyUs: number;
  readonly error?: string;
}

export interface PgConcurrencyWorkloadMetrics {
  readonly id: string;
  readonly title: string;
  readonly sqlPattern: string;
  readonly concurrency: number;
  readonly totalOperations: number;
  readonly succeededCount: number;
  readonly rejectedCount: number;
  readonly throughputOpsPerSec: number;
  readonly p50LatencyUs: number;
  readonly p99LatencyUs: number;
  readonly invariantSummary: string;
  readonly invariantPassed: boolean;
}

export interface PgForUpdateStressReport {
  readonly connected: boolean;
  readonly containerName: string;
  readonly endpoint: string;
  readonly serverVersion: string;
  readonly poolConnections: number;
  readonly flashSaleInitialStock: number;
  readonly flashSaleConcurrentBuyers: number;
  readonly flashSaleFulfilled: number;
  readonly flashSaleRejected: number;
  readonly flashSaleOversoldUnits: number;
  readonly outboxTotalSeeded: number;
  readonly outboxUniqueClaimed: number;
  readonly outboxDuplicateClaims: number;
  readonly deadlocksDetected: number;
  readonly totalWallTimeMs: number;
  readonly workloads: readonly PgConcurrencyWorkloadMetrics[];
  readonly executedAtIso: string;
}

function computePercentileUs(samplesUs: readonly number[], percentile: number): number {
  if (samplesUs.length === 0) return 0;
  const sorted = [...samplesUs].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((percentile / 100) * sorted.length))
  );
  return Math.round((sorted[idx] ?? 0) * 10) / 10;
}

let cachedPgStressReport: PgForUpdateStressReport | null = null;

export async function runPgForUpdateStressBenchmark(options?: {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  poolSize?: number;
  flashSaleBuyers?: number;
  flashSaleStock?: number;
  outboxEventsCount?: number;
  forceRefresh?: boolean;
}): Promise<PgForUpdateStressReport> {
  if (cachedPgStressReport && !options?.forceRefresh) {
    return cachedPgStressReport;
  }

  const host = options?.host ?? process.env["SUPER_PG_HOST"] ?? "127.0.0.1";
  const port = options?.port ?? Number(process.env["SUPER_PG_PORT"] ?? "5438");
  const user = options?.user ?? process.env["SUPER_PG_USER"] ?? "super";
  const password =
    options?.password ?? process.env["SUPER_PG_PASSWORD"] ?? "superpassword";
  const database =
    options?.database ?? process.env["SUPER_PG_DB"] ?? "super_ecommerce";

  const poolSize = options?.poolSize ?? 12;
  const flashSaleStock = options?.flashSaleStock ?? 25;
  const flashSaleBuyers = options?.flashSaleBuyers ?? 60;
  const outboxEventsCount = options?.outboxEventsCount ?? 64;

  const suiteStartNs = process.hrtime.bigint();
  const pool: PgWireClient[] = [];

  try {
    // Ensure schema & seed rows exist first
    await bootstrapAndProbeAppleContainerPg({ host, port, user, password, database });

    // Open `poolSize` concurrent TCP Wire Protocol connections to `super-postgres:5438`
    for (let i = 0; i < poolSize; i++) {
      const c = new PgWireClient({ host, port, user, password, database });
      await c.connect();
      pool.push(c);
    }

    const adminConn = pool[0]!;

    // Snapshot baseline deadlocks & version
    const preMeta = await adminConn.query<{
      pg_version: string;
      deadlocks: string;
      us_central_id: string;
      us_east_id: string;
      variant_id: string;
      orig_on_hand: string;
      orig_reserved: string;
      orig_allocated: string;
    }>(`
      SELECT
        current_setting('server_version') AS pg_version,
        (SELECT coalesce(sum(deadlocks), 0)::text FROM pg_stat_database WHERE datname = current_database()) AS deadlocks,
        (SELECT id::text FROM warehouses WHERE slug = 'us-central' LIMIT 1) AS us_central_id,
        (SELECT id::text FROM warehouses WHERE slug = 'us-east' LIMIT 1) AS us_east_id,
        (SELECT id::text FROM product_variants WHERE sku = 'KR-KB75-TI' LIMIT 1) AS variant_id,
        (SELECT quantity_on_hand::text FROM stock_quants sq JOIN warehouses w ON w.id = sq.warehouse_id JOIN product_variants v ON v.id = sq.variant_id WHERE w.slug = 'us-central' AND v.sku = 'KR-KB75-TI' LIMIT 1) AS orig_on_hand,
        (SELECT quantity_reserved::text FROM stock_quants sq JOIN warehouses w ON w.id = sq.warehouse_id JOIN product_variants v ON v.id = sq.variant_id WHERE w.slug = 'us-central' AND v.sku = 'KR-KB75-TI' LIMIT 1) AS orig_reserved,
        (SELECT quantity_allocated::text FROM stock_quants sq JOIN warehouses w ON w.id = sq.warehouse_id JOIN product_variants v ON v.id = sq.variant_id WHERE w.slug = 'us-central' AND v.sku = 'KR-KB75-TI' LIMIT 1) AS orig_allocated
    `);

    const metaRow = preMeta.rows[0]!;
    const deadlocksBefore = Number(metaRow.deadlocks ?? 0);
    const usCentralId = metaRow.us_central_id;
    const usEastId = metaRow.us_east_id;
    const variantId = metaRow.variant_id;

    // =========================================================================
    // WORKLOAD 1: Hot-SKU Flash Sale Contention (`SELECT ... FOR UPDATE`)
    // =========================================================================
    await adminConn.query(
      `UPDATE stock_quants
       SET quantity_on_hand = $1, quantity_reserved = 0, quantity_allocated = 0, updated_at = now()
       WHERE warehouse_id = $2::uuid AND variant_id = $3::uuid`,
      [flashSaleStock, usCentralId, variantId]
    );

    let flashFulfilled = 0;
    let flashRejected = 0;
    const flashLatenciesUs: number[] = [];
    let nextBuyerIdx = 0;

    const w1StartNs = process.hrtime.bigint();
    await Promise.all(
      pool.map(async (conn) => {
        while (true) {
          const buyerIdx = nextBuyerIdx++;
          if (buyerIdx >= flashSaleBuyers) break;
          const opT0 = process.hrtime.bigint();
          const claimed = await conn.withTransaction(async (tx) => {
            const lockRes = await tx.query<{
              id: string;
              avail: string;
            }>(
              `SELECT
                 id::text,
                 (quantity_on_hand - quantity_reserved - quantity_allocated)::text AS avail
               FROM stock_quants
               WHERE warehouse_id = $1::uuid AND variant_id = $2::uuid
               FOR UPDATE`,
              [usCentralId, variantId]
            );
            const row = lockRes.rows[0];
            const avail = Number(row?.avail ?? 0);
            if (row && avail >= 1) {
              await tx.query(
                `UPDATE stock_quants
                 SET quantity_allocated = quantity_allocated + 1, updated_at = now()
                 WHERE id = $1::uuid`,
                [row.id]
              );
              return true;
            }
            return false;
          });
          const opUs = Number(process.hrtime.bigint() - opT0) / 1_000;
          flashLatenciesUs.push(opUs);
          if (claimed) {
            flashFulfilled++;
          } else {
            flashRejected++;
          }
        }
      })
    );
    const w1ElapsedSec =
      Number(process.hrtime.bigint() - w1StartNs) / 1_000_000_000;

    const postFlashRow = await adminConn.query<{
      allocated: string;
      avail: string;
    }>(
      `SELECT
         quantity_allocated::text AS allocated,
         (quantity_on_hand - quantity_reserved - quantity_allocated)::text AS avail
       FROM stock_quants
       WHERE warehouse_id = $1::uuid AND variant_id = $2::uuid`,
      [usCentralId, variantId]
    );
    const finalAllocated = Number(postFlashRow.rows[0]?.allocated ?? 0);
    const oversoldUnits = Math.max(0, finalAllocated - flashSaleStock);

    // Restore original `us-central` stock row state
    await adminConn.query(
      `UPDATE stock_quants
       SET quantity_on_hand = $1, quantity_reserved = $2, quantity_allocated = $3, updated_at = now()
       WHERE warehouse_id = $4::uuid AND variant_id = $5::uuid`,
      [
        Number(metaRow.orig_on_hand ?? 25),
        Number(metaRow.orig_reserved ?? 1),
        Number(metaRow.orig_allocated ?? 0),
        usCentralId,
        variantId,
      ]
    );

    const workload1: PgConcurrencyWorkloadMetrics = {
      id: "FOR_UPDATE_FLASH_SALE",
      title: `Hot-SKU Flash Sale Row Lock (${flashSaleBuyers} Buyers -> ${flashSaleStock} Stock)`,
      sqlPattern: "BEGIN; SELECT ... FROM stock_quants WHERE (warehouse_id, variant_id) FOR UPDATE; UPDATE ... COMMIT;",
      concurrency: poolSize,
      totalOperations: flashSaleBuyers,
      succeededCount: flashFulfilled,
      rejectedCount: flashRejected,
      throughputOpsPerSec: Math.round(flashSaleBuyers / Math.max(0.0001, w1ElapsedSec)),
      p50LatencyUs: computePercentileUs(flashLatenciesUs, 50),
      p99LatencyUs: computePercentileUs(flashLatenciesUs, 99),
      invariantSummary: `Fulfilled ${flashFulfilled}/${flashSaleStock} | Rejected ${flashRejected} | Oversold: ${oversoldUnits}`,
      invariantPassed:
        flashFulfilled === flashSaleStock &&
        flashRejected === flashSaleBuyers - flashSaleStock &&
        oversoldUnits === 0,
    };

    // =========================================================================
    // WORKLOAD 2: Multi-Warehouse Canonical Lock Ordering (`ORDER BY warehouse_id FOR UPDATE`)
    // =========================================================================
    const multiWhTxCount = 48;
    const w2LatenciesUs: number[] = [];
    let nextMultiIdx = 0;
    const w2StartNs = process.hrtime.bigint();

    await Promise.all(
      pool.map(async (conn) => {
        while (true) {
          const idx = nextMultiIdx++;
          if (idx >= multiWhTxCount) break;
          const opT0 = process.hrtime.bigint();
          await conn.withTransaction(async (tx) => {
            // Canonical lock ordering (`ORDER BY warehouse_id, variant_id FOR UPDATE`) prevents AB/BA deadlocks
            await tx.query(
              `SELECT id, warehouse_id, quantity_on_hand
               FROM stock_quants
               WHERE warehouse_id IN ($1::uuid, $2::uuid) AND variant_id = $3::uuid
               ORDER BY warehouse_id ASC, variant_id ASC
               FOR UPDATE`,
              [usEastId, usCentralId, variantId]
            );
            await tx.query(
              `UPDATE stock_quants
               SET updated_at = now()
               WHERE warehouse_id IN ($1::uuid, $2::uuid) AND variant_id = $3::uuid`,
              [usEastId, usCentralId, variantId]
            );
          });
          w2LatenciesUs.push(Number(process.hrtime.bigint() - opT0) / 1_000);
        }
      })
    );
    const w2ElapsedSec =
      Number(process.hrtime.bigint() - w2StartNs) / 1_000_000_000;

    // =========================================================================
    // WORKLOAD 3: Parallel Outbox Queue Claim (`FOR UPDATE SKIP LOCKED`)
    // =========================================================================
    await adminConn.query(
      `DELETE FROM transactional_outbox_events WHERE aggregate_type = 'PgBench'`
    );
    await adminConn.query(
      `INSERT INTO transactional_outbox_events (id, event_type, aggregate_type, aggregate_id, channel_slug, payload, status)
       SELECT
         'pgbench-evt-' || g::text,
         'inventory.lock_verified',
         'PgBench',
         'bench_' || g::text,
         'us-retail',
         '{"benchmark":true}'::jsonb,
         'PENDING'
       FROM generate_series(1, $1::integer) AS g`,
      [outboxEventsCount]
    );

    const claimedIds: string[] = [];
    const w3LatenciesUs: number[] = [];
    const workerCount = Math.min(8, pool.length);
    const w3StartNs = process.hrtime.bigint();

    await Promise.all(
      pool.slice(0, workerCount).map(async (conn) => {
        while (true) {
          const opT0 = process.hrtime.bigint();
          const batchIds = await conn.withTransaction(async (tx) => {
            const res = await tx.query<{ id: string }>(`
              UPDATE transactional_outbox_events
              SET status = 'PUBLISHED', attempts = attempts + 1
              WHERE id IN (
                SELECT id
                FROM transactional_outbox_events
                WHERE status = 'PENDING' AND aggregate_type = 'PgBench'
                ORDER BY created_at ASC, id ASC
                LIMIT 2
                FOR UPDATE SKIP LOCKED
              )
              RETURNING id
            `);
            return res.rows.map((r) => r.id);
          });
          if (batchIds.length === 0) {
            break;
          }
          w3LatenciesUs.push(Number(process.hrtime.bigint() - opT0) / 1_000);
          claimedIds.push(...batchIds);
        }
      })
    );
    const w3ElapsedSec =
      Number(process.hrtime.bigint() - w3StartNs) / 1_000_000_000;

    const uniqueClaimedSet = new Set(claimedIds);
    const duplicateClaims = claimedIds.length - uniqueClaimedSet.size;

    // Clean up synthetic benchmark outbox rows
    await adminConn.query(
      `DELETE FROM transactional_outbox_events WHERE aggregate_type = 'PgBench'`
    );

    const postDeadlockRes = await adminConn.query<{ deadlocks: string }>(`
      SELECT coalesce(sum(deadlocks), 0)::text AS deadlocks
      FROM pg_stat_database
      WHERE datname = current_database()
    `);
    const deadlocksAfter = Number(postDeadlockRes.rows[0]?.deadlocks ?? 0);
    const deadlocksDetected = Math.max(0, deadlocksAfter - deadlocksBefore);

    const workload2: PgConcurrencyWorkloadMetrics = {
      id: "ORDER_BY_LOCK_DEADLOCK_GUARD",
      title: `Multi-Warehouse Canonical Lock Ordering (${multiWhTxCount} Concurrent 2-Hub Locks)`,
      sqlPattern: "SELECT ... FROM stock_quants WHERE warehouse_id IN ($1,$2) ORDER BY warehouse_id, variant_id FOR UPDATE;",
      concurrency: poolSize,
      totalOperations: multiWhTxCount,
      succeededCount: multiWhTxCount,
      rejectedCount: 0,
      throughputOpsPerSec: Math.round(multiWhTxCount / Math.max(0.0001, w2ElapsedSec)),
      p50LatencyUs: computePercentileUs(w2LatenciesUs, 50),
      p99LatencyUs: computePercentileUs(w2LatenciesUs, 99),
      invariantSummary: `${multiWhTxCount}/${multiWhTxCount} Committed | Deadlocks (40P01): ${deadlocksDetected}`,
      invariantPassed: deadlocksDetected === 0,
    };

    const workload3: PgConcurrencyWorkloadMetrics = {
      id: "SKIP_LOCKED_OUTBOX_QUEUE",
      title: `Parallel Worker Queue Claim (${workerCount} Workers -> ${outboxEventsCount} Outbox Events)`,
      sqlPattern: "UPDATE transactional_outbox_events ... WHERE id IN (SELECT id ... LIMIT 2 FOR UPDATE SKIP LOCKED) RETURNING id;",
      concurrency: workerCount,
      totalOperations: outboxEventsCount,
      succeededCount: uniqueClaimedSet.size,
      rejectedCount: duplicateClaims,
      throughputOpsPerSec: Math.round(outboxEventsCount / Math.max(0.0001, w3ElapsedSec)),
      p50LatencyUs: computePercentileUs(w3LatenciesUs, 50),
      p99LatencyUs: computePercentileUs(w3LatenciesUs, 99),
      invariantSummary: `Claimed ${uniqueClaimedSet.size}/${outboxEventsCount} Unique | Duplicate Claims: ${duplicateClaims}`,
      invariantPassed:
        uniqueClaimedSet.size === outboxEventsCount && duplicateClaims === 0,
    };

    for (const c of pool) {
      await c.close().catch(() => {});
    }

    const totalWallTimeMs =
      Math.round((Number(process.hrtime.bigint() - suiteStartNs) / 1_000_000) * 10) /
      10;

    const report: PgForUpdateStressReport = {
      connected: true,
      containerName: "super-postgres",
      endpoint: `${host}:${port}`,
      serverVersion: `PostgreSQL ${metaRow.pg_version}`,
      poolConnections: poolSize,
      flashSaleInitialStock: flashSaleStock,
      flashSaleConcurrentBuyers: flashSaleBuyers,
      flashSaleFulfilled: flashFulfilled,
      flashSaleRejected: flashRejected,
      flashSaleOversoldUnits: oversoldUnits,
      outboxTotalSeeded: outboxEventsCount,
      outboxUniqueClaimed: uniqueClaimedSet.size,
      outboxDuplicateClaims: duplicateClaims,
      deadlocksDetected,
      totalWallTimeMs,
      workloads: [workload1, workload2, workload3],
      executedAtIso: new Date().toISOString(),
    };

    cachedPgStressReport = report;
    return report;
  } catch {
    for (const c of pool) {
      await c.close().catch(() => {});
    }
    return {
      connected: false,
      containerName: "super-postgres",
      endpoint: `${host}:${port}`,
      serverVersion: "OFFLINE",
      poolConnections: 0,
      flashSaleInitialStock: flashSaleStock,
      flashSaleConcurrentBuyers: flashSaleBuyers,
      flashSaleFulfilled: 0,
      flashSaleRejected: 0,
      flashSaleOversoldUnits: 0,
      outboxTotalSeeded: outboxEventsCount,
      outboxUniqueClaimed: 0,
      outboxDuplicateClaims: 0,
      deadlocksDetected: 0,
      totalWallTimeMs: 0,
      workloads: [],
      executedAtIso: new Date().toISOString(),
    };
  }
}

export interface PgOutboxMirrorSnapshot {
  readonly connected: boolean;
  readonly pgPublishedCount: number;
  readonly pgPendingCount: number;
  readonly pgDeadLetterCount: number;
  readonly pgSelfHealedCount: number;
}

export async function syncOutboxEventsToPostgres(
  events: readonly {
    readonly id: string;
    readonly eventType: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly channelSlug?: string;
    readonly status: "PENDING" | "PUBLISHED" | "DEAD_LETTER";
    readonly attempts: number;
    readonly nextAttemptAt: string;
    readonly lastError?: string;
    readonly deliveredAt?: string;
    readonly createdAt: string;
  }[],
  options?: { pool?: PgPoolLike }
): Promise<PgOutboxMirrorSnapshot> {
  if (options?.pool) {
    const p = options.pool;
    try {
      for (const evt of events) {
        await p.query(
          `INSERT INTO transactional_outbox_events (
             id, event_type, aggregate_type, aggregate_id, channel_slug,
             payload, status, attempts, next_attempt_at, last_error, delivered_at, created_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6::jsonb, $7, $8::integer, $9::timestamptz, $10, $11::timestamptz, $12::timestamptz
           )
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             attempts = EXCLUDED.attempts,
             next_attempt_at = EXCLUDED.next_attempt_at,
             last_error = EXCLUDED.last_error,
             delivered_at = EXCLUDED.delivered_at`,
          [
            evt.id,
            evt.eventType,
            evt.aggregateType,
            evt.aggregateId,
            evt.channelSlug ?? "us-retail",
            JSON.stringify({ aggregateId: evt.aggregateId, eventType: evt.eventType }),
            evt.status,
            evt.attempts,
            evt.nextAttemptAt,
            evt.lastError ?? null,
            evt.deliveredAt ?? null,
            evt.createdAt,
          ]
        );
      }

      const res = await p.query<{
        published: string;
        pending: string;
        dead_letter: string;
        self_healed: string;
      }>(`
        SELECT
          count(*) FILTER (WHERE status = 'PUBLISHED')::text AS published,
          count(*) FILTER (WHERE status = 'PENDING')::text AS pending,
          count(*) FILTER (WHERE status = 'DEAD_LETTER')::text AS dead_letter,
          count(*) FILTER (WHERE status = 'PUBLISHED' AND attempts > 1)::text AS self_healed
        FROM transactional_outbox_events
      `);
      const row = res.rows[0];
      return {
        connected: true,
        pgPublishedCount: Number(row?.published ?? 0),
        pgPendingCount: Number(row?.pending ?? 0),
        pgDeadLetterCount: Number(row?.dead_letter ?? 0),
        pgSelfHealedCount: Number(row?.self_healed ?? 0),
      };
    } catch {
      return {
        connected: false,
        pgPublishedCount: 0,
        pgPendingCount: 0,
        pgDeadLetterCount: 0,
        pgSelfHealedCount: 0,
      };
    }
  }

  const host = process.env["SUPER_PG_HOST"] ?? "127.0.0.1";
  const port = Number(process.env["SUPER_PG_PORT"] ?? "5438");
  const user = process.env["SUPER_PG_USER"] ?? "super";
  const password = process.env["SUPER_PG_PASSWORD"] ?? "superpassword";
  const database = process.env["SUPER_PG_DB"] ?? "super_ecommerce";

  const client = new PgWireClient({ host, port, user, password, database });
  try {
    await client.connect();
    for (const evt of events) {
      await client.query(
        `INSERT INTO transactional_outbox_events (
           id, event_type, aggregate_type, aggregate_id, channel_slug,
           payload, status, attempts, next_attempt_at, last_error, delivered_at, created_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6::jsonb, $7, $8::integer, $9::timestamptz, $10, $11::timestamptz, $12::timestamptz
         )
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           attempts = EXCLUDED.attempts,
           next_attempt_at = EXCLUDED.next_attempt_at,
           last_error = EXCLUDED.last_error,
           delivered_at = EXCLUDED.delivered_at`,
        [
          evt.id,
          evt.eventType,
          evt.aggregateType,
          evt.aggregateId,
          evt.channelSlug ?? "us-retail",
          JSON.stringify({ aggregateId: evt.aggregateId, eventType: evt.eventType }),
          evt.status,
          evt.attempts,
          evt.nextAttemptAt,
          evt.lastError ?? null,
          evt.deliveredAt ?? null,
          evt.createdAt,
        ]
      );
    }

    const res = await client.query<{
      published: string;
      pending: string;
      dead_letter: string;
      self_healed: string;
    }>(`
      SELECT
        count(*) FILTER (WHERE status = 'PUBLISHED')::text AS published,
        count(*) FILTER (WHERE status = 'PENDING')::text AS pending,
        count(*) FILTER (WHERE status = 'DEAD_LETTER')::text AS dead_letter,
        count(*) FILTER (WHERE status = 'PUBLISHED' AND attempts > 1)::text AS self_healed
      FROM transactional_outbox_events
    `);
    await client.close();
    const row = res.rows[0];
    return {
      connected: true,
      pgPublishedCount: Number(row?.published ?? 0),
      pgPendingCount: Number(row?.pending ?? 0),
      pgDeadLetterCount: Number(row?.dead_letter ?? 0),
      pgSelfHealedCount: Number(row?.self_healed ?? 0),
    };
  } catch {
    await client.close().catch(() => {});
    return {
      connected: false,
      pgPublishedCount: 0,
      pgPendingCount: 0,
      pgDeadLetterCount: 0,
      pgSelfHealedCount: 0,
    };
  }
}

export interface PgWorkflowMirrorSnapshot {
  readonly connected: boolean;
  readonly pgCompletedRuns: number;
  readonly pgCompensatedRuns: number;
  readonly pgTotalStepLogs: number;
  readonly pgCompensatedStepLogs: number;
}

export async function syncWorkflowRunsToPostgres(
  runs: readonly {
    readonly id: string;
    readonly workflowName: string;
    readonly idempotencyKey: string;
    readonly status: "RUNNING" | "COMPLETED" | "COMPENSATING" | "COMPENSATED" | "FAILED";
    readonly errorMessage?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly steps: readonly {
      readonly stepName: string;
      readonly stepOrder: number;
      readonly status: "COMPLETED" | "COMPENSATED" | "FAILED";
    }[];
  }[],
  options?: { pool?: PgPoolLike }
): Promise<PgWorkflowMirrorSnapshot> {
  if (options?.pool) {
    const p = options.pool;
    try {
      for (const run of runs) {
        const upsertRunRes = await p.query<{ id: string }>(
          `INSERT INTO workflow_runs (
             workflow_name, idempotency_key, status, input_payload,
             error_message, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz
           )
           ON CONFLICT (idempotency_key) DO UPDATE SET
             status = EXCLUDED.status,
             error_message = EXCLUDED.error_message,
             updated_at = EXCLUDED.updated_at
           RETURNING id`,
          [
            run.workflowName,
            run.idempotencyKey,
            run.status,
            JSON.stringify({ idempotencyKey: run.idempotencyKey, workflowName: run.workflowName }),
            run.errorMessage ?? null,
            run.createdAt,
            run.updatedAt,
          ]
        );
        const pgRunUuid = upsertRunRes.rows[0]?.id;
        if (pgRunUuid) {
          for (const step of run.steps) {
            await p.query(
              `INSERT INTO workflow_step_logs (
                 workflow_run_id, step_name, step_order, status
               ) VALUES ($1, $2, $3, $4)
               ON CONFLICT (workflow_run_id, step_name) DO UPDATE SET
                 status = EXCLUDED.status`,
              [pgRunUuid, step.stepName, step.stepOrder, step.status]
            );
          }
        }
      }

      const res = await p.query<{
        completed: string;
        compensated: string;
        failed: string;
        step_logs: string;
      }>(`
        SELECT
          count(*) FILTER (WHERE status = 'COMPLETED')::text AS completed,
          count(*) FILTER (WHERE status = 'COMPENSATED')::text AS compensated,
          count(*) FILTER (WHERE status = 'FAILED')::text AS failed,
          (SELECT count(*)::text FROM workflow_step_logs) AS step_logs
        FROM workflow_runs
      `);
      const row = res.rows[0];
      return {
        connected: true,
        pgCompletedCount: Number(row?.completed ?? 0),
        pgCompensatedCount: Number(row?.compensated ?? 0),
        pgFailedCount: Number(row?.failed ?? 0),
        pgStepLogsCount: Number(row?.step_logs ?? 0),
      };
    } catch {
      return {
        connected: false,
        pgCompletedCount: 0,
        pgCompensatedCount: 0,
        pgFailedCount: 0,
        pgStepLogsCount: 0,
      };
    }
  }

  const host = process.env["SUPER_PG_HOST"] ?? "127.0.0.1";
  const port = Number(process.env["SUPER_PG_PORT"] ?? "5438");
  const user = process.env["SUPER_PG_USER"] ?? "super";
  const password = process.env["SUPER_PG_PASSWORD"] ?? "superpassword";
  const database = process.env["SUPER_PG_DB"] ?? "super_ecommerce";

  const client = new PgWireClient({ host, port, user, password, database });
  try {
    await client.connect();
    for (const run of runs) {
      const upsertRunRes = await client.query<{ id: string }>(
        `INSERT INTO workflow_runs (
           workflow_name, idempotency_key, status, input_payload,
           error_message, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz
         )
         ON CONFLICT (idempotency_key) DO UPDATE SET
           status = EXCLUDED.status,
           error_message = EXCLUDED.error_message,
           updated_at = EXCLUDED.updated_at
         RETURNING id`,
        [
          run.workflowName,
          run.idempotencyKey,
          run.status,
          JSON.stringify({ idempotencyKey: run.idempotencyKey, workflowName: run.workflowName }),
          run.errorMessage ?? null,
          run.createdAt,
          run.updatedAt,
        ]
      );
      const pgRunUuid = upsertRunRes.rows[0]?.id;
      if (pgRunUuid) {
        for (const step of run.steps) {
          await client.query(
            `INSERT INTO workflow_step_logs (
               workflow_run_id, step_name, step_order, status, output_payload
             ) VALUES (
               $1::uuid, $2, $3::integer, $4, $5::jsonb
             )
             ON CONFLICT (workflow_run_id, step_name) DO UPDATE SET
               step_order = EXCLUDED.step_order,
               status = EXCLUDED.status,
               output_payload = EXCLUDED.output_payload`,
            [
              pgRunUuid,
              step.stepName,
              step.stepOrder,
              step.status,
              JSON.stringify({ stepName: step.stepName, status: step.status }),
            ]
          );
        }
      }
    }

    const res = await client.query<{
      completed_runs: string;
      compensated_runs: string;
      total_steps: string;
      compensated_steps: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM workflow_runs WHERE status = 'COMPLETED') AS completed_runs,
        (SELECT count(*)::text FROM workflow_runs WHERE status = 'COMPENSATED') AS compensated_runs,
        (SELECT count(*)::text FROM workflow_step_logs) AS total_steps,
        (SELECT count(*)::text FROM workflow_step_logs WHERE status = 'COMPENSATED') AS compensated_steps
    `);
    await client.close();
    const row = res.rows[0];
    return {
      connected: true,
      pgCompletedRuns: Number(row?.completed_runs ?? 0),
      pgCompensatedRuns: Number(row?.compensated_runs ?? 0),
      pgTotalStepLogs: Number(row?.total_steps ?? 0),
      pgCompensatedStepLogs: Number(row?.compensated_steps ?? 0),
    };
  } catch {
    await client.close().catch(() => {});
    return {
      connected: false,
      pgCompletedRuns: 0,
      pgCompensatedRuns: 0,
      pgTotalStepLogs: 0,
      pgCompensatedStepLogs: 0,
    };
  }
}

export interface PgConfiguratorMirrorSnapshot {
  readonly connected: boolean;
  readonly pgWarehousesCount: number;
  readonly pgChannelsCount: number;
  readonly pgProductTypesCount: number;
  readonly pgProductsCount: number;
  readonly pgVariantsCount: number;
  readonly syncLatencyUs: number;
}

export async function syncStoreConfigToPostgres(state: {
  readonly warehouses: readonly {
    readonly slug: string;
    readonly name: string;
    readonly countryCode: string;
  }[];
  readonly channels: readonly {
    readonly slug: string;
    readonly name: string;
    readonly currencyCode: string;
    readonly defaultCountry: string;
    readonly taxInclusionMode?: string;
    readonly stockAvailabilityMode?: string;
    readonly allocationStrategy?: string;
  }[];
  readonly productTypes: readonly {
    readonly slug: string;
    readonly name: string;
    readonly isShippingRequired?: boolean;
    readonly productAttributesSchema: readonly unknown[];
    readonly variantAttributesSchema: readonly unknown[];
  }[];
  readonly products: readonly {
    readonly slug: string;
    readonly name: string;
    readonly productTypeSlug: string;
    readonly attributes: Record<string, unknown>;
    readonly variants: readonly {
      readonly sku: string;
      readonly name: string;
      readonly attributes: Record<string, unknown>;
    }[];
  }[];
},
options?: { pool?: PgPoolLike }
): Promise<PgConfiguratorMirrorSnapshot> {
  const host = process.env["SUPER_PG_HOST"] ?? "127.0.0.1";
  const port = Number(process.env["SUPER_PG_PORT"] ?? "5438");
  const user = process.env["SUPER_PG_USER"] ?? "super";
  const password = process.env["SUPER_PG_PASSWORD"] ?? "superpassword";
  const database = process.env["SUPER_PG_DB"] ?? "super_ecommerce";

  const poolClient = options?.pool;
  const client =
    poolClient ??
    new PgWireClient({ host, port, user, password, database });
  const t0 = process.hrtime.bigint();
  try {
    if (!poolClient) {
      await (client as PgWireClient).connect();
    }

    // Stage 2: Warehouses
    for (const wh of state.warehouses) {
      await client.query(
        `INSERT INTO warehouses (slug, name, country_code)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           country_code = EXCLUDED.country_code`,
        [wh.slug, wh.name, wh.countryCode]
      );
    }

    // Stage 3: Channels
    for (const ch of state.channels) {
      await client.query(
        `INSERT INTO channels (
           slug, name, currency_code, default_country,
           tax_inclusion_mode, stock_availability_mode, allocation_strategy
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           currency_code = EXCLUDED.currency_code,
           default_country = EXCLUDED.default_country,
           tax_inclusion_mode = EXCLUDED.tax_inclusion_mode,
           stock_availability_mode = EXCLUDED.stock_availability_mode,
           allocation_strategy = EXCLUDED.allocation_strategy`,
        [
          ch.slug,
          ch.name,
          ch.currencyCode,
          ch.defaultCountry,
          ch.taxInclusionMode ?? "TAX_EXCLUSIVE",
          ch.stockAvailabilityMode ?? "DIRECT_CHANNEL_WAREHOUSES",
          ch.allocationStrategy ?? "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        ]
      );
    }

    // Stage 4: ProductTypes
    for (const pt of state.productTypes) {
      await client.query(
        `INSERT INTO product_types (
           slug, name, is_shipping_required, is_digital,
           product_attributes_schema, variant_attributes_schema
         ) VALUES ($1, $2, $3::boolean, false, $4::jsonb, $5::jsonb)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           is_shipping_required = EXCLUDED.is_shipping_required,
           product_attributes_schema = EXCLUDED.product_attributes_schema,
           variant_attributes_schema = EXCLUDED.variant_attributes_schema`,
        [
          pt.slug,
          pt.name,
          String(pt.isShippingRequired ?? true),
          JSON.stringify(pt.productAttributesSchema),
          JSON.stringify(pt.variantAttributesSchema),
        ]
      );
    }

    // Stage 5: Products & ProductVariants
    for (const prod of state.products) {
      const pRes = await client.query<{ id: string }>(
        `INSERT INTO products (product_type_id, slug, name, attributes)
         SELECT id, $1, $2, $3::jsonb
         FROM product_types WHERE slug = $4
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           attributes = EXCLUDED.attributes
         RETURNING id`,
        [
          prod.slug,
          prod.name,
          JSON.stringify(prod.attributes),
          prod.productTypeSlug,
        ]
      );
      const prodUuid = pRes.rows[0]?.id;
      if (prodUuid) {
        for (const v of prod.variants) {
          await client.query(
            `INSERT INTO product_variants (product_id, sku, name, weight_grams, attributes)
             VALUES ($1::uuid, $2, $3, 1200, $4::jsonb)
             ON CONFLICT (sku) DO UPDATE SET
               name = EXCLUDED.name,
               attributes = EXCLUDED.attributes`,
            [prodUuid, v.sku, v.name, JSON.stringify(v.attributes)]
          );
        }
      }
    }

    const countsRes = await client.query<{
      wh_count: string;
      ch_count: string;
      pt_count: string;
      pr_count: string;
      vr_count: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM warehouses) AS wh_count,
        (SELECT count(*)::text FROM channels) AS ch_count,
        (SELECT count(*)::text FROM product_types) AS pt_count,
        (SELECT count(*)::text FROM products) AS pr_count,
        (SELECT count(*)::text FROM product_variants) AS vr_count
    `);
    if (!poolClient) {
      await (client as PgWireClient).close();
    }
    const row = countsRes.rows[0];
    const syncLatencyUs =
      Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;

    return {
      connected: true,
      pgWarehousesCount: Number(row?.wh_count ?? 0),
      pgChannelsCount: Number(row?.ch_count ?? 0),
      pgProductTypesCount: Number(row?.pt_count ?? 0),
      pgProductsCount: Number(row?.pr_count ?? 0),
      pgVariantsCount: Number(row?.vr_count ?? 0),
      syncLatencyUs,
    };
  } catch {
    if (!poolClient) {
      await (client as PgWireClient).close().catch(() => {});
    }
    return {
      connected: false,
      pgWarehousesCount: 0,
      pgChannelsCount: 0,
      pgProductTypesCount: 0,
      pgProductsCount: 0,
      pgVariantsCount: 0,
      syncLatencyUs: 0,
    };
  }
}

export async function bootstrapAndProbeAppleContainerPg(options?: {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}): Promise<AppleContainerPgStatus> {
  const host = options?.host ?? process.env["SUPER_PG_HOST"] ?? "127.0.0.1";
  const port = options?.port ?? Number(process.env["SUPER_PG_PORT"] ?? "5438");
  const user = options?.user ?? process.env["SUPER_PG_USER"] ?? "super";
  const password =
    options?.password ?? process.env["SUPER_PG_PASSWORD"] ?? "superpassword";
  const database =
    options?.database ?? process.env["SUPER_PG_DB"] ?? "super_ecommerce";

  const client = new PgWireClient({
    host,
    port,
    user,
    password,
    database,
  });

  try {
    await client.connect();

    // 1. Apply PostgreSQL 17 DDL migration idempotently
    const ddlPath = join(__dirname, "../migrations/0001_phase1_core_schema.sql");
    const ddlSql = readFileSync(ddlPath, "utf8");
    await client.query(ddlSql);

    // 2. Seed baseline Channel, Warehouses, ProductType, Product, Variants, and Stock Quants idempotently
    await client.query(`
      INSERT INTO channels (slug, name, currency_code, default_country, tax_inclusion_mode, stock_availability_mode, allocation_strategy)
      VALUES ('us-retail', 'US Flagship Store', 'USD', 'US', 'TAX_EXCLUSIVE', 'DIRECT_CHANNEL_WAREHOUSES', 'MINIMIZE_SPLIT_THEN_HIGH_STOCK')
      ON CONFLICT (slug) DO NOTHING;

      INSERT INTO warehouses (slug, name, country_code)
      VALUES
        ('us-east', 'US East Fulfillment Hub (NJ)', 'US'),
        ('us-central', 'US Central Fulfillment Hub (TX)', 'US')
      ON CONFLICT (slug) DO NOTHING;

      INSERT INTO product_types (slug, name, is_shipping_required, is_digital, product_attributes_schema, variant_attributes_schema)
      VALUES (
        'precision-hardware',
        'Precision Hardware',
        true,
        false,
        '[{"slug":"chassis_material","name":"Chassis","type":"ENUM","required":true}]'::jsonb,
        '[{"slug":"switch_type","name":"Switch","type":"ENUM","required":false}]'::jsonb
      )
      ON CONFLICT (slug) DO NOTHING;

      INSERT INTO products (product_type_id, slug, name, attributes)
      SELECT id, 'kronos-cnc-keyboard', 'Kronos 75% CNC Titanium Mechanical Keyboard', '{"chassis_material":"grade-5-titanium","mount_style":"gasket-isolated"}'::jsonb
      FROM product_types WHERE slug = 'precision-hardware'
      ON CONFLICT (slug) DO NOTHING;

      INSERT INTO product_variants (product_id, sku, name, weight_grams, attributes)
      SELECT id, 'KR-KB75-TI', 'Kronos 75% Titanium / Linear 45g', 1850, '{"switch_type":"linear-45g","wireless_8k":true}'::jsonb
      FROM products WHERE slug = 'kronos-cnc-keyboard'
      ON CONFLICT (sku) DO NOTHING;

      INSERT INTO stock_quants (warehouse_id, variant_id, quantity_on_hand, quantity_reserved, quantity_allocated)
      SELECT w.id, v.id, 6, 0, 0
      FROM warehouses w CROSS JOIN product_variants v
      WHERE w.slug = 'us-east' AND v.sku = 'KR-KB75-TI'
      ON CONFLICT (warehouse_id, variant_id) DO NOTHING;

      INSERT INTO stock_quants (warehouse_id, variant_id, quantity_on_hand, quantity_reserved, quantity_allocated)
      SELECT w.id, v.id, 25, 1, 0
      FROM warehouses w CROSS JOIN product_variants v
      WHERE w.slug = 'us-central' AND v.sku = 'KR-KB75-TI'
      ON CONFLICT (warehouse_id, variant_id) DO NOTHING;
    `);

    // 3. Introspect PostgreSQL version, table count, and GIN index count
    const metaRes = await client.query<{
      pg_version: string;
      table_count: string;
      gin_index_count: string;
    }>(`
      SELECT
        current_setting('server_version') AS pg_version,
        (SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'public') AS table_count,
        (SELECT count(*)::text FROM pg_indexes WHERE schemaname = 'public' AND indexdef ILIKE '%USING gin%') AS gin_index_count
    `);

    const meta = metaRes.rows[0];

    // 4. Measure real BEGIN ... SELECT FOR UPDATE SKIP LOCKED ... COMMIT latency
    const t0 = process.hrtime.bigint();
    const lockedRows = await client.withTransaction(async (tx) => {
      const res = await tx.query<{
        warehouse_slug: string;
        sku: string;
        quantity_on_hand: string;
        quantity_reserved: string;
        quantity_allocated: string;
        available_qty: string;
      }>(`
        SELECT
          w.slug AS warehouse_slug,
          v.sku AS sku,
          sq.quantity_on_hand::text,
          sq.quantity_reserved::text,
          sq.quantity_allocated::text,
          (sq.quantity_on_hand - sq.quantity_reserved - sq.quantity_allocated)::text AS available_qty
        FROM stock_quants sq
        JOIN warehouses w ON w.id = sq.warehouse_id
        JOIN product_variants v ON v.id = sq.variant_id
        WHERE v.sku = $1
        ORDER BY w.slug DESC
        FOR UPDATE OF sq SKIP LOCKED
      `, ["KR-KB75-TI"]);
      return res.rows;
    });
    const elapsedUs = Number(process.hrtime.bigint() - t0) / 1_000;

    await client.close();

    return {
      connected: true,
      containerName: "super-postgres",
      endpoint: `${host}:${port}`,
      database,
      serverVersion: `PostgreSQL ${meta?.pg_version ?? "16"}`,
      tableCount: Number(meta?.table_count ?? 0),
      ginIndexCount: Number(meta?.gin_index_count ?? 0),
      lockedStockRows: lockedRows,
      forUpdateLatencyUs: Math.round(elapsedUs * 10) / 10,
    };
  } catch (err) {
    await client.close().catch(() => {});
    return {
      connected: false,
      containerName: "super-postgres",
      endpoint: `${host}:${port}`,
      database,
      serverVersion: "OFFLINE",
      tableCount: 0,
      ginIndexCount: 0,
      lockedStockRows: [],
      forUpdateLatencyUs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapAndProbeAppleContainerPg().then((status) => {
    console.log(JSON.stringify(status, null, 2));
    if (!status.connected) {
      process.exitCode = 1;
    }
  });
}
