/**
 * `@super-ecommerce/workflow`
 *
 * PostgreSQL-backed Durable Saga Workflow Engine inspired by Temporal, DBOS, and Medusa v2.
 *
 * Core Guarantees:
 * 1. Step-level Persistence & Crash Replay: Every completed step persists its output in
 *    `workflow_step_logs`. If a process restarts mid-flight and re-runs with the same
 *    `idempotencyKey`, already-completed steps return their persisted output without
 *    re-triggering external side effects (e.g. double-charging a credit card).
 * 2. Atomic Mutual-Exclusion Leases (`locked_by`, `lease_expires_at`): Prevents concurrent
 *    duplicate `idempotencyKey` requests from racing and double-executing side-effect steps.
 * 3. Autonomous Zombie Run Recovery (`SagaRecoveryWorker`): Scans orphaned `RUNNING` /
 *    `COMPENSATING` runs whose lease has expired and drives them to completion or LIFO rollback.
 * 4. Reverse-Order Saga Compensation: When a step fails permanently, all previously
 *    completed steps in the run are compensated in strict LIFO (reverse) order.
 */

import { randomUUID } from "node:crypto";
import {
  deserializeWithBigInt,
  serializeWithBigInt,
  type PgPoolLike,
} from "@super-ecommerce/db";

export type WorkflowRunStatus =
  | "RUNNING"
  | "COMPLETED"
  | "COMPENSATING"
  | "COMPENSATED"
  | "FAILED";

export type WorkflowStepStatus = "COMPLETED" | "COMPENSATED" | "FAILED";

export class WorkflowConcurrentExecutionError extends Error {
  readonly idempotencyKey: string;
  readonly runId: string;

  constructor(params: { idempotencyKey: string; runId: string }) {
    super(
      `Workflow run '${params.runId}' (idempotencyKey='${params.idempotencyKey}') is already actively leased by another execution`
    );
    this.name = "WorkflowConcurrentExecutionError";
    this.idempotencyKey = params.idempotencyKey;
    this.runId = params.runId;
  }
}

/**
 * Sentinel error for chaos/crash testing: simulates an abrupt OS `SIGKILL` / container crash
 * mid-workflow (terminates execution immediately WITHOUT releasing the lease or running
 * in-process compensation, leaving recovery to `SagaRecoveryWorker` once the lease expires).
 */
export class ProcessCrashSimulatedError extends Error {
  constructor(message = "SIMULATED_PROCESS_CRASH_SIGKILL") {
    super(message);
    this.name = "ProcessCrashSimulatedError";
  }
}

export interface PersistedStepLog<TOutput = unknown> {
  readonly stepName: string;
  readonly stepOrder: number;
  readonly status: WorkflowStepStatus;
  readonly outputPayload: TOutput;
}

export interface PersistedWorkflowRun<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly workflowName: string;
  readonly idempotencyKey: string;
  readonly status: WorkflowRunStatus;
  readonly inputPayload: TInput;
  readonly outputPayload?: TOutput;
  readonly errorMessage?: string;
  readonly steps: ReadonlyMap<string, PersistedStepLog>;
}

export interface PersistedWorkflowRunSummary {
  readonly id: string;
  readonly workflowName: string;
  readonly idempotencyKey: string;
  readonly status: WorkflowRunStatus;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly steps: readonly {
    readonly stepName: string;
    readonly stepOrder: number;
    readonly status: WorkflowStepStatus;
  }[];
  readonly compensatedLifoChain: readonly string[];
}

export interface OrphanedWorkflowCandidate {
  readonly id: string;
  readonly workflowName: string;
  readonly idempotencyKey: string;
  readonly status: WorkflowRunStatus;
  readonly inputPayload: unknown;
  readonly attemptCount: number;
}

export interface WorkflowStateStore {
  getOrCreateRun<TInput>(params: {
    workflowName: string;
    idempotencyKey: string;
    input: TInput;
  }): Promise<PersistedWorkflowRun<TInput>>;

