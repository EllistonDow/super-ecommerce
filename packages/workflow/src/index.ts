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
 * 2. Automatic Retries: Transient step failures retry with configurable backoff.
 * 3. Reverse-Order Saga Compensation: When a step fails permanently, all previously
 *    completed steps in the run are compensated in strict LIFO (reverse) order.
 */

import { randomUUID } from "node:crypto";
import {
  deserializeWithBigInt,
  serializeWithBigInt,
  SqlDatabaseEngine,
  type PgPoolLike,
} from "@super-ecommerce/db";

export type WorkflowRunStatus =
  | "RUNNING"
  | "COMPLETED"
  | "COMPENSATING"
  | "COMPENSATED"
  | "FAILED";

export type WorkflowStepStatus = "COMPLETED" | "COMPENSATED" | "FAILED";

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

/**
 * Storage adapter interface so the engine runs identically against PostgreSQL 17
 * (`workflow_runs` + `workflow_step_logs`) or an in-memory store in unit tests.
 */
export interface WorkflowStateStore {
  getOrCreateRun<TInput>(params: {
    workflowName: string;
    idempotencyKey: string;
    input: TInput;
  }): Promise<PersistedWorkflowRun<TInput>>;

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
  }): Promise<void>;
}

/**
 * Default deterministic in-memory store (also serves as reference for the PG adapter).
 */
export class InMemoryWorkflowStateStore implements WorkflowStateStore {
  private readonly runsByKey = new Map<string, {
    id: string;
    workflowName: string;
    idempotencyKey: string;
    status: WorkflowRunStatus;
    inputPayload: unknown;
    outputPayload?: unknown;
    errorMessage?: string;
    steps: Map<string, PersistedStepLog>;
  }>();

  private readonly runsById = new Map<string, {
    id: string;
    workflowName: string;
    idempotencyKey: string;
    status: WorkflowRunStatus;
    inputPayload: unknown;
    outputPayload?: unknown;
    errorMessage?: string;
    steps: Map<string, PersistedStepLog>;
  }>();

  private nextId = 1;

  async getOrCreateRun<TInput>(params: {
    workflowName: string;
    idempotencyKey: string;
    input: TInput;
  }): Promise<PersistedWorkflowRun<TInput>> {
    const existing = this.runsByKey.get(params.idempotencyKey);
    if (existing) {
      return {
        ...(existing as PersistedWorkflowRun<TInput>),
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
      steps: new Map<string, PersistedStepLog>(),
    };
    this.runsByKey.set(params.idempotencyKey, record);
    this.runsById.set(id, record);

    return {
      ...record,
      steps: new Map(record.steps),
    };
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
  }
}

/**
 * Relational SQL-backed `WorkflowStateStore` (`workflow_runs` + `workflow_step_logs`).
 * Persists every workflow run and step output inside ACID SQL transactions with
 * lossless `BigInt` (`MinorUnits`) serialization.
 */
export class SqlWorkflowStateStore implements WorkflowStateStore {
  private readonly sqlEngine: SqlDatabaseEngine;
  private seq = 1;

  constructor(sqlEngine: SqlDatabaseEngine) {
    this.sqlEngine = sqlEngine;
  }

  async getOrCreateRun<TInput>(params: {
    workflowName: string;
    idempotencyKey: string;
    input: TInput;
  }): Promise<PersistedWorkflowRun<TInput>> {
    return this.sqlEngine.inTransaction(() => {
      const existingRow = this.sqlEngine.db
        .prepare(
          `SELECT id, workflow_name, idempotency_key, status, input_payload, output_payload, error_message
           FROM workflow_runs WHERE idempotency_key = ?`
        )
        .get(params.idempotencyKey) as
        | {
            id: string;
            workflow_name: string;
            idempotency_key: string;
            status: WorkflowRunStatus;
            input_payload: string;
            output_payload: string | null;
            error_message: string | null;
          }
        | undefined;

      if (existingRow) {
        const stepRows = this.sqlEngine.db
          .prepare(
            `SELECT step_name, step_order, status, output_payload
             FROM workflow_step_logs
             WHERE workflow_run_id = ?
             ORDER BY step_order ASC`
          )
          .all(existingRow.id) as {
          step_name: string;
          step_order: number;
          status: WorkflowStepStatus;
          output_payload: string | null;
        }[];

        const steps = new Map<string, PersistedStepLog>();
        for (const s of stepRows) {
          steps.set(s.step_name, {
            stepName: s.step_name,
            stepOrder: s.step_order,
            status: s.status,
            outputPayload: s.output_payload
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
          outputPayload: existingRow.output_payload
            ? deserializeWithBigInt(existingRow.output_payload)
            : undefined,
          errorMessage: existingRow.error_message ?? undefined,
          steps,
        };
      }

      const id = `wf-sql-${Date.now()}-${this.seq++}`;
      const now = new Date().toISOString();
      this.sqlEngine.db
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_name, idempotency_key, status, input_payload, created_at, updated_at)
           VALUES (?, ?, ?, 'RUNNING', ?, ?, ?)`
        )
        .run(
          id,
          params.workflowName,
          params.idempotencyKey,
          serializeWithBigInt(params.input),
          now,
          now
        );

      return {
        id,
        workflowName: params.workflowName,
        idempotencyKey: params.idempotencyKey,
        status: "RUNNING",
        inputPayload: params.input,
        steps: new Map(),
      };
    });
  }

  async recordStepSuccess<TOutput>(params: {
    runId: string;
    stepName: string;
    stepOrder: number;
    output: TOutput;
  }): Promise<void> {
    this.sqlEngine.inTransaction(() => {
      this.sqlEngine.db
        .prepare(
          `INSERT INTO workflow_step_logs (workflow_run_id, step_name, step_order, status, output_payload)
           VALUES (?, ?, ?, 'COMPLETED', ?)
           ON CONFLICT (workflow_run_id, step_name) DO UPDATE SET
             status = 'COMPLETED',
             output_payload = excluded.output_payload`
        )
        .run(
          params.runId,
          params.stepName,
          params.stepOrder,
          serializeWithBigInt(params.output)
        );
    });
  }

  async recordStepCompensated(params: {
    runId: string;
    stepName: string;
  }): Promise<void> {
    this.sqlEngine.inTransaction(() => {
      this.sqlEngine.db
        .prepare(
          `UPDATE workflow_step_logs SET status = 'COMPENSATED'
           WHERE workflow_run_id = ? AND step_name = ?`
        )
        .run(params.runId, params.stepName);
    });
  }

  async updateRunStatus<TOutput = unknown>(params: {
    runId: string;
    status: WorkflowRunStatus;
    output?: TOutput;
    errorMessage?: string;
  }): Promise<void> {
    this.sqlEngine.inTransaction(() => {
      const now = new Date().toISOString();
      this.sqlEngine.db
        .prepare(
          `UPDATE workflow_runs
           SET status = ?,
               output_payload = COALESCE(?, output_payload),
               error_message = COALESCE(?, error_message),
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          params.status,
          params.output !== undefined ? serializeWithBigInt(params.output) : null,
          params.errorMessage ?? null,
          now,
          params.runId
        );
    });
  }

