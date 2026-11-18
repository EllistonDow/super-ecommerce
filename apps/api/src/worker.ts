/**
 * Autonomous Background Maintenance & Event Relay Daemon (`apps/api/src/worker.ts`).
 *
 * Cleanly separated from stateless HTTP API traffic so horizontal API scaling never duplicates
 * background timers. Coordinates 3 `SKIP LOCKED` / lease-safe PostgreSQL workers:
 * 1. `OutboxRelayWorker`          -> Delivers signed `transactional_outbox_events` with backoff & DLQ
 * 2. `PgReservationTtlReaperService` -> Reclaims expired MSI stock holds & timed-out B2B POs
 * 3. `SagaRecoveryWorker`         -> Resumes or LIFO-compensates orphaned `RUNNING`/`COMPENSATING` Sagas
 */

import { pathToFileURL } from "node:url";
import { OfflinePgPool, PgPool, runMigrations, type PgPoolLike } from "@super-ecommerce/db";
import { PgWorkflowStateStore, SagaRecoveryWorker } from "@super-ecommerce/workflow";
import {
  buildCompleteCheckoutWorkflow,
  buildProcessReturnRefundWorkflow,
  OutboxRelayWorker,
  PgB2bOrganizationService,
  PgMsiInventoryService,
  PgReservationTtlReaperService,
  PgTransactionalOutboxService,
  type OutboxDrainSummary,
  type OutboxSubscriber,
  type PaymentGatewayStrategy,
  type ReapReservationsResult,
} from "@super-ecommerce/core";

export interface BackgroundDaemonOptions {
  readonly pgPool?: PgPoolLike;
  readonly pollIntervalMs?: number;
  readonly outboxSigningSecret?: string;
  readonly outboxSubscribers?: readonly OutboxSubscriber[];
  readonly paymentGateway?: PaymentGatewayStrategy;
}

export interface BackgroundCycleSummary {
  readonly outbox: OutboxDrainSummary;
  readonly reservationsReaped: ReapReservationsResult;
  readonly sagasRecoveredCount: number;
}

export function createBackgroundMaintenanceDaemon(options: BackgroundDaemonOptions = {}) {
  const pgPool =
    options.pgPool ??
    (process.env["SUPER_PG_USE_WIRE"] === "1" ? PgPool.fromEnv() : new OfflinePgPool());
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 2_000);

  const inventoryService = new PgMsiInventoryService(pgPool);
  const outboxService = new PgTransactionalOutboxService(pgPool);
  const workflowStore = new PgWorkflowStateStore(pgPool);
  const b2bService = new PgB2bOrganizationService({
    pool: pgPool,
    inventoryService,
    outboxService,
    workflowStateStore: workflowStore,
  });

  const defaultPaymentGateway: PaymentGatewayStrategy =
    options.paymentGateway ?? {
      async capture({ checkoutId, amount }) {
        return {
          transactionId: `tx_${checkoutId}`,
          provider: "super-pay",
          capturedAmount: amount,
        };
      },
      async voidOrRefund() {},
    };

  const checkoutWf = buildCompleteCheckoutWorkflow({
    inventoryService,
    paymentGateway: defaultPaymentGateway,
    outboxService,
    pgPool,
  });
  const rmaWf = buildProcessReturnRefundWorkflow({
    inventoryService,
    paymentGateway: defaultPaymentGateway,
    outboxService,
    pgPool,
  });

  const outboxWorker = new OutboxRelayWorker({
    outboxService,
    signingSecret:
      options.outboxSigningSecret ?? process.env["SUPER_OUTBOX_SIGNING_SECRET"],
    subscribers: options.outboxSubscribers ?? [],
  });
  const reaperService = new PgReservationTtlReaperService({
    pool: pgPool,
    inventoryService,
    b2bService,
    outboxService,
  });
  const sagaRecovery = new SagaRecoveryWorker({
    store: workflowStore,
    workflows: [checkoutWf, rmaWf],
  });

  let initialized = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let cycleInFlight = false;

  async function ensureReady(): Promise<void> {
    if (initialized) return;
    await runMigrations(pgPool);
    initialized = true;
  }

  async function runSingleCycle(nowMs = Date.now()): Promise<BackgroundCycleSummary> {
    await ensureReady();
    const outbox = await outboxWorker.drainBatch({ nowMs, batchSize: 50 });
    const reapReport = await reaperService.reapExpired(nowMs, { limit: 100 });
    const sagaReport = await sagaRecovery.recoverOrphanedRuns({ nowMs, limit: 25 });

    return {
      outbox,
      reservationsReaped: reapReport.msiReapResult,
      sagasRecoveredCount: sagaReport.recoveredCount,
    };
  }

  async function start(): Promise<void> {
    await ensureReady();
    if (timer) return;
    timer = setInterval(() => {
      if (cycleInFlight) return;
      cycleInFlight = true;
      void runSingleCycle()
        .catch((err) => {
          process.stderr.write(
            `[super-ecommerce/worker] cycle error: ${err instanceof Error ? err.message : String(err)}\n`
          );
        })
        .finally(() => {
          cycleInFlight = false;
        });
    }, pollIntervalMs);
    timer.unref?.();
  }

  async function stop(closePool = false): Promise<void> {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (closePool) {
      await pgPool.close();
    }
  }

  return {
    pgPool,
    outboxWorker,
    reaperService,
    sagaRecovery,
    runSingleCycle,
    start,
    stop,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const daemon = createBackgroundMaintenanceDaemon();
  void daemon.start().then(() => {
    process.stdout.write("[super-ecommerce/worker] Autonomous maintenance daemon started\n");
    const shutdown = () => {
      void daemon.stop(true).finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
