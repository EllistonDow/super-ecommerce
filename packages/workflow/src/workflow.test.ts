import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createStep,
  createWorkflow,
  InMemoryWorkflowStateStore,
  PgWorkflowStateStore,
  ProcessCrashSimulatedError,
  SagaRecoveryWorker,
  WorkflowConcurrentExecutionError,
} from "./index.ts";
import { OfflinePgPool, runMigrations } from "@super-ecommerce/db";

describe("@super-ecommerce/workflow", () => {
  it("compensates completed steps in strict LIFO reverse order when a downstream step fails", async () => {
    const store = new InMemoryWorkflowStateStore();
    const auditLog: string[] = [];

    const step1 = createStep({
      name: "reserve-stock",
      invoke: async (qty: number) => {
        auditLog.push(`invoke:reserve-stock:${qty}`);
        return { reservationId: "res-101", qty };
      },
      compensate: async (out) => {
        auditLog.push(`compensate:reserve-stock:${out.reservationId}`);
      },
    });

    const step2 = createStep({
      name: "redeem-gift-card",
      invoke: async (amount: bigint) => {
        auditLog.push(`invoke:redeem-gift-card:${amount}`);
        return { txId: "gc-202", amount };
      },
      compensate: async (out) => {
        auditLog.push(`compensate:redeem-gift-card:${out.txId}`);
      },
    });

    const step3 = createStep({
      name: "capture-payment",
      retryPolicy: { maxRetries: 1, retryDelayMs: 1 },
      invoke: async () => {
        auditLog.push("invoke:capture-payment");
        throw new Error("Payment gateway declined: INSUFFICIENT_FUNDS");
      },
    });

    const wf = createWorkflow("test-saga-compensation", async (_input, ctx) => {
      await ctx.run(step1, 2);
      await ctx.run(step2, 500n);
      await ctx.run(step3, {});
      return "ok";
    });

    const result = await wf.execute({}, { idempotencyKey: "idem-fail-1", store });

    assert.equal(result.status, "COMPENSATED");
    assert.deepEqual(result.compensatedSteps, ["redeem-gift-card", "reserve-stock"]);
    assert.deepEqual(auditLog, [
      "invoke:reserve-stock:2",
      "invoke:redeem-gift-card:500",
      "invoke:capture-payment",
      "invoke:capture-payment", // 1 retry
      "compensate:redeem-gift-card:gc-202",
      "compensate:reserve-stock:res-101",
    ]);
  });

  it("replays already-completed steps without re-invoking side effects after a process crash", async () => {
    const store = new InMemoryWorkflowStateStore();
    let paymentChargeCount = 0;
    let orderCommitCount = 0;

    // Simulate a run that crashed right after step 1 ("capture-payment") persisted its success
    const preRun = await store.getOrCreateRun({
      workflowName: "crash-recovery-wf",
      idempotencyKey: "idem-crash-42",
      input: { checkoutId: "chk-42" },
    });
    await store.recordStepSuccess({
      runId: preRun.id,
      stepName: "capture-payment",
      stepOrder: 1,
      output: { paymentIntentId: "pi_999", capturedAmount: 9500n },
    });

    const captureStep = createStep({
      name: "capture-payment",
      invoke: async () => {
        paymentChargeCount += 1;
        return { paymentIntentId: "pi_new", capturedAmount: 9500n };
      },
    });

    const commitOrderStep = createStep({
      name: "commit-order",
      invoke: async (input: { paymentIntentId: string; capturedAmount: bigint }) => {
        orderCommitCount += 1;
        return { orderNumber: "ORD-10001", paymentIntentId: input.paymentIntentId };
      },
    });

    const wf = createWorkflow(
      "crash-recovery-wf",
      async (_input: { checkoutId: string }, ctx) => {
        const payment = await ctx.run(captureStep, {});
        return await ctx.run(commitOrderStep, payment);
      }
    );

    const resumed = await wf.execute(
      { checkoutId: "chk-42" },
      { idempotencyKey: "idem-crash-42", store }
    );

    assert.equal(resumed.status, "COMPLETED");
    // capture-payment was replayed from durable log, NOT charged a second time!
    assert.equal(paymentChargeCount, 0);
    assert.equal(orderCommitCount, 1);
    assert.deepEqual(resumed.replayedSteps, ["capture-payment"]);
    assert.equal(resumed.output?.paymentIntentId, "pi_999");
  });

  it("persists workflow runs and step logs in PostgreSQL tables (PgWorkflowStateStore) with BigInt fidelity", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      const pgStore = new PgWorkflowStateStore(pg);
      let step1Invocations = 0;

      const step1 = createStep({
        name: "lock-funds",
        invoke: async (amount: bigint) => {
          step1Invocations += 1;
          return { holdId: "hold-77", lockedMinorUnits: amount };
        },
      });

      const wf = createWorkflow("pg-durable-wf", async (amount: bigint, ctx) => {
        return await ctx.run(step1, amount);
      });

      const first = await wf.execute(42_500n, {
        idempotencyKey: "pg-idem-1",
        store: pgStore,
      });
      assert.equal(first.status, "COMPLETED");
      assert.equal(first.output?.lockedMinorUnits, 42_500n);
      assert.equal(step1Invocations, 1);

      const second = await wf.execute(42_500n, {
        idempotencyKey: "pg-idem-1",
        store: pgStore,
      });
      assert.equal(second.status, "COMPLETED");
      assert.equal(second.output?.lockedMinorUnits, 42_500n);
      assert.equal(step1Invocations, 1);
      assert.deepEqual(second.replayedSteps, ["lock-funds"]);
    } finally {
      await pg.close();
    }
  });

  it("persists workflow runs, BigInt/scalar step logs, crash replay, and LIFO compensation in PostgreSQL (PgWorkflowStateStore)", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      const storeA = new PgWorkflowStateStore(pg);
      const storeB = new PgWorkflowStateStore(pg);

      // 1. Concurrent getOrCreateRun with identical idempotencyKey converges on one run row
      const [concurrentA, concurrentB] = await Promise.all([
        storeA.getOrCreateRun({
          workflowName: "concurrent-init-wf",
          idempotencyKey: "pg-idem-concurrent-1",
          input: { amount: 12_345n },
        }),
        storeB.getOrCreateRun({
          workflowName: "concurrent-init-wf",
          idempotencyKey: "pg-idem-concurrent-1",
          input: { amount: 12_345n },
        }),
      ]);
      assert.equal(concurrentA.id, concurrentB.id);
      assert.equal(concurrentA.inputPayload.amount, 12_345n);

      // 2. Crash replay across fresh store instances without re-invoking completed side effects
      const crashedRun = await storeA.getOrCreateRun({
        workflowName: "pg-crash-recovery-wf",
        idempotencyKey: "pg-idem-crash-42",
        input: { checkoutId: "chk-pg-42" },
      });
      await storeA.recordStepSuccess({
        runId: crashedRun.id,
        stepName: "capture-payment",
        stepOrder: 1,
        output: { paymentIntentId: "pi_pg_999", capturedAmount: 9500n },
      });

      let paymentChargeCount = 0;
      let orderCommitCount = 0;
      const captureStep = createStep({
        name: "capture-payment",
        invoke: async () => {
          paymentChargeCount += 1;
          return { paymentIntentId: "pi_should_not_run", capturedAmount: 9500n };
        },
      });
      const commitOrderStep = createStep({
        name: "commit-order",
        invoke: async (p: { paymentIntentId: string; capturedAmount: bigint }) => {
          orderCommitCount += 1;
          return {
            orderId: "ord-pg-42",
            paymentIntentId: p.paymentIntentId,
            capturedAmount: p.capturedAmount,
          };
        },
      });

      const crashWf = createWorkflow(
        "pg-crash-recovery-wf",
        async (_input: { checkoutId: string }, ctx) => {
          const payment = await ctx.run(captureStep, {});
          return await ctx.run(commitOrderStep, payment);
        }
      );

      const resumed = await crashWf.execute(
        { checkoutId: "chk-pg-42" },
        { idempotencyKey: "pg-idem-crash-42", store: storeB }
      );
      assert.equal(resumed.status, "COMPLETED");
      assert.equal(paymentChargeCount, 0);
      assert.equal(orderCommitCount, 1);
      assert.deepEqual(resumed.replayedSteps, ["capture-payment"]);
      assert.equal(resumed.output?.paymentIntentId, "pi_pg_999");
      assert.equal(resumed.output?.capturedAmount, 9500n);

      // Second execution short-circuits idempotently from PG without invoking either step
      const idempotentReplay = await crashWf.execute(
        { checkoutId: "chk-pg-42" },
        { idempotencyKey: "pg-idem-crash-42", store: new PgWorkflowStateStore(pg) }
      );
      assert.equal(idempotentReplay.status, "COMPLETED");
      assert.equal(orderCommitCount, 1);
      assert.equal(idempotentReplay.output?.capturedAmount, 9500n);

      // 3. BigInt + scalar ("ok", null) input/output fidelity
      const scalarStep = createStep({
        name: "scalar-ok",
        invoke: async (amt: bigint) => (amt > 0n ? "ok" : null),
      });
      const scalarWf = createWorkflow("pg-scalar-wf", async (amt: bigint, ctx) => {
        const res = await ctx.run(scalarStep, amt);
        return res;
      });
      const scalarFirst = await scalarWf.execute(42_500n, {
        idempotencyKey: "pg-idem-scalar-1",
        store: storeA,
      });
      assert.equal(scalarFirst.status, "COMPLETED");
      assert.equal(scalarFirst.output, "ok");
      const scalarSecond = await scalarWf.execute(42_500n, {
        idempotencyKey: "pg-idem-scalar-1",
        store: storeB,
      });
      assert.equal(scalarSecond.output, "ok");

      // 4. LIFO compensation persisted into workflow_runs & workflow_step_logs + listRecentRuns
      const lifoAudit: string[] = [];
      const s1 = createStep({
        name: "reserve-stock",
        invoke: async () => "res-1",
        compensate: async (id) => {
          lifoAudit.push(`comp:reserve:${id}`);
        },
      });
      const s2 = createStep({
        name: "redeem-gift-card",
        invoke: async () => null,
        compensate: async () => {
          lifoAudit.push("comp:gift-card");
        },
      });
      const s3 = createStep({
        name: "capture-payment",
        invoke: async () => {
          throw new Error("GATEWAY_TIMEOUT");
        },
      });
      const failWf = createWorkflow("pg-lifo-wf", async (_i, ctx) => {
        await ctx.run(s1, undefined);
        await ctx.run(s2, undefined);
        await ctx.run(s3, undefined);
        return "unreachable";
      });
      const failRes = await failWf.execute(
        { order: "fail-1" },
        { idempotencyKey: "pg-idem-fail-1", store: storeA }
      );
      assert.equal(failRes.status, "COMPENSATED");
      assert.deepEqual(failRes.compensatedSteps, ["redeem-gift-card", "reserve-stock"]);
      assert.deepEqual(lifoAudit, ["comp:gift-card", "comp:reserve:res-1"]);

      const recent = await storeB.listRecentRuns(10);
      const lifoRow = recent.find((r) => r.idempotencyKey === "pg-idem-fail-1");
      assert.ok(lifoRow);
      assert.equal(lifoRow.status, "COMPENSATED");
      assert.equal(lifoRow.errorMessage, "GATEWAY_TIMEOUT");
      assert.deepEqual(lifoRow.compensatedLifoChain, ["redeem-gift-card", "reserve-stock"]);
    } finally {
      await pg.close();
    }
  });

  it("enforces mutual-exclusion leases against concurrent duplicate idempotencyKeys and recovers zombie crashed runs via SagaRecoveryWorker", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      const store = new PgWorkflowStateStore(pg);
      let chargeInvocations = 0;

      // 1. Concurrent race on the same idempotencyKey: second caller gets WorkflowConcurrentExecutionError
      const slowChargeStep = createStep({
        name: "slow-gateway-capture",
        invoke: async (amt: bigint) => {
          chargeInvocations += 1;
          await new Promise((r) => setTimeout(r, 40));
          return { txId: `tx_${chargeInvocations}`, amt };
        },
      });
      const raceWf = createWorkflow("race-guard-wf", async (amt: bigint, ctx) => {
        return await ctx.run(slowChargeStep, amt);
      });

      const [firstOutcome, secondOutcome] = await Promise.allSettled([
        raceWf.execute(19_900n, {
          idempotencyKey: "idem-race-mutex-1",
          store,
          leaseDurationMs: 5_000,
        }),
        (async () => {
          await new Promise((r) => setTimeout(r, 8));
          return await raceWf.execute(19_900n, {
            idempotencyKey: "idem-race-mutex-1",
            store,
            leaseDurationMs: 5_000,
          });
        })(),
      ]);

      assert.equal(firstOutcome.status, "fulfilled");
      assert.equal(secondOutcome.status, "rejected");
      assert.ok(secondOutcome.reason instanceof WorkflowConcurrentExecutionError);
      assert.equal(chargeInvocations, 1, "Gateway capture must execute strictly once");

      // 2. Process crash mid-flight -> lease expires -> SagaRecoveryWorker resumes & completes automatically
      let zombieCharges = 0;
      let shouldCrashStep2 = true;

      const zombieStep1 = createStep({
        name: "capture-stripe",
        invoke: async (amt: bigint) => {
          zombieCharges += 1;
          return { pi: "pi_zombie_01", amt };
        },
      });
      const zombieStep2 = createStep({
        name: "persist-order",
        invoke: async (p: { pi: string; amt: bigint }) => {
          if (shouldCrashStep2) {
            throw new ProcessCrashSimulatedError("OOM_KILLED_AFTER_STRIPE_CAPTURE");
          }
          return { orderId: "ord_recovered_01", pi: p.pi, amt: p.amt };
        },
      });
      const zombieWf = createWorkflow("zombie-checkout-wf", async (amt: bigint, ctx) => {
        const pay = await ctx.run(zombieStep1, amt);
        return await ctx.run(zombieStep2, pay);
      });

      const t0 = Date.now();
      await assert.rejects(
        () =>
          zombieWf.execute(88_000n, {
            idempotencyKey: "idem-zombie-1",
            store,
            leaseDurationMs: 1_000,
            nowMs: t0,
          }),
        ProcessCrashSimulatedError
      );
      assert.equal(zombieCharges, 1);

      const recoveryWorker = new SagaRecoveryWorker({
        store,
        workflows: [zombieWf],
      });

      // Before lease expires (t0 + 200ms): 0 runs eligible
      const prematureScan = await recoveryWorker.recoverOrphanedRuns({ nowMs: t0 + 200 });
      assert.equal(prematureScan.scannedCount, 0);

      // After lease expires (t0 + 1500ms): SagaRecoveryWorker claims & completes without re-charging!
      shouldCrashStep2 = false;
      const recoveredScan = await recoveryWorker.recoverOrphanedRuns({ nowMs: t0 + 1_500 });
      assert.equal(recoveredScan.scannedCount, 1);
      assert.equal(recoveredScan.recoveredCount, 1);
      assert.equal(recoveredScan.items[0]?.finalStatus, "COMPLETED");
      assert.deepEqual(recoveredScan.items[0]?.replayedSteps, ["capture-stripe"]);
      assert.equal(zombieCharges, 1, "Recovered saga must NOT double-charge Stripe");
    } finally {
      await pg.close();
    }
  });
});