  listRecentRuns(limit = 20): readonly PersistedWorkflowRunSummary[] {
    const runRows = this.sqlEngine.db
      .prepare(
        `SELECT id, workflow_name, idempotency_key, status, error_message, created_at, updated_at
         FROM workflow_runs
         ORDER BY updated_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(limit) as {
      id: string;
      workflow_name: string;
      idempotency_key: string;
      status: WorkflowRunStatus;
      error_message: string | null;
      created_at: string;
      updated_at: string;
    }[];

    return runRows.map((r) => {
      const stepRows = this.sqlEngine.db
        .prepare(
          `SELECT step_name, step_order, status
           FROM workflow_step_logs
           WHERE workflow_run_id = ?
           ORDER BY step_order ASC`
        )
        .all(r.id) as {
        step_name: string;
        step_order: number;
        status: WorkflowStepStatus;
      }[];

      const steps = stepRows.map((s) => ({
        stepName: s.step_name,
        stepOrder: s.step_order,
        status: s.status,
      }));

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
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        steps,
        compensatedLifoChain,
      };
    });
  }
}

/**
 * PostgreSQL 17-backed `WorkflowStateStore` (`workflow_runs` + `workflow_step_logs`).
 * Persists every workflow run and step output across concurrent processes with
 * lossless `BigInt` (`MinorUnits`) JSONB serialization and atomic idempotency.
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
      [params.idempotencyKey]
    );
    const existingRow = existingRes.rows[0];
    if (!existingRow) {
      throw new Error(
        `Workflow run with idempotency_key '${params.idempotencyKey}' disappeared concurrently`
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
  }): Promise<void> {
    const payloadJson =
      params.output !== undefined ? serializeWithBigInt(params.output) : null;
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
  /**
   * Executes a durable step, or replays its persisted output if already completed in a prior attempt.
   */
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

export interface WorkflowDefinition<TInput, TOutput> {
  readonly name: string;
  execute(
    input: TInput,
    options: {
      idempotencyKey: string;
      store: WorkflowStateStore;
    }
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
    async execute(input, { idempotencyKey, store }) {
      const persistedRun = await store.getOrCreateRun({
        workflowName,
        idempotencyKey,
        input,
      });

      // Short-circuit if the workflow already completed idempotently
      if (persistedRun.status === "COMPLETED") {
        return {
          runId: persistedRun.id,
          status: "COMPLETED",
          output: persistedRun.outputPayload as TOutput,
          compensatedSteps: [],
          replayedSteps: Array.from(persistedRun.steps.keys()),
        };
      }

      // Reset status to RUNNING when resuming a crashed run
      await store.updateRunStatus({
        runId: persistedRun.id,
        status: "RUNNING",
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
        runId: persistedRun.id,
        idempotencyKey,
        async run<TStepInput, TStepOutput>(
          step: StepDefinition<TStepInput, TStepOutput>,
          stepInput: TStepInput
        ): Promise<TStepOutput> {
          stepCounter += 1;
          const existingLog = persistedRun.steps.get(step.name);

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
                runId: persistedRun.id,
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
          runId: persistedRun.id,
          status: "COMPLETED",
          output: finalOutput,
        });
        return {
          runId: persistedRun.id,
          status: "COMPLETED",
          output: finalOutput,
          compensatedSteps,
          replayedSteps,
        };
      } catch (err) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        await store.updateRunStatus({
          runId: persistedRun.id,
          status: "COMPENSATING",
          errorMessage: errorObj.message,
        });

        // Execute compensations in strict reverse (LIFO) order
        for (let i = executedStack.length - 1; i >= 0; i--) {
          const entry = executedStack[i]!;
          if (entry.compensate) {
            await entry.compensate();
            await store.recordStepCompensated({
              runId: persistedRun.id,
              stepName: entry.stepName,
            });
            compensatedSteps.push(entry.stepName);
          }
        }

        await store.updateRunStatus({
          runId: persistedRun.id,
          status: "COMPENSATED",
          errorMessage: errorObj.message,
        });

        return {
          runId: persistedRun.id,
          status: "COMPENSATED",
          error: errorObj,
          compensatedSteps,
          replayedSteps,
        };
      }
    },
  };
}