  tryAcquireRunLease?(params: {
    runId: string;
    workerId: string;
    leaseDurationMs: number;
    nowMs?: number;
  }): Promise<boolean>;

  listExpiredOrphanRuns?(params?: {
    nowMs?: number;
    limit?: number;
  }): Promise<readonly OrphanedWorkflowCandidate[]>;

  recordStepSuccess<TOutput>(params: {
    runId: string;
    stepName: string;
    stepOrder: number;
    output: TOutput;
  }): Promise<void>;

  recordStepCompensated(params: {
    runId: string;
    stepName: string;
  }): Promise<void>;

  updateRunStatus<TOutput = unknown>(params: {
    runId: string;
    status: WorkflowRunStatus;
    output?: TOutput;
    errorMessage?: string;
    clearLease?: boolean;
  }): Promise<void>;
}

/**
 * Default deterministic in-memory store (also serves as reference for the PG adapter).
 */
export class InMemoryWorkflowStateStore implements WorkflowStateStore {
  private readonly runsByKey = new Map<
    string,
    {
      id: string;
      workflowName: string;
      idempotencyKey: string;
      status: WorkflowRunStatus;
      inputPayload: unknown;
      outputPayload?: unknown;
      errorMessage?: string;
      lockedBy: string | null;
      leaseExpiresAtMs: number | null;
      attemptCount: number;
      steps: Map<string, PersistedStepLog>;
    }
  >();

  private readonly runsById = new Map<
    string,
    {
      id: string;
      workflowName: string;
      idempotencyKey: string;
      status: WorkflowRunStatus;
      inputPayload: unknown;
      outputPayload?: unknown;
      errorMessage?: string;
      lockedBy: string | null;
      leaseExpiresAtMs: number | null;
      attemptCount: number;
      steps: Map<string, PersistedStepLog>;
    }
  >();

  private nextId = 1;

  async getOrCreateRun<TInput>(params: {
    workflowName: string;
    idempotencyKey: string;
    input: TInput;
  }): Promise<PersistedWorkflowRun<TInput>> {
    const existing = this.runsByKey.get(params.idempotencyKey);
    if (existing) {
      return {
        id: existing.id,
        workflowName: existing.workflowName,
        idempotencyKey: existing.idempotencyKey,
        status: existing.status,
        inputPayload: existing.inputPayload as TInput,
        outputPayload: existing.outputPayload,
        errorMessage: existing.errorMessage,
        steps: new Map(existing.steps),
      };
    }

    const id = `wf-run-${this.nextId++}`;
    const record = {
      id,
      workflowName: params.workflowName,
      idempotencyKey: params.idempotencyKey,
      status: "RUNNING" as WorkflowRunStatus,
      inputPayload: params.input,
      lockedBy: null,
      leaseExpiresAtMs: null,
      attemptCount: 0,
      steps: new Map<string, PersistedStepLog>(),
    };
    this.runsByKey.set(params.idempotencyKey, record);
    this.runsById.set(id, record);

    return {
      id: record.id,
      workflowName: record.workflowName,
      idempotencyKey: record.idempotencyKey,
      status: record.status,
      inputPayload: record.inputPayload as TInput,
      steps: new Map(record.steps),
    };
  }

  async tryAcquireRunLease(params: {
    runId: string;
    workerId: string;
    leaseDurationMs: number;
    nowMs?: number;
  }): Promise<boolean> {
    const run = this.runsById.get(params.runId);
    if (!run || run.status === "COMPLETED") return false;
    const now = params.nowMs ?? Date.now();
    if (run.lockedBy !== null && run.leaseExpiresAtMs !== null && run.leaseExpiresAtMs > now) {
      return false;
    }
    run.lockedBy = params.workerId;
    run.leaseExpiresAtMs = now + Math.max(1, params.leaseDurationMs);
    run.attemptCount += 1;
    run.status = "RUNNING";
    return true;
  }

  async listExpiredOrphanRuns(params?: {
    nowMs?: number;
    limit?: number;
  }): Promise<readonly OrphanedWorkflowCandidate[]> {
    const now = params?.nowMs ?? Date.now();
    const limit = Math.max(1, params?.limit ?? 50);
    const out: OrphanedWorkflowCandidate[] = [];
    for (const run of this.runsById.values()) {
      if (run.status !== "RUNNING" && run.status !== "COMPENSATING") continue;
      if (run.lockedBy !== null && run.leaseExpiresAtMs !== null && run.leaseExpiresAtMs > now) {
        continue;
      }
      out.push({
        id: run.id,
        workflowName: run.workflowName,
        idempotencyKey: run.idempotencyKey,
        status: run.status,
        inputPayload: run.inputPayload,
        attemptCount: run.attemptCount,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async recordStepSuccess<TOutput>(params: {
    runId: string;
    stepName: string;
    stepOrder: number;
    output: TOutput;
  }): Promise<void> {
    const run = this.runsById.get(params.runId);
    if (!run) throw new Error(`Workflow run '${params.runId}' not found`);
    run.steps.set(params.stepName, {
      stepName: params.stepName,
      stepOrder: params.stepOrder,
      status: "COMPLETED",
      outputPayload: params.output,
    });
  }

  async recordStepCompensated(params: {
    runId: string;
    stepName: string;
  }): Promise<void> {
    const run = this.runsById.get(params.runId);
    if (!run) throw new Error(`Workflow run '${params.runId}' not found`);
    const existing = run.steps.get(params.stepName);
    if (existing) {
      run.steps.set(params.stepName, {
        ...existing,
        status: "COMPENSATED",
      });
    }
  }

  async updateRunStatus<TOutput = unknown>(params: {
    runId: string;
    status: WorkflowRunStatus;
    output?: TOutput;
    errorMessage?: string;
    clearLease?: boolean;
  }): Promise<void> {
    const run = this.runsById.get(params.runId);
    if (!run) throw new Error(`Workflow run '${params.runId}' not found`);
    run.status = params.status;
    if (params.output !== undefined) {
      run.outputPayload = params.output;
    }
    if (params.errorMessage !== undefined) {
      run.errorMessage = params.errorMessage;
    }
    if (params.clearLease || params.status === "COMPLETED" || params.status === "COMPENSATED") {
      run.lockedBy = null;
      run.leaseExpiresAtMs = null;
    }
  }
}

/**
 * PostgreSQL 17-backed `WorkflowStateStore` (`workflow_runs` + `workflow_step_logs`).
 * Persists every workflow run, mutual-exclusion lease, and step output across concurrent
 * processes with lossless `BigInt` (`MinorUnits`) JSONB serialization.
 */
export class PgWorkflowStateStore implements WorkflowStateStore {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async getOrCreateRun<TInput>(params: {
    workflowName: string;
    idempotencyKey: string;
    input: TInput;
  }): Promise<PersistedWorkflowRun<TInput>> {
    const nowIso = new Date().toISOString();
    const inserted = await this.pool.query<{
      id: string;
      workflow_name: string;
      idempotency_key: string;
      status: WorkflowRunStatus;
      input_payload: string;
      output_payload: string | null;
      error_message: string | null;
    }>(
      `INSERT INTO workflow_runs (id, workflow_name, idempotency_key, status, input_payload, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, 'RUNNING', $4::jsonb, $5::timestamptz, $5::timestamptz)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, workflow_name, idempotency_key, status, input_payload, output_payload, error_message`,
      [
        randomUUID(),
        params.workflowName,
        params.idempotencyKey,
        serializeWithBigInt(params.input === undefined ? null : params.input),
        nowIso,
      ]
    );

    if (inserted.rows.length > 0) {
      const row = inserted.rows[0]!;
      return {
        id: row.id,
        workflowName: row.workflow_name,
        idempotencyKey: row.idempotency_key,
        status: row.status,
        inputPayload: deserializeWithBigInt<TInput>(row.input_payload),
        steps: new Map(),
      };
    }

    return await this.loadExistingRunByKey<TInput>(params.idempotencyKey);
  }

  private async loadExistingRunByKey<TInput>(
    idempotencyKey: string
  ): Promise<PersistedWorkflowRun<TInput>> {
    const existingRes = await this.pool.query<{
      id: string;
      workflow_name: string;
      idempotency_key: string;
      status: WorkflowRunStatus;
      input_payload: string;
      output_payload: string | null;
      error_message: string | null;
    }>(
      `SELECT id, workflow_name, idempotency_key, status, input_payload, output_payload, error_message
       FROM workflow_runs
       WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    const existingRow = existingRes.rows[0];
    if (!existingRow) {
      throw new Error(
        `Workflow run with idempotency_key '${idempotencyKey}' disappeared concurrently`
      );
    }

    const stepRes = await this.pool.query<{
      step_name: string;
      step_order: string;
      status: WorkflowStepStatus;
      output_payload: string | null;
    }>(
      `SELECT step_name, step_order, status, output_payload
       FROM workflow_step_logs
       WHERE workflow_run_id = $1::uuid
       ORDER BY step_order ASC`,
      [existingRow.id]
    );

    const steps = new Map<string, PersistedStepLog>();
    for (const s of stepRes.rows) {
      steps.set(s.step_name, {
        stepName: s.step_name,
        stepOrder: Number(s.step_order),
        status: s.status,
        outputPayload:
          s.output_payload !== null && s.output_payload !== undefined
            ? deserializeWithBigInt(s.output_payload)
            : undefined,
      });
    }

    return {
      id: existingRow.id,
      workflowName: existingRow.workflow_name,
      idempotencyKey: existingRow.idempotency_key,
      status: existingRow.status,
      inputPayload: deserializeWithBigInt<TInput>(existingRow.input_payload),
      outputPayload:
        existingRow.output_payload !== null &&
        existingRow.output_payload !== undefined
          ? deserializeWithBigInt(existingRow.output_payload)
          : undefined,
      errorMessage: existingRow.error_message ?? undefined,
      steps,
    };
  }

  async tryAcquireRunLease(params: {
    runId: string;
    workerId: string;
    leaseDurationMs: number;
    nowMs?: number;
  }): Promise<boolean> {
    const now = params.nowMs ?? Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresIso = new Date(now + Math.max(1, params.leaseDurationMs)).toISOString();

    const updated = await this.pool.query<{ id: string }>(
      `UPDATE workflow_runs
       SET locked_by = $1,
           lease_expires_at = $2::timestamptz,
           attempt_count = attempt_count + 1,
           status = 'RUNNING',
           updated_at = $3::timestamptz
       WHERE id = $4::uuid
         AND status != 'COMPLETED'
         AND (locked_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= $3::timestamptz)
       RETURNING id`,
      [params.workerId, expiresIso, nowIso, params.runId]
    );

    return updated.rows.length > 0;
  }

  async listExpiredOrphanRuns(params?: {
    nowMs?: number;
    limit?: number;
  }): Promise<readonly OrphanedWorkflowCandidate[]> {
    const nowIso = new Date(params?.nowMs ?? Date.now()).toISOString();
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(params?.limit ?? 50)));

    const res = await this.pool.query<{
      id: string;
      workflow_name: string;
      idempotency_key: string;
      status: WorkflowRunStatus;
      input_payload: string;
      attempt_count: string;
    }>(
      `SELECT id, workflow_name, idempotency_key, status, input_payload, attempt_count
       FROM workflow_runs
       WHERE status IN ('RUNNING', 'COMPENSATING')
         AND (locked_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= $1::timestamptz)
       ORDER BY updated_at ASC
       LIMIT $2`,
      [nowIso, safeLimit]
    );

    return res.rows.map((r) => ({
      id: r.id,
      workflowName: r.workflow_name,
      idempotencyKey: r.idempotency_key,
      status: r.status,
      inputPayload: deserializeWithBigInt(r.input_payload),
      attemptCount: Number(r.attempt_count ?? "0"),
    }));
  }

  async recordStepSuccess<TOutput>(params: {
    runId: string;
    stepName: string;
    stepOrder: number;
    output: TOutput;
  }): Promise<void> {
    const payloadJson =
      params.output === undefined ? null : serializeWithBigInt(params.output);
    await this.pool.query(
      `INSERT INTO workflow_step_logs (id, workflow_run_id, step_name, step_order, status, output_payload)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'COMPLETED', $5::jsonb)
       ON CONFLICT (workflow_run_id, step_name) DO UPDATE SET
         status = 'COMPLETED',
         step_order = excluded.step_order,
         output_payload = excluded.output_payload`,
      [randomUUID(), params.runId, params.stepName, params.stepOrder, payloadJson]
    );
  }

  async recordStepCompensated(params: {
    runId: string;
    stepName: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_step_logs
       SET status = 'COMPENSATED'
       WHERE workflow_run_id = $1::uuid AND step_name = $2`,
      [params.runId, params.stepName]
    );
  }

  async updateRunStatus<TOutput = unknown>(params: {
    runId: string;
    status: WorkflowRunStatus;
    output?: TOutput;
    errorMessage?: string;
    clearLease?: boolean;
  }): Promise<void> {
    const payloadJson =
      params.output !== undefined ? serializeWithBigInt(params.output) : null;
    const shouldClearLease =
      params.clearLease ||
      params.status === "COMPLETED" ||
      params.status === "COMPENSATED";

    if (shouldClearLease) {
      await this.pool.query(
        `UPDATE workflow_runs
         SET status = $1,
             output_payload = COALESCE($2::jsonb, output_payload),
             error_message = COALESCE($3, error_message),
             locked_by = NULL,
             lease_expires_at = NULL,
             updated_at = $4::timestamptz
         WHERE id = $5::uuid`,
        [
          params.status,
          payloadJson,
          params.errorMessage ?? null,
          new Date().toISOString(),
          params.runId,
        ]
      );
    } else {
      await this.pool.query(
        `UPDATE workflow_runs
         SET status = $1,
             output_payload = COALESCE($2::jsonb, output_payload),
             error_message = COALESCE($3, error_message),
             updated_at = $4::timestamptz
         WHERE id = $5::uuid`,
        [
          params.status,
          payloadJson,
          params.errorMessage ?? null,
          new Date().toISOString(),
          params.runId,
        ]
      );
    }
  }

  async listRecentRuns(limit = 20): Promise<readonly PersistedWorkflowRunSummary[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const runRes = await this.pool.query<{
      id: string;
      workflow_name: string;
      idempotency_key: string;
      status: WorkflowRunStatus;
      error_message: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, workflow_name, idempotency_key, status, error_message, created_at, updated_at
       FROM workflow_runs
       ORDER BY updated_at DESC, id DESC
       LIMIT $1`,
      [safeLimit]
    );

    if (runRes.rows.length === 0) return [];

    const runIds = runRes.rows.map((r) => r.id);
    const placeholders = runIds.map((_, idx) => `$${idx + 1}::uuid`).join(", ");
    const stepRes = await this.pool.query<{
      workflow_run_id: string;
      step_name: string;
      step_order: string;
      status: WorkflowStepStatus;
    }>(
      `SELECT workflow_run_id, step_name, step_order, status
       FROM workflow_step_logs
       WHERE workflow_run_id IN (${placeholders})
       ORDER BY step_order ASC`,
      runIds
    );

    const stepsByRun = new Map<
      string,
      { stepName: string; stepOrder: number; status: WorkflowStepStatus }[]
    >();
    for (const s of stepRes.rows) {
      const list = stepsByRun.get(s.workflow_run_id) ?? [];
      list.push({
        stepName: s.step_name,
        stepOrder: Number(s.step_order),
        status: s.status,
      });
      stepsByRun.set(s.workflow_run_id, list);
    }

    return runRes.rows.map((r) => {
      const steps = stepsByRun.get(r.id) ?? [];
      const compensatedLifoChain = [...steps]
        .filter((s) => s.status === "COMPENSATED")
        .sort((a, b) => b.stepOrder - a.stepOrder)
        .map((s) => s.stepName);

      return {
        id: r.id,
        workflowName: r.workflow_name,
        idempotencyKey: r.idempotency_key,
        status: r.status,
        errorMessage: r.error_message ?? undefined,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
        steps,
        compensatedLifoChain,
      };
    });
  }
}

export interface StepRetryPolicy {
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
}

export interface StepDefinition<TInput, TOutput> {
  readonly name: string;
  readonly retryPolicy?: StepRetryPolicy;
  readonly invoke: (input: TInput) => Promise<TOutput> | TOutput;
  readonly compensate?: (output: TOutput, input: TInput) => Promise<void> | void;
}

export function createStep<TInput, TOutput>(
  definition: StepDefinition<TInput, TOutput>
): StepDefinition<TInput, TOutput> {
  return definition;
}

export interface WorkflowExecutionContext {
  readonly runId: string;
  readonly idempotencyKey: string;
  run<TStepInput, TStepOutput>(
    step: StepDefinition<TStepInput, TStepOutput>,
    input: TStepInput
  ): Promise<TStepOutput>;
}

export interface WorkflowExecutionResult<TOutput> {
  readonly runId: string;
  readonly status: WorkflowRunStatus;
  readonly output?: TOutput;
  readonly error?: Error;
  readonly compensatedSteps: readonly string[];
  readonly replayedSteps: readonly string[];
}

export interface WorkflowExecuteOptions {
  readonly idempotencyKey: string;
  readonly store: WorkflowStateStore;
  readonly workerId?: string;
  readonly leaseDurationMs?: number;
  readonly nowMs?: number;
}

export interface WorkflowDefinition<TInput, TOutput> {
  readonly name: string;
  execute(
    input: TInput,
    options: WorkflowExecuteOptions
  ): Promise<WorkflowExecutionResult<TOutput>>;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWorkflow<TInput, TOutput>(
  workflowName: string,
  handler: (input: TInput, ctx: WorkflowExecutionContext) => Promise<TOutput>
): WorkflowDefinition<TInput, TOutput> {
  return {
    name: workflowName,
    async execute(input, options) {
      const { idempotencyKey, store } = options;
      const workerId = options.workerId ?? `wf_worker_${randomUUID().slice(0, 8)}`;
      const leaseDurationMs = options.leaseDurationMs ?? 30_000;

      const persistedRun = await store.getOrCreateRun({
        workflowName,
        idempotencyKey,
        input,
      });

      if (persistedRun.status === "COMPLETED") {
        return {
          runId: persistedRun.id,
          status: "COMPLETED",
          output: persistedRun.outputPayload as TOutput,
          compensatedSteps: [],
          replayedSteps: Array.from(persistedRun.steps.keys()),
        };
      }

      if (store.tryAcquireRunLease) {
        const acquired = await store.tryAcquireRunLease({
          runId: persistedRun.id,
          workerId,
          leaseDurationMs,
          nowMs: options.nowMs,
        });
        if (!acquired) {
          // Re-check if the concurrent holder just finished completing it
          const recheck = await store.getOrCreateRun({
            workflowName,
            idempotencyKey,
            input,
          });
          if (recheck.status === "COMPLETED") {
            return {
              runId: recheck.id,
              status: "COMPLETED",
              output: recheck.outputPayload as TOutput,
              compensatedSteps: [],
              replayedSteps: Array.from(recheck.steps.keys()),
            };
          }
          throw new WorkflowConcurrentExecutionError({
            idempotencyKey,
            runId: persistedRun.id,
          });
        }
      } else {
        await store.updateRunStatus({
          runId: persistedRun.id,
          status: "RUNNING",
        });
      }

      // Reload latest persisted steps after acquiring the lease
      const leasedSnapshot = await store.getOrCreateRun({
        workflowName,
        idempotencyKey,
        input,
      });

      interface ExecutedStepEntry {
        stepName: string;
        compensate?: () => Promise<void>;
      }

      const executedStack: ExecutedStepEntry[] = [];
      const replayedSteps: string[] = [];
      const compensatedSteps: string[] = [];
      let stepCounter = 0;

      const ctx: WorkflowExecutionContext = {
        runId: leasedSnapshot.id,
        idempotencyKey,
        async run<TStepInput, TStepOutput>(
          step: StepDefinition<TStepInput, TStepOutput>,
          stepInput: TStepInput
        ): Promise<TStepOutput> {
          stepCounter += 1;
          const existingLog = leasedSnapshot.steps.get(step.name);

          if (existingLog && existingLog.status === "COMPLETED") {
            replayedSteps.push(step.name);
            const cachedOutput = existingLog.outputPayload as TStepOutput;
            executedStack.push({
              stepName: step.name,
              compensate: step.compensate
                ? async () => {
                    await step.compensate!(cachedOutput, stepInput);
                  }
                : undefined,
            });
            return cachedOutput;
          }

          const maxRetries = step.retryPolicy?.maxRetries ?? 0;
          const retryDelayMs = step.retryPolicy?.retryDelayMs ?? 0;
          let lastError: unknown;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              const output = await step.invoke(stepInput);
              await store.recordStepSuccess({
                runId: leasedSnapshot.id,
                stepName: step.name,
                stepOrder: stepCounter,
                output,
              });

              executedStack.push({
                stepName: step.name,
                compensate: step.compensate
                  ? async () => {
                      await step.compensate!(output, stepInput);
                    }
                  : undefined,
              });

              return output;
            } catch (err) {
              if (err instanceof ProcessCrashSimulatedError) {
                throw err;
              }
              lastError = err;
              if (attempt < maxRetries) {
                await sleep(retryDelayMs * (attempt + 1));
              }
            }
          }

          throw lastError instanceof Error
            ? lastError
            : new Error(String(lastError));
        },
      };

      try {
        const finalOutput = await handler(input, ctx);
        await store.updateRunStatus({
          runId: leasedSnapshot.id,
          status: "COMPLETED",
          output: finalOutput,
          clearLease: true,
        });
        return {
          runId: leasedSnapshot.id,
          status: "COMPLETED",
          output: finalOutput,
          compensatedSteps,
          replayedSteps,
        };
      } catch (err) {
        if (err instanceof ProcessCrashSimulatedError) {
          // Leave run in RUNNING with its lease intact so SagaRecoveryWorker recovers it after TTL
          throw err;
        }

        const errorObj = err instanceof Error ? err : new Error(String(err));
        await store.updateRunStatus({
          runId: leasedSnapshot.id,
          status: "COMPENSATING",
          errorMessage: errorObj.message,
        });

        for (let i = executedStack.length - 1; i >= 0; i--) {
          const entry = executedStack[i]!;
          if (entry.compensate) {
            await entry.compensate();
            await store.recordStepCompensated({
              runId: leasedSnapshot.id,
              stepName: entry.stepName,
            });
            compensatedSteps.push(entry.stepName);
          }
        }

        await store.updateRunStatus({
          runId: leasedSnapshot.id,
          status: "COMPENSATED",
          errorMessage: errorObj.message,
          clearLease: true,
        });

        return {
          runId: leasedSnapshot.id,
          status: "COMPENSATED",
          error: errorObj,
          compensatedSteps,
          replayedSteps,
        };
      }
    },
  };
}

export interface SagaRecoveryItemReport {
  readonly runId: string;
  readonly workflowName: string;
  readonly idempotencyKey: string;
  readonly finalStatus: WorkflowRunStatus | "SKIPPED_CONCURRENT" | "UNREGISTERED_WORKFLOW";
  readonly replayedSteps: readonly string[];
  readonly compensatedSteps: readonly string[];
}

export interface SagaRecoveryBatchReport {
  readonly scannedCount: number;
  readonly recoveredCount: number;
  readonly items: readonly SagaRecoveryItemReport[];
}

/**
 * Autonomous Background Saga Recovery Daemon (`SagaRecoveryWorker`).
 *
 * Periodically scans `workflow_runs` for orphaned `RUNNING` / `COMPENSATING` transactions
 * whose worker lease has expired (e.g. after a container OOM / `SIGKILL` post-payment capture)
 * and drives them deterministically to `COMPLETED` or `COMPENSATED`.
 */
export class SagaRecoveryWorker {
  private readonly store: WorkflowStateStore;
  private readonly workflows = new Map<string, WorkflowDefinition<unknown, unknown>>();
  private readonly workerId: string;
  private readonly leaseDurationMs: number;

  constructor(params: {
    store: WorkflowStateStore;
    workflows?: readonly WorkflowDefinition<any, any>[];
    workerId?: string;
    leaseDurationMs?: number;
  }) {
    this.store = params.store;
    this.workerId = params.workerId ?? `saga_reaper_${randomUUID().slice(0, 8)}`;
    this.leaseDurationMs = params.leaseDurationMs ?? 30_000;
    for (const wf of params.workflows ?? []) {
      this.registerWorkflow(wf);
    }
  }

  registerWorkflow<TIn, TOut>(workflow: WorkflowDefinition<TIn, TOut>): void {
    this.workflows.set(
      workflow.name,
      workflow as unknown as WorkflowDefinition<unknown, unknown>
    );
  }

  async recoverOrphanedRuns(params?: {
    nowMs?: number;
    limit?: number;
  }): Promise<SagaRecoveryBatchReport> {
    if (!this.store.listExpiredOrphanRuns) {
      return { scannedCount: 0, recoveredCount: 0, items: [] };
    }

    const candidates = await this.store.listExpiredOrphanRuns({
      nowMs: params?.nowMs,
      limit: params?.limit ?? 25,
    });

    const items: SagaRecoveryItemReport[] = [];
    let recoveredCount = 0;

    for (const cand of candidates) {
      const wf = this.workflows.get(cand.workflowName);
      if (!wf) {
        items.push({
          runId: cand.id,
          workflowName: cand.workflowName,
          idempotencyKey: cand.idempotencyKey,
          finalStatus: "UNREGISTERED_WORKFLOW",
          replayedSteps: [],
          compensatedSteps: [],
        });
        continue;
      }

      try {
        const res = await wf.execute(cand.inputPayload, {
          idempotencyKey: cand.idempotencyKey,
          store: this.store,
          workerId: this.workerId,
          leaseDurationMs: this.leaseDurationMs,
          nowMs: params?.nowMs,
        });
        recoveredCount += 1;
        items.push({
          runId: cand.id,
          workflowName: cand.workflowName,
          idempotencyKey: cand.idempotencyKey,
          finalStatus: res.status,
          replayedSteps: res.replayedSteps,
          compensatedSteps: res.compensatedSteps,
        });
      } catch (err) {
        if (err instanceof WorkflowConcurrentExecutionError) {
          items.push({
            runId: cand.id,
            workflowName: cand.workflowName,
            idempotencyKey: cand.idempotencyKey,
            finalStatus: "SKIPPED_CONCURRENT",
            replayedSteps: [],
            compensatedSteps: [],
          });
          continue;
        }
        throw err;
      }
    }

    return {
      scannedCount: candidates.length,
      recoveredCount,
      items,
    };
  }
}
