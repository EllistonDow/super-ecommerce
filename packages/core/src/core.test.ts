import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OfflinePgPool, runMigrations } from "@super-ecommerce/db";
import { InMemoryWorkflowStateStore, PgWorkflowStateStore } from "@super-ecommerce/workflow";
import {
  AdminAuthRbacService,
  B2bOrganizationService,
  buildCancelOrderWorkflow,
  buildCompleteCheckoutWorkflow,
  buildEditOrderWorkflow,
  buildFulfillmentDispatchWorkflow,
  buildProcessReturnRefundWorkflow,
  MsiInventoryService,
  OutboxRelayWorker,
  PgAdminAuthRbacService,
  PgB2bOrganizationService,
  PgCustomerAuthAndCartService,
  PgCustomersService,
  PgDoubleEntryLedgerService,
  PgMsiInventoryService,
  PgOrdersRepository,
  PgReservationTtlReaperService,
  PgSlottedInventoryService,
  PgStripePaymentIntentService,
  PgStripeWebhookService,
  PgTransactionalOutboxService,
  UnbalancedJournalError,
  ReservationTtlReaperService,
  signStripeWebhookPayload,
  StripeWebhookService,
  StripeWebhookVerificationError,
  TransactionalOutboxService,
  verifyOutboundOutboxSignature,
  type OrderRecord,
  type OrderReturnRecord,
  type PaymentGatewayStrategy,
  type StoreCreditLedger,
} from "./index.ts";

describe("@super-ecommerce/core — completeCheckoutWorkflow", () => {
  function createTestHarness(options?: { shouldFailPayment?: boolean; pgPool?: OfflinePgPool }) {
    const pgPool = options?.pgPool;
    const inventoryService = new MsiInventoryService([
      {
        warehouseId: "WH-EAST",
        priorityRank: 1,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "SKU-1",
        quantityOnHand: 5,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
      {
        warehouseId: "WH-CENTRAL",
        priorityRank: 2,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "SKU-1",
        quantityOnHand: 10,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
      {
        warehouseId: "WH-CENTRAL",
        priorityRank: 2,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "SKU-2",
        quantityOnHand: 10,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
    ]);

    const creditBalances = new Map<string, bigint>([["cust-1", 2000n]]);
    const storeCreditLedger: StoreCreditLedger = {
      async deduct(customerId, amount) {
        const current = creditBalances.get(customerId) ?? 0n;
        if (current < amount) throw new Error("Insufficient store credit");
        creditBalances.set(customerId, current - amount);
        return { ledgerTxId: "ltx-1" };
      },
      async restore(customerId, _txId, amount) {
        const current = creditBalances.get(customerId) ?? 0n;
        creditBalances.set(customerId, current + amount);
      },
    };

    const capturedPayments: { txId: string; amount: bigint; refunded: boolean }[] = [];
    const paymentGateway: PaymentGatewayStrategy = {
      async capture({ checkoutId, amount }) {
        if (options?.shouldFailPayment) {
          throw new Error("CARD_DECLINED");
        }
        const tx = { txId: `pay_${checkoutId}`, amount, refunded: false };
        capturedPayments.push(tx);
        return {
          transactionId: tx.txId,
          provider: "stripe",
          capturedAmount: amount,
        };
      },
      async voidOrRefund({ transactionId }) {
        const found = capturedPayments.find((p) => p.txId === transactionId);
        if (found) found.refunded = true;
      },
    };

    const outboxService = new TransactionalOutboxService();
    const pgOutboxService = pgPool ? new PgTransactionalOutboxService(pgPool) : undefined;
    const orderStore = new Map<string, OrderRecord>();
    const rmaStore = new Map<string, OrderReturnRecord>();
    const wfStore = pgPool
      ? new PgWorkflowStateStore(pgPool)
      : new InMemoryWorkflowStateStore();

    const workflow = buildCompleteCheckoutWorkflow({
      inventoryService,
      paymentGateway,
      outboxService: pgOutboxService ?? outboxService,
      storeCreditLedger,
      orderStore,
      pgPool,
    });

    const rmaWorkflow = buildProcessReturnRefundWorkflow({
      inventoryService,
      paymentGateway,
      outboxService: pgOutboxService ?? outboxService,
      storeCreditLedger,
      orderStore,
      rmaStore,
      pgPool,
    });

    return {
      pgPool,
      inventoryService,
      creditBalances,
      capturedPayments,
      outboxService,
      orderStore,
      rmaStore,
      wfStore,
      workflow,
      rmaWorkflow,
    };
  }

  it("completes checkout end-to-end with single-warehouse MSI routing, store credit, and outbox event", async () => {
    const h = createTestHarness();

    const res = await h.workflow.execute(
      {
        checkoutId: "chk-100",
        channelSlug: "us-retail",
        customerId: "cust-1",
        stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        storeCreditToRedeem: 1000n, // $10.00 store credit
        paymentToken: "tok_visa",
        expectedTotalGrossAmount: 5500n, // ($30 + $30 - $10 voucher) * 1.10 tax = $55.00
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 0,
          lines: [
            {
              lineId: "L1",
              variantId: "SKU-1",
              quantity: 1,
              baseUnitPrice: 3000n,
              taxRateBps: 1000,
            },
            {
              lineId: "L2",
              variantId: "SKU-2",
              quantity: 1,
              baseUnitPrice: 3000n,
              taxRateBps: 1000,
            },
          ],
          candidateOrderDiscounts: [
            {
              discountId: "v-10",
              name: "$10 Off Order",
              kind: "ORDER_VOUCHER",
              value: { type: "FIXED", amount: 1000n },
            },
          ],
        },
      },
      { idempotencyKey: "checkout-chk-100", store: h.wfStore }
    );

    assert.equal(res.status, "COMPLETED");
    assert.ok(res.output);
    assert.equal(res.output.orderId, "ord_chk-100");
    assert.equal(res.output.pricing.totalGrossAmount, 5500n);

    // MINIMIZE_SPLIT_THEN_HIGH_STOCK picks WH-CENTRAL for both SKU-1 and SKU-2 (1 shipment!)
    assert.equal(res.output.shipments.length, 2);
    assert.ok(res.output.shipments.every((s) => s.warehouseId === "WH-CENTRAL"));
    assert.equal(h.inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 1);
    assert.equal(h.inventoryService.getSlot("WH-CENTRAL", "SKU-2")?.quantityAllocated, 1);

    // Store credit: $20.00 - $10.00 = $10.00 remaining; Card charged: $55.00 - $10.00 = $45.00
    assert.equal(h.creditBalances.get("cust-1"), 1000n);
    assert.equal(h.capturedPayments[0]?.amount, 4500n);

    // Outbox event queued atomically
    const pendingEvents = h.outboxService.listPending();
    assert.equal(pendingEvents.length, 1);
    assert.equal(pendingEvents[0]?.eventType, "order.created");
  });

  it("automatically releases MSI inventory and restores store credit when payment fails", async () => {
    const h = createTestHarness({ shouldFailPayment: true });

    const res = await h.workflow.execute(
      {
        checkoutId: "chk-fail",
        channelSlug: "us-retail",
        customerId: "cust-1",
        stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        storeCreditToRedeem: 1500n,
        paymentToken: "tok_declined",
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 0,
          lines: [
            {
              lineId: "L1",
              variantId: "SKU-1",
              quantity: 2,
              baseUnitPrice: 2000n,
              taxRateBps: 0,
            },
          ],
        },
      },
      { idempotencyKey: "checkout-chk-fail", store: h.wfStore }
    );

    assert.equal(res.status, "COMPENSATED");
    assert.deepEqual(res.compensatedSteps, [
      "redeem-store-credit",
      "allocate-inventory",
    ]);

    // Store credit restored back to 2000n
    assert.equal(h.creditBalances.get("cust-1"), 2000n);

    // Inventory allocations released back to 0 across all warehouses
    assert.equal(h.inventoryService.getSlot("WH-EAST", "SKU-1")?.quantityAllocated, 0);
    assert.equal(h.inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 0);

    // No order or outbox event created
    assert.equal(h.orderStore.size, 0);
    assert.equal(h.outboxService.listPending().length, 0);
  });

  it("compensates 3 steps in LIFO order (capture-payment void -> redeem-store-credit restore -> allocate-inventory release) when Step 5 commit faults", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    const h = createTestHarness({ pgPool: pg });
    try {
      const res = await h.workflow.execute(
        {
          checkoutId: "chk-step5-fault",
          channelSlug: "us-retail",
          customerId: "cust-1",
          stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
          storeCreditToRedeem: 1200n,
          paymentToken: "tok_visa_captured",
          simulateCommitFault: true,
          cart: {
            currencyCode: "USD",
            taxMode: "TAX_EXCLUSIVE",
            shippingBaseAmount: 0n,
            shippingTaxRateBps: 0,
            lines: [
              {
                lineId: "L1",
                variantId: "SKU-1",
                quantity: 3,
                baseUnitPrice: 2000n,
                taxRateBps: 0,
              },
            ],
          },
        },
        { idempotencyKey: "checkout-chk-step5-fault", store: h.wfStore }
      );

      assert.equal(res.status, "COMPENSATED");
      assert.deepEqual(res.compensatedSteps, [
        "capture-payment",
        "redeem-store-credit",
        "allocate-inventory",
      ]);

      // Payment was captured in Step 4 and then voided/refunded during LIFO compensation
      assert.equal(h.capturedPayments.length, 1);
      assert.equal(h.capturedPayments[0]?.txId, "pay_chk-step5-fault");
      assert.equal(h.capturedPayments[0]?.refunded, true);

      // Store credit restored back to 2000n
      assert.equal(h.creditBalances.get("cust-1"), 2000n);

      // Inventory allocations released back to 0 across all warehouses
      assert.equal(h.inventoryService.getSlot("WH-EAST", "SKU-1")?.quantityAllocated, 0);
      assert.equal(h.inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 0);

      // Persisted workflow run summary reflects COMPENSATED status and LIFO chain
      const pgWfStore = h.wfStore as PgWorkflowStateStore;
      const runs = await pgWfStore.listRecentRuns(5);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "COMPENSATED");
      assert.deepEqual(runs[0]?.compensatedLifoChain, [
        "capture-payment",
        "redeem-store-credit",
        "allocate-inventory",
      ]);
    } finally {
      await pg.close();
    }
  });

  it("executes completeCheckoutWorkflow backed by PostgreSQL ACID tables (workflow_runs, orders, transactional_outbox_events)", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    const h = createTestHarness({ pgPool: pg });
    try {
      const res = await h.workflow.execute(
        {
          checkoutId: "chk-sql-777",
          channelSlug: "us-retail",
          customerId: "cust-1",
          stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
          storeCreditToRedeem: 500n,
          paymentToken: "tok_visa_sql",
          cart: {
            currencyCode: "USD",
            taxMode: "TAX_EXCLUSIVE",
            shippingBaseAmount: 0n,
            shippingTaxRateBps: 0,
            lines: [
              {
                lineId: "L1",
                variantId: "SKU-1",
                quantity: 2,
                baseUnitPrice: 2000n,
                taxRateBps: 1000,
              },
            ],
          },
        },
        { idempotencyKey: "checkout-chk-sql-777", store: h.wfStore }
      );

      assert.equal(res.status, "COMPLETED");
      const orderRows = await pg.query<{ id: string; total_gross_amount: string }>(
        "SELECT id, total_gross_amount FROM orders WHERE id = $1",
        ["ord_chk-sql-777"]
      );
      assert.equal(orderRows.rows.length, 1);
      assert.equal(orderRows.rows[0]?.total_gross_amount, "4400");

      const outboxRows = await pg.query<{ event_type: string; status: string }>(
        "SELECT event_type, status FROM transactional_outbox_events WHERE aggregate_id = $1",
        ["ord_chk-sql-777"]
      );
      assert.equal(outboxRows.rows.length, 1);
      assert.equal(outboxRows.rows[0]?.event_type, "order.created");
      assert.equal(outboxRows.rows[0]?.status, "PENDING");
    } finally {
      await pg.close();
    }
  });

  it("verifies Stripe v1 HMAC-SHA256 signatures in constant time, blocks replay/tampering, deduplicates retries, and compensates MSI stock on async failure", async () => {
    const h = createTestHarness();
    // 1. Complete an initial order
    const checkoutRes = await h.workflow.execute(
      {
        checkoutId: "chk-wh-500",
        channelSlug: "us-retail",
        customerId: "cust-1",
        stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        paymentToken: "tok_async_3ds",
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 0,
          lines: [
            {
              lineId: "L1",
              variantId: "SKU-1",
              quantity: 3,
              baseUnitPrice: 2000n,
              taxRateBps: 0,
            },
          ],
        },
      },
      { idempotencyKey: "checkout-chk-wh-500", store: h.wfStore }
    );
    assert.equal(checkoutRes.status, "COMPLETED");
    assert.equal(h.inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 3);

    const webhookService = new StripeWebhookService({
      endpointSecrets: ["whsec_active_2026_secret", "whsec_rollover_old_secret"],
      toleranceSeconds: 300,
      inventoryService: h.inventoryService,
      outboxService: h.outboxService,
      orderStore: h.orderStore,
    });

    const nowSec = 1_763_000_000;
    const failBody = JSON.stringify({
      id: "evt_stripe_async_fail_01",
      type: "payment_intent.payment_failed",
      created: nowSec,
      data: {
        object: {
          id: "pi_3ds_failed_01",
          amount: 6000,
          currency: "usd",
          metadata: {
            orderId: "ord_chk-wh-500",
            checkoutId: "chk-wh-500",
            channelSlug: "us-retail",
          },
          failure_message: "3D Secure authentication declined by issuer",
        },
      },
    });

    // A. Reject tampered body signed with valid secret
    const validHeader = signStripeWebhookPayload({
      rawBody: failBody,
      secret: "whsec_rollover_old_secret",
      timestampSeconds: nowSec,
    });
    assert.throws(
      () =>
        webhookService.handleRawWebhook({
          rawBody: failBody.replace("6000", "100"),
          signatureHeader: validHeader,
          nowSeconds: nowSec,
        }),
      (err: unknown) =>
        err instanceof StripeWebhookVerificationError &&
        err.code === "SIGNATURE_MISMATCH"
    );

    // B. Reject replay attack outside 300s tolerance window
    assert.throws(
      () =>
        webhookService.handleRawWebhook({
          rawBody: failBody,
          signatureHeader: validHeader,
          nowSeconds: nowSec + 601,
        }),
      (err: unknown) =>
        err instanceof StripeWebhookVerificationError &&
        err.code === "TIMESTAMP_OUTSIDE_TOLERANCE"
    );

    // C. Process valid webhook signed with rollover secret -> marks order FAILED & releases 3 units of SKU-1
    const processed = webhookService.handleRawWebhook({
      rawBody: failBody,
      signatureHeader: validHeader,
      nowSeconds: nowSec + 10,
    });
    assert.equal(processed.duplicate, false);
    assert.equal(processed.updatedPaymentStatus, "FAILED");
    assert.equal(processed.releasedWarehouseSlices, 1);
    assert.equal(h.inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 0);

    // D. Duplicate retry delivery of same `evt_stripe_async_fail_01` is idempotently ignored
    const retry = webhookService.handleRawWebhook({
      rawBody: failBody,
      signatureHeader: validHeader,
      nowSeconds: nowSec + 20,
    });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.releasedWarehouseSlices, 0);
  });

  it("relays Outbox events with HMAC-SHA256 signatures, applies exponential backoff on failure, transitions to DEAD_LETTER, and replays on recovery", async () => {
    const outbox = new TransactionalOutboxService();
    const t0 = 1_763_000_000_000;

    outbox.enqueue({
      eventType: "order.created",
      aggregateType: "Order",
      aggregateId: "ord_1001",
      payload: { orderId: "ord_1001", grossAmount: 25000n },
      nowIso: new Date(t0).toISOString(),
    });

    const poisonEvt = outbox.enqueue({
      eventType: "erp.sync_invoice",
      aggregateType: "Order",
      aggregateId: "ord_1001",
      payload: { invoiceCode: "INV-1001" },
      nowIso: new Date(t0).toISOString(),
    });

    let erpShouldFail = true;
    const verifiedSignatures: boolean[] = [];

    const worker = new OutboxRelayWorker({
      outboxService: outbox,
      signingSecret: "whsec_outbox_test_secret",
      maxAttempts: 3,
      baseDelayMs: 1_000,
      subscribers: [
        {
          name: "search-indexer",
          eventPattern: "order.*",
          handle(envelope) {
            verifiedSignatures.push(
              verifyOutboundOutboxSignature({
                eventId: envelope.event.id,
                rawPayloadJson: envelope.rawPayloadJson,
                signatureHeader: envelope.headers["super-commerce-signature"],
                signingSecret: "whsec_outbox_test_secret",
              })
            );
          },
        },
        {
          name: "netsuite-erp-webhook",
          eventPattern: "erp.*",
          handle() {
            if (erpShouldFail) {
              throw new Error("ERP_503_GATEWAY_TIMEOUT");
            }
          },
        },
      ],
    });

    // Tick 1 at t0: `order.created` succeeds (PUBLISHED), `erp.sync_invoice` fails attempt 1 -> backoff +1000ms
    const tick1 = await worker.drainBatch({ nowMs: t0 });
    assert.equal(tick1.claimedCount, 2);
    assert.equal(tick1.publishedCount, 1);
    assert.equal(tick1.retriedCount, 1);
    assert.equal(verifiedSignatures[0], true);

    // Tick 1.5 at t0 + 500ms: `erp.sync_invoice` is not yet due (`next_attempt_at = t0 + 1000ms`)
    const tickEarly = await worker.drainBatch({ nowMs: t0 + 500 });
    assert.equal(tickEarly.claimedCount, 0);

    // Tick 2 at t0 + 1000ms: fails attempt 2 -> backoff +2000ms (`t0 + 3000ms`)
    const tick2 = await worker.drainBatch({ nowMs: t0 + 1_000 });
    assert.equal(tick2.claimedCount, 1);
    assert.equal(tick2.retriedCount, 1);

    // Tick 3 at t0 + 3000ms: fails attempt 3 (maxAttempts=3) -> transitions to DEAD_LETTER!
    const tick3 = await worker.drainBatch({ nowMs: t0 + 3_000 });
    assert.equal(tick3.claimedCount, 1);
    assert.equal(tick3.deadLetteredCount, 1);

    const allAfterDlq = outbox.listAll();
    const dlqRecord = allAfterDlq.find((e) => e.id === poisonEvt.id);
    assert.equal(dlqRecord?.status, "DEAD_LETTER");
    assert.equal(dlqRecord?.attempts, 3);
    assert.equal(dlqRecord?.lastError, "ERP_503_GATEWAY_TIMEOUT");

    // Recover ERP downstream & manually replay DEAD_LETTER queue
    erpShouldFail = false;
    const requeued = outbox.requeueDeadLetters(undefined, new Date(t0 + 4_000).toISOString());
    assert.equal(requeued, 1);

    const tick4 = await worker.drainBatch({ nowMs: t0 + 4_000 });
    assert.equal(tick4.claimedCount, 1);
    assert.equal(tick4.publishedCount, 1);

    const finalRecord = outbox.listAll().find((e) => e.id === poisonEvt.id);
    assert.equal(finalRecord?.status, "PUBLISHED");

    // Also verify flaky 3PL self-healing (2 transient timeouts -> auto-heals on Attempt 3/3)
    const flakyEvt = outbox.enqueue({
      eventType: "fulfillment.3pl_dispatch_manifest",
      aggregateType: "Shipment",
      aggregateId: "shp_3001",
      payload: { shipmentId: "shp_3001" },
      nowIso: new Date(t0 + 5_000).toISOString(),
    });
    let flakyRemaining = 2;
    worker.registerSubscriber({
      name: "3pl-carrier",
      eventPattern: "fulfillment.*",
      handle() {
        if (flakyRemaining > 0) {
          flakyRemaining -= 1;
          throw new Error("3PL_504_GATEWAY_TIMEOUT");
        }
      },
    });

    const f1 = await worker.drainBatch({ nowMs: t0 + 5_000 });
    assert.equal(f1.retriedCount, 1);
    const f2 = await worker.drainBatch({ nowMs: t0 + 6_000 });
    assert.equal(f2.retriedCount, 1);
    const f3 = await worker.drainBatch({ nowMs: t0 + 8_000 });
    assert.equal(f3.publishedCount, 1);

    const healedRecord = outbox.listAll().find((e) => e.id === flakyEvt.id);
    assert.equal(healedRecord?.status, "PUBLISHED");
    assert.equal(healedRecord?.attempts, 3);

    const stats = outbox.getStats();
    assert.equal(stats.publishedCount, 3);
    assert.equal(stats.deadLetterCount, 0);
    assert.equal(stats.selfHealedCount, 1);
  });

  it("executes single-hub split avoidance and 3-warehouse automatic order splitting on multi-warehouse Saleor SKUs", () => {
    const msi = new MsiInventoryService([]);
    msi.upsertExternalSlots([
      // SKU A (01100730881488241020220001): Rank #1 has 978, Rank #2 has 987, Rank #3 has 100
      {
        warehouseId: "NTMS-DEFAULT-WARE",
        priorityRank: 1,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "01100730881488241020220001",
        quantityOnHand: 978,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
      {
        warehouseId: "NTMS-HAWK-WAREHOU",
        priorityRank: 2,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "01100730881488241020220001",
        quantityOnHand: 987,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
      {
        warehouseId: "NTMS-CANADA-WAREH",
        priorityRank: 3,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "01100730881488241020220001",
        quantityOnHand: 100,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
      // SKU B (012868878271 - 8oz BLAK Allegory Ink): Rank #1 has 433, Rank #2 has 100, Rank #3 has 100
      {
        warehouseId: "NTMS-DEFAULT-WARE",
        priorityRank: 1,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "012868878271",
        quantityOnHand: 433,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
      {
        warehouseId: "NTMS-HAWK-WAREHOU",
        priorityRank: 2,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "012868878271",
        quantityOnHand: 100,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
      {
        warehouseId: "NTMS-CANADA-WAREH",
        priorityRank: 3,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "012868878271",
        quantityOnHand: 100,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
    ]);

    // 1. Single-Hub Split Avoidance: ordering 982 units of SKU A skips Rank #1 (978) and fulfills 100% from Rank #2 (987)
    const singleHubPlan = msi.allocateForCheckout({
      availabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
      strategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
      demands: [
        {
          lineId: "L-SINGLE-HUB",
          variantId: "01100730881488241020220001",
          quantity: 982,
        },
      ],
    });
    assert.equal(singleHubPlan.shipmentCount, 1);
    assert.deepEqual(singleHubPlan.allocations, [
      {
        warehouseId: "NTMS-HAWK-WAREHOU",
        lineId: "L-SINGLE-HUB",
        variantId: "01100730881488241020220001",
        quantityAllocated: 982,
      },
    ]);
    assert.equal(
      msi.getSlot("NTMS-DEFAULT-WARE", "01100730881488241020220001")?.quantityAllocated,
      0
    );
    assert.equal(
      msi.getSlot("NTMS-HAWK-WAREHOU", "01100730881488241020220001")?.quantityAllocated,
      982
    );

    // 2. 3-Warehouse Automatic Split: ordering 550 units of SKU B splits across 433 + 100 + 17 = 550 (3 shipments)
    const threeWhSplitPlan = msi.allocateForCheckout({
      availabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
      strategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
      demands: [
        {
          lineId: "L-3WH-SPLIT",
          variantId: "012868878271",
          quantity: 550,
        },
      ],
    });
    assert.equal(threeWhSplitPlan.shipmentCount, 3);
    assert.deepEqual(threeWhSplitPlan.allocations, [
      {
        warehouseId: "NTMS-DEFAULT-WARE",
        lineId: "L-3WH-SPLIT",
        variantId: "012868878271",
        quantityAllocated: 433,
      },
      {
        warehouseId: "NTMS-HAWK-WAREHOU",
        lineId: "L-3WH-SPLIT",
        variantId: "012868878271",
        quantityAllocated: 100,
      },
      {
        warehouseId: "NTMS-CANADA-WAREH",
        lineId: "L-3WH-SPLIT",
        variantId: "012868878271",
        quantityAllocated: 17,
      },
    ]);
    assert.equal(
      msi.getAvailableQuantity(msi.getSlot("NTMS-DEFAULT-WARE", "012868878271")!),
      0
    );
    assert.equal(
      msi.getAvailableQuantity(msi.getSlot("NTMS-HAWK-WAREHOU", "012868878271")!),
      0
    );
    assert.equal(
      msi.getAvailableQuantity(msi.getSlot("NTMS-CANADA-WAREH", "012868878271")!),
      83
    );
  });

  it("authenticates Admin accounts in constant time, signs HMAC session tokens, and enforces RBAC least-privilege matrix", () => {
    const auth = new AdminAuthRbacService({ signingSecret: "test_secret_2026" });

    // 1. Invalid password -> 401 DENY_401
    const badRes = auth.authenticateWithPassword("admin@kronos.io", "WrongPassword");
    assert.equal(badRes.ok, false);
    assert.equal(badRes.audit.httpStatus, 401);

    // 2. Valid SUPER_ADMIN login -> 200 ALLOW + 7/7 permissions
    const superLogin = auth.authenticateWithPassword("admin@kronos.io", "Kronos!Admin2026");
    assert.equal(superLogin.ok, true);
    assert.equal(superLogin.principal?.role, "SUPER_ADMIN");
    assert.equal(superLogin.principal?.permissions.length, 7);

    const superAllowed = auth.authorizeAction({
      token: superLogin.sessionToken,
      requiredPermission: "configurator:deploy_dag",
      actionLabel: "POST /api/demo/configurator",
    });
    assert.equal(superAllowed.allowed, true);
    assert.equal(superAllowed.httpStatus, 200);

    // 3. FINANCE_AUDITOR login -> allowed finance:audit_webhooks (200), blocked from configurator:deploy_dag (403)
    const auditLogin = auth.authenticateWithPassword("audit@kronos.io", "Kronos!Audit2026");
    assert.equal(auditLogin.ok, true);
    assert.equal(auditLogin.principal?.role, "FINANCE_AUDITOR");

    const auditBlocked = auth.authorizeAction({
      token: auditLogin.sessionToken,
      requiredPermission: "configurator:deploy_dag",
      actionLabel: "POST /api/demo/configurator",
    });
    assert.equal(auditBlocked.allowed, false);
    assert.equal(auditBlocked.httpStatus, 403);
    assert.equal(auditBlocked.audit.decision, "DENY_403");
  });

  it("executes multi-wave partial RMA returns with penny-exact ceiling reconciliation, RESELLABLE vs DAMAGED_QUARANTINE MSI restock, and LIFO compensation", async () => {
    const {
      inventoryService,
      creditBalances,
      orderStore,
      rmaStore,
      wfStore,
      workflow,
      rmaWorkflow,
    } = createTestHarness();

    // 1. Complete a 3-unit order of SKU-1 ($10.00 each = $30.00) with $20.00 order voucher -> $10.00 (1000 cents) paid!
    // Redeeming 300 cents store credit + 700 cents gateway cash = 1000 cents total.
    const checkoutRes = await workflow.execute(
      {
        checkoutId: "chk_rma_1",
        channelSlug: "us-direct",
        customerId: "cust-1",
        stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        storeCreditToRedeem: 300n,
        paymentToken: "tok_visa_rma",
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 0,
          lines: [
            {
              lineId: "L-3UNITS",
              variantId: "SKU-1",
              quantity: 3,
              baseUnitPrice: 1000n,
              taxRateBps: 0,
            },
          ],
          candidateOrderDiscounts: [
            {
              discountId: "vouch-20",
              name: "$20 Off Order",
              kind: "ORDER_VOUCHER",
              value: { type: "FIXED", amount: 2000n },
            },
          ],
        },
      },
      { idempotencyKey: "idem_chk_rma_1", store: wfStore }
    );
    assert.equal(checkoutRes.status, "COMPLETED");
    const orderId = checkoutRes.output!.orderId;
    assert.equal(checkoutRes.output!.pricing.totalGrossAmount, 1000n);
    assert.equal(creditBalances.get("cust-1"), 1700n); // 2000 - 300 = 1700
    // WH-CENTRAL had 10 onHand (highest stock single hub), allocated 3 -> available = 7
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 3);

    // 2. Wave 1: Return 1 unit as RESELLABLE -> refunds 334 cents (GatewayCashFirst -> 334 cash)
    const wave1 = await rmaWorkflow.execute(
      {
        rmaId: "rma_wave_1",
        orderId,
        linesToReturn: [{ lineId: "L-3UNITS", quantity: 1, condition: "RESELLABLE" }],
      },
      { idempotencyKey: "idem_rma_wave_1", store: wfStore }
    );
    assert.equal(wave1.status, "COMPLETED");
    assert.equal(wave1.output!.calculation.totalRefundGrossAmount, 334n);
    assert.equal(wave1.output!.calculation.paymentGatewayRefundAmount, 334n);
    assert.equal(wave1.output!.calculation.storeCreditRefundAmount, 0n);
    assert.equal(wave1.output!.orderPaymentStatusAfter, "PARTIALLY_REFUNDED");
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 2);
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityOnHand, 10);

    // 3. Wave 2: Return 1 unit as DAMAGED_QUARANTINE -> refunds 333 cents (333 cash, leaving 33 cash + 300 store credit)
    const wave2 = await rmaWorkflow.execute(
      {
        rmaId: "rma_wave_2",
        orderId,
        linesToReturn: [{ lineId: "L-3UNITS", quantity: 1, condition: "DAMAGED_QUARANTINE" }],
      },
      { idempotencyKey: "idem_rma_wave_2", store: wfStore }
    );
    assert.equal(wave2.status, "COMPLETED");
    assert.equal(wave2.output!.calculation.totalRefundGrossAmount, 333n);
    assert.equal(wave2.output!.calculation.paymentGatewayRefundAmount, 333n);
    assert.equal(wave2.output!.calculation.storeCreditRefundAmount, 0n);
    // Damaged unit decrements BOTH allocated (2 -> 1) and onHand (10 -> 9)
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 1);
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityOnHand, 9);

    // 4. Inject a Commit Fault on Wave 3 attempt -> verifies LIFO rollback of MSI restock, store credit, and gateway refund!
    const faultAttempt = await rmaWorkflow.execute(
      {
        rmaId: "rma_wave_3_fault",
        orderId,
        linesToReturn: [{ lineId: "L-3UNITS", quantity: 1, condition: "RESELLABLE" }],
        simulateCommitFault: true,
      },
      { idempotencyKey: "idem_rma_wave_3_fault", store: wfStore }
    );
    assert.equal(faultAttempt.status, "COMPENSATED");
    assert.deepEqual(faultAttempt.compensatedSteps, [
      "refund-payment-gateway",
      "restore-store-credit",
      "restock-msi-inventory",
    ]);
    // Stock and store credit are unchanged after LIFO rollback!
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 1);
    assert.equal(creditBalances.get("cust-1"), 1700n);

    // 5. Healthy Wave 3 (Final unit reconciliation): returns last 1 unit -> 333 cents (33 cash + 300 store credit = 333)
    const wave3 = await rmaWorkflow.execute(
      {
        rmaId: "rma_wave_3_ok",
        orderId,
        linesToReturn: [{ lineId: "L-3UNITS", quantity: 1, condition: "RESELLABLE" }],
      },
      { idempotencyKey: "idem_rma_wave_3_ok", store: wfStore }
    );
    assert.equal(wave3.status, "COMPLETED");
    assert.equal(wave3.output!.calculation.lines[0]!.isFinalUnitReconciliation, true);
    assert.equal(wave3.output!.calculation.totalRefundGrossAmount, 333n);
    assert.equal(wave3.output!.calculation.paymentGatewayRefundAmount, 33n);
    assert.equal(wave3.output!.calculation.storeCreditRefundAmount, 300n);
    assert.equal(wave3.output!.orderPaymentStatusAfter, "REFUNDED");

    // Store credit restored from 1700 -> 2000; allocated stock is now 0; order is REFUNDED
    assert.equal(creditBalances.get("cust-1"), 2000n);
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 0);
    assert.equal(orderStore.get(orderId)?.paymentStatus, "REFUNDED");
    assert.equal(rmaStore.size, 3);
  });

  it("orchestrates B2B corporate hierarchy, Net-30 credit pool, 72h MSI reservation hold, supervisor PO approval, and LIFO compensation", async () => {
    const {
      inventoryService,
      outboxService,
      orderStore,
      wfStore,
    } = createTestHarness();

    const b2bService = new B2bOrganizationService({
      inventoryService,
      outboxService,
      orderStore,
      workflowStateStore: wfStore,
    });

    // 1. Buyer Elena (auto-approve limit $2,500.00 = 250_000c) orders 5 units of SKU-1
    // Retail $240.00, 5+ tier $210.00 = $1,050.00 (105_000c)
    // 5% contract discount (-5_250c) -> $997.50 (99_750c), tax-exempt saves $82.29 (8_229c)
    const autoPo = await b2bService.submitPurchaseOrder({
      idempotencyKey: "idem_b2b_po_auto_1",
      input: {
        poId: "po_auto_1",
        poNumber: "PO-2026-1001",
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
              lineId: "L-B2B-1",
              variantId: "SKU-1",
              quantity: 5,
              baseUnitPrice: 24_000n,
              tierPrices: [
                { minQuantity: 5, unitAmount: 21_000n },
                { minQuantity: 10, unitAmount: 18_000n },
              ],
              taxRateBps: 825,
            },
          ],
        },
      },
    });

    assert.equal(autoPo.po.status, "APPROVED_AUTO");
    assert.equal(autoPo.po.pricing.totalGrossAmount, 99_750n);
    assert.equal(autoPo.po.taxExemptSavingsAmount, 8_229n);
    assert.equal(autoPo.order?.orderId, "ord_po_auto_1");
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 5);
    assert.equal(b2bService.getCompany("comp-kronos-b2b")?.creditUsed, 899_750n); // 800_000 + 99_750

    // 2. Buyer Elena orders 10 units of SKU-1 at $180.00 tier = $1,800.00 -> -5% = $1,710.00 (171_000c)
    // Wait: to exceed her $2,500.00 auto-approve limit, price it at $300.00 tier -> $3,000.00 - 5% = $2,850.00 (285_000c)
    const pendingPo = await b2bService.submitPurchaseOrder({
      idempotencyKey: "idem_b2b_po_pend_2",
      input: {
        poId: "po_pend_2",
        poNumber: "PO-2026-1002",
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
              lineId: "L-B2B-2",
              variantId: "SKU-1",
              quantity: 10,
              baseUnitPrice: 32_000n,
              tierPrices: [{ minQuantity: 10, unitAmount: 30_000n }],
              taxRateBps: 825,
            },
          ],
        },
      },
    });

    assert.equal(pendingPo.po.status, "PENDING_APPROVAL");
    assert.equal(pendingPo.po.pricing.totalGrossAmount, 285_000n);
    assert.equal(pendingPo.po.reservationTtlSeconds, 259_200);
    // 10 units reserved across WH-EAST (5) + WH-CENTRAL (5)
    assert.equal(inventoryService.getSlot("WH-EAST", "SKU-1")?.quantityReserved, 5);
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityReserved, 5);
    assert.equal(b2bService.getCompany("comp-kronos-b2b")?.creditReserved, 285_000n);

    // 3. Supervisor Marcus attempts approval with simulated Step 3 commit fault -> LIFO rollback keeps reservation intact!
    const faultDecision = await b2bService.decidePendingPurchaseOrder({
      idempotencyKey: "idem_b2b_approve_fault",
      poId: "po_pend_2",
      approverId: "approver-marcus",
      decision: "APPROVE",
      simulateCommitFault: true,
    });
    assert.equal(faultDecision.workflowStatus, "COMPENSATED");
    assert.deepEqual(faultDecision.compensatedSteps, [
      "settle-po-reserved-credit-to-used",
      "convert-po-reservation-to-allocation",
    ]);
    assert.equal(inventoryService.getSlot("WH-EAST", "SKU-1")?.quantityReserved, 5);
    assert.equal(inventoryService.getSlot("WH-EAST", "SKU-1")?.quantityAllocated, 0);
    assert.equal(b2bService.getCompany("comp-kronos-b2b")?.creditReserved, 285_000n);

    // 4. Supervisor Marcus approves cleanly -> converts MSI reservation to allocation and settles creditReserved -> creditUsed
    const okDecision = await b2bService.decidePendingPurchaseOrder({
      idempotencyKey: "idem_b2b_approve_ok",
      poId: "po_pend_2",
      approverId: "approver-marcus",
      decision: "APPROVE",
    });
    assert.equal(okDecision.po.status, "APPROVED_BY_SUPERVISOR");
    assert.equal(okDecision.order?.orderId, "ord_po_pend_2");
    assert.equal(inventoryService.getSlot("WH-EAST", "SKU-1")?.quantityReserved, 0);
    assert.equal(inventoryService.getSlot("WH-EAST", "SKU-1")?.quantityAllocated, 5);
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityReserved, 0);
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityAllocated, 10);
    assert.equal(b2bService.getCompany("comp-kronos-b2b")?.creditReserved, 0n);
    assert.equal(b2bService.getCompany("comp-kronos-b2b")?.creditUsed, 1_184_750n); // 899_750 + 285_000
  });

  it("deterministically reaps expired MSI reservations and transitions timed-out PENDING_APPROVAL B2B POs to EXPIRED_TTL", async () => {
    const {
      inventoryService,
      outboxService,
      orderStore,
      wfStore,
    } = createTestHarness();

    const b2bService = new B2bOrganizationService({
      inventoryService,
      outboxService,
      orderStore,
      workflowStateStore: wfStore,
    });
    const reaper = new ReservationTtlReaperService({
      inventoryService,
      b2bService,
      outboxService,
    });

    const baseNow = 1_763_300_000_000;

    // 1. Seed 1 expired B2B PO hold (4 units @ $750 -> $3,000 - 5% = $2,850 > $2,500 ceiling, TTL=60s created 180s ago)
    const expiredPoRes = await b2bService.submitPurchaseOrder({
      idempotencyKey: "idem_ttl_po_1",
      input: {
        poId: "po_ttl_exp_1",
        poNumber: "PO-TTL-1",
        companyId: "comp-kronos-b2b",
        costCenterId: "cc-hw-lab",
        buyerId: "buyer-elena",
        channelSlug: "us-b2b",
        ttlSecondsOverride: 60,
        nowMs: baseNow - 180_000,
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 825,
          lines: [
            {
              lineId: "L-TTL-1",
              variantId: "SKU-1",
              quantity: 4,
              baseUnitPrice: 75_000n,
              taxRateBps: 825,
            },
          ],
        },
      },
    });
    assert.equal(expiredPoRes.po.status, "PENDING_APPROVAL");
    assert.equal(inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityReserved, 4);
    assert.equal(b2bService.getCompany("comp-kronos-b2b")?.creditReserved, 285_000n);

    // 2. Seed 1 expired standalone checkout hold (2 units, TTL=30s created 90s ago)
    inventoryService.reserveForPurchaseOrder({
      holderId: "chk_hold_expired",
      demands: [{ lineId: "L-CHK-1", variantId: "SKU-1", quantity: 2 }],
      availabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
      strategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
      ttlSeconds: 30,
      nowMs: baseNow - 90_000,
    });

    // 3. Seed 1 active non-expired hold (3 units, TTL=3600s created now) -> MUST NOT be reaped!
    inventoryService.reserveForPurchaseOrder({
      holderId: "chk_hold_fresh",
      demands: [{ lineId: "L-CHK-2", variantId: "SKU-1", quantity: 3 }],
      availabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
      strategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
      ttlSeconds: 3600,
      nowMs: baseNow,
    });

    // Total reserved before reap: 4 + 2 + 3 = 9 units across WH-EAST/WH-CENTRAL
    const totalReservedBefore =
      (inventoryService.getSlot("WH-EAST", "SKU-1")?.quantityReserved ?? 0) +
      (inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityReserved ?? 0);
    assert.equal(totalReservedBefore, 9);

    // 4. Execute Reaper at baseNow -> reaps ONLY the 2 expired holds (6 units), leaving the 3u active hold untouched!
    const sweep1 = reaper.reapExpired(baseNow);
    assert.equal(sweep1.stockReap.reapedReservationCount, 2);
    assert.equal(sweep1.stockReap.totalUnitsReleased, 6);
    assert.equal(sweep1.expiredPos.length, 1);
    assert.equal(sweep1.expiredPos[0]?.status, "EXPIRED_TTL");
    assert.equal(b2bService.getCompany("comp-kronos-b2b")?.creditReserved, 0n);
    assert.equal(b2bService.getCostCenter("cc-hw-lab")?.monthlyReserved, 0n);

    const totalReservedAfter =
      (inventoryService.getSlot("WH-EAST", "SKU-1")?.quantityReserved ?? 0) +
      (inventoryService.getSlot("WH-CENTRAL", "SKU-1")?.quantityReserved ?? 0);
    assert.equal(totalReservedAfter, 3);
    assert.equal(inventoryService.listReservations("ACTIVE").length, 1);
    assert.equal(inventoryService.listReservations("ACTIVE")[0]?.holderId, "chk_hold_fresh");
    assert.equal(inventoryService.listReservations("EXPIRED").length, 2);

    // Outbox recorded both b2b.po.expired_ttl.v1 and inventory.reservation_ttl_reaped.v1
    const eventTypes = outboxService.listPending().map((e) => e.eventType);
    assert.equal(eventTypes.includes("b2b.po.expired_ttl.v1"), true);
    assert.equal(eventTypes.includes("inventory.reservation_ttl_reaped.v1"), true);

    // 5. Idempotent second reap at same timestamp releases 0 units
    const sweep2 = reaper.reapExpired(baseNow);
    assert.equal(sweep2.stockReap.reapedReservationCount, 0);
    assert.equal(sweep2.stockReap.totalUnitsReleased, 0);
  });
});

describe("@super-ecommerce/core — PostgreSQL Primary Stores (PgPoolLike)", () => {
  it("persists transactional outbox events in PG with atomic tx rollback, BigInt payload fidelity, SKIP LOCKED claim, exponential backoff, and DLQ replay", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      const outboxA = new PgTransactionalOutboxService(pg);
      const outboxB = new PgTransactionalOutboxService(pg);
      const baseMs = Date.parse("2026-11-16T12:00:00.000Z");

      // 1. Rolled-back transaction MUST roll back enqueued outbox event
      await assert.rejects(
        pg.withTransaction(async (tx) => {
          await outboxA.enqueue(
            {
              eventType: "order.rolled_back",
              aggregateType: "Order",
              aggregateId: "ord-rb-1",
              channelSlug: "us-retail",
              payload: { totalGrossAmount: 99_999n },
              nowIso: new Date(baseMs).toISOString(),
            },
            tx
          );
          throw new Error("SIMULATED_TX_ABORT");
        }),
        /SIMULATED_TX_ABORT/
      );
      assert.equal((await outboxA.listAll()).length, 0);

      // 2. Enqueue 2 healthy/flaky events + 1 poison pill with BigInt payloads
      const evt1 = await outboxA.enqueue({
        eventType: "order.created",
        aggregateType: "Order",
        aggregateId: "ord-pg-1",
        channelSlug: "us-retail",
        payload: { orderId: "ord-pg-1", totalGrossAmount: 42_500n },
        nowIso: new Date(baseMs).toISOString(),
      });
      const evt2 = await outboxA.enqueue({
        eventType: "order.created",
        aggregateType: "Order",
        aggregateId: "ord-pg-2",
        channelSlug: "us-retail",
        payload: { orderId: "ord-pg-2", totalGrossAmount: 18_250n },
        nowIso: new Date(baseMs + 10).toISOString(),
      });
      const poison = await outboxA.enqueue({
        eventType: "erp.poison",
        aggregateType: "Order",
        aggregateId: "ord-pg-poison",
        channelSlug: "us-retail",
        payload: { orderId: "ord-pg-poison", totalGrossAmount: 100n },
        nowIso: new Date(baseMs + 20).toISOString(),
      });

      assert.equal((await outboxB.listPending()).length, 3);
      assert.equal((evt1.payload as { totalGrossAmount: bigint }).totalGrossAmount, 42_500n);

      // 3. Concurrent claimDueBatch across two worker instances never double-claims the same event
      const [claimA, claimB] = await Promise.all([
        outboxA.claimDueBatch({ nowIso: new Date(baseMs + 50).toISOString(), batchSize: 2 }),
        outboxB.claimDueBatch({ nowIso: new Date(baseMs + 50).toISOString(), batchSize: 2 }),
      ]);
      const claimedIds = [...claimA.map((e) => e.id), ...claimB.map((e) => e.id)];
      assert.equal(claimedIds.length, 3);
      assert.equal(new Set(claimedIds).size, 3);

      // Release lease by verifying nothing is due before lease expiry, then expire lease after 31s
      const earlyClaim = await outboxA.claimDueBatch({
        nowIso: new Date(baseMs + 100).toISOString(),
        batchSize: 10,
      });
      assert.equal(earlyClaim.length, 0);

      // 4. OutboxRelayWorker handles retry -> self-heal, DLQ, and requeue
      let evt2Calls = 0;
      const deliveredBigInts: bigint[] = [];
      const worker = new OutboxRelayWorker({
        outboxService: outboxA,
        signingSecret: "pg_outbox_secret_2026",
        maxAttempts: 2,
        baseDelayMs: 1_000,
        subscribers: [
          {
            name: "pg-webhook-sink",
            eventPattern: "*",
            handle: (env) => {
              assert.equal(
                verifyOutboundOutboxSignature({
                  eventId: env.event.id,
                  rawPayloadJson: env.rawPayloadJson,
                  signatureHeader: env.headers["super-commerce-signature"],
                  signingSecret: "pg_outbox_secret_2026",
                }),
                true
              );
              const payload = env.event.payload as {
                orderId: string;
                totalGrossAmount: bigint;
              };
              if (payload.orderId === "ord-pg-poison") {
                throw new Error("ERP_PERMANENT_500");
              }
              if (payload.orderId === "ord-pg-2") {
                evt2Calls++;
                if (evt2Calls === 1) {
                  throw new Error("TRANSIENT_503");
                }
              }
              deliveredBigInts.push(payload.totalGrossAmount);
            },
          },
        ],
      });

      // Attempt 1 (after 31s lease expires): evt1 PUBLISHED, evt2 RETRY (+1s), poison RETRY (+1s)
      const pass1 = await worker.drainBatch({ nowMs: baseMs + 31_000 });
      assert.equal(pass1.claimedCount, 3);
      assert.equal(pass1.publishedCount, 1);
      assert.equal(pass1.retriedCount, 2);
      assert.equal(pass1.deadLetteredCount, 0);

      // Attempt 2 (+1.5s): evt2 self-heals (PUBLISHED), poison reaches maxAttempts=2 -> DEAD_LETTER
      const pass2 = await worker.drainBatch({ nowMs: baseMs + 32_500 });
      assert.equal(pass2.claimedCount, 2);
      assert.equal(pass2.publishedCount, 1);
      assert.equal(pass2.deadLetteredCount, 1);

      assert.deepEqual(deliveredBigInts, [42_500n, 18_250n]);
      assert.equal(evt2.id !== poison.id, true);

      const statsBeforeReplay = await outboxB.getStats();
      assert.deepEqual(statsBeforeReplay, {
        totalCount: 3,
        pendingCount: 0,
        publishedCount: 2,
        deadLetterCount: 1,
        selfHealedCount: 1,
      });

      // Requeue DLQ item and verify it returns to PENDING
      const requeued = await outboxB.requeueDeadLetters(
        poison.id,
        new Date(baseMs + 35_000).toISOString()
      );
      assert.equal(requeued, 1);
      assert.equal((await outboxA.listPending()).length, 1);
    } finally {
      await pg.close();
    }
  });

  it("enforces atomic MSI stock allocation, canonical FOR UPDATE locking, reservation lifecycle, and SKIP LOCKED reaping in PgMsiInventoryService", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      const invA = new PgMsiInventoryService(pg);
      const invB = new PgMsiInventoryService(pg);

      await invA.upsertExternalSlots([
        {
          warehouseId: "WH-EAST",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "SKU-PG-1",
          quantityOnHand: 5,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
        {
          warehouseId: "WH-CENTRAL",
          priorityRank: 2,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "SKU-PG-1",
          quantityOnHand: 3,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]);

      // preserveAllocated=true keeps existing allocated stock on external sync
      const initialSlot = await invB.getSlot("WH-EAST", "SKU-PG-1");
      assert.equal(initialSlot?.quantityOnHand, 5);
      assert.equal(initialSlot?.linkedToChannel, true);

      // Concurrent contention: total available = 8; two concurrent requests of 5 units each -> exactly 1 wins
      const results = await Promise.allSettled([
        invA.allocateForCheckout({
          demands: [{ lineId: "L1", variantId: "SKU-PG-1", quantity: 5 }],
          availabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          strategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        }),
        invB.allocateForCheckout({
          demands: [{ lineId: "L1", variantId: "SKU-PG-1", quantity: 5 }],
          availabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          strategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const whEastAfterAlloc = await invA.getSlot("WH-EAST", "SKU-PG-1");
      assert.equal(whEastAfterAlloc?.quantityAllocated, 5);

      // Upsert with preserveAllocated=true must not wipe out quantityAllocated=5
      await invA.upsertExternalSlots([
        {
          warehouseId: "WH-EAST",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "SKU-PG-1",
          quantityOnHand: 6,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]);
      assert.equal((await invB.getSlot("WH-EAST", "SKU-PG-1"))?.quantityAllocated, 5);

      // Release allocation and verify available returns cleanly
      if (fulfilled[0]?.status === "fulfilled") {
        await invA.releaseAllocations(fulfilled[0].value.allocations);
      }
      assert.equal((await invA.getSlot("WH-EAST", "SKU-PG-1"))?.quantityAllocated, 0);

      // Reserve for PO (expired vs fresh), convert & revert, restock RESELLABLE & DAMAGED_QUARANTINE, and reap with SKIP LOCKED
      const nowMs = Date.parse("2026-11-16T14:00:00.000Z");
      await invA.reserveForPurchaseOrder({
        holderId: "po-exp-1",
        demands: [{ lineId: "L-EXP", variantId: "SKU-PG-1", quantity: 2 }],
        availabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        strategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        ttlSeconds: 30,
        nowMs: nowMs - 60_000,
      });
      const activeRes = await invB.reserveForPurchaseOrder({
        holderId: "po-active-1",
        demands: [{ lineId: "L-ACT", variantId: "SKU-PG-1", quantity: 2 }],
        availabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        strategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        ttlSeconds: 3600,
        nowMs,
      });

      const [reap1, reap2] = await Promise.all([
        invA.reapExpiredReservations(nowMs),
        invB.reapExpiredReservations(nowMs),
      ]);
      assert.equal(reap1.totalUnitsReleased + reap2.totalUnitsReleased, 2);
      assert.equal((await invA.listReservations("EXPIRED")).length, 1);
      assert.equal((await invA.listReservations("ACTIVE")).length, 1);

      // Convert active reservation -> allocation -> revert -> convert -> restock (1 resellable, 1 damaged)
      await invA.convertReservationToAllocation("po-active-1", activeRes.reservationSlices);
      assert.equal((await invB.getSlot("WH-EAST", "SKU-PG-1"))?.quantityAllocated, 2);
      assert.equal((await invB.getSlot("WH-EAST", "SKU-PG-1"))?.quantityReserved, 0);

      await invA.revertReservationConversion("po-active-1", activeRes.reservationSlices);
      assert.equal((await invB.getSlot("WH-EAST", "SKU-PG-1"))?.quantityReserved, 2);
      assert.equal((await invB.getSlot("WH-EAST", "SKU-PG-1"))?.quantityAllocated, 0);

      await invA.convertReservationToAllocation("po-active-1", activeRes.reservationSlices);
      await invA.restockReturnedItems([
        {
          warehouseId: "WH-EAST",
          lineId: "L-ACT",
          variantId: "SKU-PG-1",
          quantityReturned: 1,
          condition: "RESELLABLE",
        },
        {
          warehouseId: "WH-EAST",
          lineId: "L-ACT",
          variantId: "SKU-PG-1",
          quantityReturned: 1,
          condition: "DAMAGED_QUARANTINE",
        },
      ]);
      const finalSlot = await invB.getSlot("WH-EAST", "SKU-PG-1");
      assert.equal(finalSlot?.quantityOnHand, 5); // 6 - 1 damaged
      assert.equal(finalSlot?.quantityAllocated, 0);
      assert.equal(finalSlot?.quantityReserved, 0);
    } finally {
      await pg.close();
    }
  });

  it("executes completeCheckoutWorkflow and multi-wave processReturnRefundWorkflow directly against PostgreSQL primary tables with LIFO compensation and zero Map stores", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      const wfStore = new PgWorkflowStateStore(pg);
      const inv = new PgMsiInventoryService(pg);
      const outbox = new PgTransactionalOutboxService(pg);

      await inv.upsertExternalSlots([
        {
          warehouseId: "WH-EAST",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "SKU-PG-SAGA",
          quantityOnHand: 10,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]);

      let storeCreditBalance = 2_000n;
      let capturedGatewayTotal = 0n;
      let refundedGatewayTotal = 0n;
      const storeCreditLedger: StoreCreditLedger = {
        async deduct(_customerId, amount) {
          storeCreditBalance -= amount;
          return { ledgerTxId: `sc_deduct_${Date.now()}` };
        },
        async restore(_customerId, _txId, amount) {
          storeCreditBalance += amount;
        },
      };
      const paymentGateway: PaymentGatewayStrategy = {
        async capture(p) {
          capturedGatewayTotal += p.amount;
          return {
            transactionId: `tx_${p.checkoutId}_${capturedGatewayTotal}`,
            provider: "stripe",
            capturedAmount: p.amount,
          };
        },
        async voidOrRefund(p) {
          refundedGatewayTotal += p.amount;
        },
      };

      const checkoutWf = buildCompleteCheckoutWorkflow({
        inventoryService: inv,
        paymentGateway,
        outboxService: outbox,
        storeCreditLedger,
        pgPool: pg,
      });

      const baseCart = {
        currencyCode: "USD" as const,
        taxMode: "TAX_EXCLUSIVE" as const,
        shippingBaseAmount: 1_000n,
        shippingTaxRateBps: 0,
        lines: [
          {
            lineId: "L1",
            variantId: "SKU-PG-SAGA",
            quantity: 2,
            baseUnitPrice: 2_500n, // 2 * $25.00 = $50.00 + $10.00 ship = $60.00 (6000c)
            taxRateBps: 0,
          },
        ],
      };

      // 1. Step 5 commit fault triggers LIFO compensation across MSI, store credit, and gateway
      const faultRes = await checkoutWf.execute(
        {
          checkoutId: "chk_pg_fault_1",
          channelSlug: "us-retail",
          customerId: "cust_pg_1",
          stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
          cart: baseCart,
          storeCreditToRedeem: 1_500n,
          paymentToken: "tok_visa_1",
          simulateCommitFault: true,
        },
        {
          idempotencyKey: "idem_pg_chk_fault",
          store: wfStore,
        }
      );
      assert.equal(faultRes.status, "COMPENSATED");
      assert.deepEqual(faultRes.compensatedSteps, [
        "capture-payment",
        "redeem-store-credit",
        "allocate-inventory",
      ]);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-PG-SAGA"))?.quantityAllocated, 0);
      assert.equal(storeCreditBalance, 2_000n);
      assert.equal(capturedGatewayTotal, 4_500n);
      assert.equal(refundedGatewayTotal, 4_500n);
      assert.equal((await pg.query("SELECT id FROM orders")).rows.length, 0);
      assert.equal((await outbox.listAll()).length, 0);

      // 2. Clean checkout commits PG order + outbox + allocated stock
      const okRes = await checkoutWf.execute(
        {
          checkoutId: "chk_pg_ok_1",
          channelSlug: "us-retail",
          customerId: "cust_pg_1",
          stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
          cart: baseCart,
          storeCreditToRedeem: 1_500n,
          paymentToken: "tok_visa_1",
        },
        {
          idempotencyKey: "idem_pg_chk_ok",
          store: wfStore,
        }
      );
      assert.equal(okRes.status, "COMPLETED");
      const committedOrder = okRes.output!;
      assert.equal(committedOrder.orderId, "ord_chk_pg_ok_1");
      assert.equal((await inv.getSlot("WH-EAST", "SKU-PG-SAGA"))?.quantityAllocated, 2);
      assert.equal(storeCreditBalance, 500n);

      const pgOrderRow = await pg.query<{
        id: string;
        payment_status: string;
        total_gross_amount: string;
        customer_id: string;
      }>(`SELECT id, payment_status, total_gross_amount, customer_id FROM orders WHERE id = $1`, [
        "ord_chk_pg_ok_1",
      ]);
      assert.equal(pgOrderRow.rows.length, 1);
      assert.equal(pgOrderRow.rows[0]?.payment_status, "CAPTURED");
      assert.equal(pgOrderRow.rows[0]?.total_gross_amount, "6000");
      assert.equal(pgOrderRow.rows[0]?.customer_id, "cust_pg_1");

      // 3. Instantiate a brand new RMA workflow with NO Map stores — loads order & prior returns from PG
      const rmaWf = buildProcessReturnRefundWorkflow({
        inventoryService: new PgMsiInventoryService(pg),
        paymentGateway,
        outboxService: new PgTransactionalOutboxService(pg),
        storeCreditLedger,
        pgPool: pg,
      });

      // Wave 1: return 1 unit RESELLABLE (2500c -> gateway cash first)
      const wave1 = await rmaWf.execute(
        {
          rmaId: "rma_pg_1",
          orderId: "ord_chk_pg_ok_1",
          linesToReturn: [{ lineId: "L1", quantity: 1, condition: "RESELLABLE" }],
          refundShipping: false,
          tenderPriority: "GATEWAY_CASH_FIRST",
        },
        {
          idempotencyKey: "idem_pg_rma_1",
          store: wfStore,
        }
      );
      assert.equal(wave1.status, "COMPLETED");
      assert.equal(wave1.output?.orderPaymentStatusAfter, "PARTIALLY_REFUNDED");
      assert.equal(wave1.output?.calculation.paymentGatewayRefundAmount, 2_500n);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-PG-SAGA"))?.quantityAllocated, 1);

      // Wave 2 fault: LIFO compensation restores inventory allocation, store credit, and gateway
      const wave2Fault = await rmaWf.execute(
        {
          rmaId: "rma_pg_2_fault",
          orderId: "ord_chk_pg_ok_1",
          linesToReturn: [{ lineId: "L1", quantity: 1, condition: "DAMAGED_QUARANTINE" }],
          refundShipping: true,
          tenderPriority: "GATEWAY_CASH_FIRST",
          simulateCommitFault: true,
        },
        {
          idempotencyKey: "idem_pg_rma_2_fault",
          store: wfStore,
        }
      );
      assert.equal(wave2Fault.status, "COMPENSATED");
      assert.deepEqual(wave2Fault.compensatedSteps, [
        "refund-payment-gateway",
        "restore-store-credit",
        "restock-msi-inventory",
      ]);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-PG-SAGA"))?.quantityAllocated, 1);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-PG-SAGA"))?.quantityOnHand, 10);
      assert.equal(storeCreditBalance, 500n);

      // Wave 2 clean: returns remaining 1 unit DAMAGED_QUARANTINE + shipping (2500c + 1000c = 3500c -> 2000c gateway + 1500c store credit)
      const wave2Ok = await rmaWf.execute(
        {
          rmaId: "rma_pg_2",
          orderId: "ord_chk_pg_ok_1",
          linesToReturn: [{ lineId: "L1", quantity: 1, condition: "DAMAGED_QUARANTINE" }],
          refundShipping: true,
          tenderPriority: "GATEWAY_CASH_FIRST",
        },
        {
          idempotencyKey: "idem_pg_rma_2_ok",
          store: wfStore,
        }
      );
      assert.equal(wave2Ok.status, "COMPLETED");
      assert.equal(wave2Ok.output?.orderPaymentStatusAfter, "REFUNDED");
      assert.equal(wave2Ok.output?.calculation.paymentGatewayRefundAmount, 2_000n);
      assert.equal(wave2Ok.output?.calculation.storeCreditRefundAmount, 1_500n);
      assert.equal(storeCreditBalance, 2_000n);

      const finalSlotAfterRma = await inv.getSlot("WH-EAST", "SKU-PG-SAGA");
      assert.equal(finalSlotAfterRma?.quantityAllocated, 0);
      assert.equal(finalSlotAfterRma?.quantityOnHand, 9);

      const pgOrderAfterRma = await pg.query<{ payment_status: string }>(
        `SELECT payment_status FROM orders WHERE id = $1`,
        ["ord_chk_pg_ok_1"]
      );
      assert.equal(pgOrderAfterRma.rows[0]?.payment_status, "REFUNDED");
      assert.equal(
        (await pg.query(`SELECT rma_id FROM order_returns WHERE order_id = $1`, ["ord_chk_pg_ok_1"]))
          .rows.length,
        2
      );
      const pendingOutbox = await outbox.listPending();
      assert.deepEqual(
        pendingOutbox.map((e) => e.eventType),
        ["order.created", "order.rma.refunded", "order.rma.refunded"]
      );
    } finally {
      await pg.close();
    }
  });

  it("verifies Stripe v1 webhooks and reconciles orders, MSI stock release, and outbox atomically in PgStripeWebhookService", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      const wfStore = new PgWorkflowStateStore(pg);
      const inv = new PgMsiInventoryService(pg);
      const outbox = new PgTransactionalOutboxService(pg);
      await inv.upsertExternalSlots([
        {
          warehouseId: "WH-EAST",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "SKU-WH-1",
          quantityOnHand: 8,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]);

      const checkoutWf = buildCompleteCheckoutWorkflow({
        inventoryService: inv,
        outboxService: outbox,
        pgPool: pg,
        paymentGateway: {
          async capture(p) {
            return {
              transactionId: `pi_${p.checkoutId}`,
              provider: "stripe",
              capturedAmount: p.amount,
            };
          },
          async voidOrRefund() {},
        },
      });

      await checkoutWf.execute(
        {
          checkoutId: "chk_wh_1",
          channelSlug: "us-retail",
          stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
          paymentToken: "tok_1",
          cart: {
            currencyCode: "USD",
            taxMode: "TAX_EXCLUSIVE",
            shippingBaseAmount: 0n,
            shippingTaxRateBps: 0,
            lines: [
              {
                lineId: "L1",
                variantId: "SKU-WH-1",
                quantity: 3,
                baseUnitPrice: 2_000n,
                taxRateBps: 0,
              },
            ],
          },
        },
        { idempotencyKey: "idem_wh_chk_1", store: wfStore }
      );
      assert.equal((await inv.getSlot("WH-EAST", "SKU-WH-1"))?.quantityAllocated, 3);

      const secret = "whsec_pg_test_2026";
      const webhookSvc = new PgStripeWebhookService({
        pool: pg,
        endpointSecrets: [secret],
        inventoryService: inv,
        outboxService: outbox,
      });

      const nowSec = 1_763_300_000;
      const failBody = JSON.stringify({
        id: "evt_pg_fail_1",
        type: "payment_intent.payment_failed",
        created: nowSec,
        data: {
          object: {
            id: "pi_failed_1",
            amount: 6000,
            currency: "usd",
            metadata: {
              orderId: "ord_chk_wh_1",
              checkoutId: "chk_wh_1",
              channelSlug: "us-retail",
            },
          },
        },
      });

      // Rejects tampered signature
      await assert.rejects(
        () =>
          webhookSvc.handleRawWebhook({
            rawBody: failBody,
            signatureHeader: `t=${nowSec},v1=${"0".repeat(64)}`,
            nowSeconds: nowSec,
          }),
        StripeWebhookVerificationError
      );

      const validSig = signStripeWebhookPayload({
        rawBody: failBody,
        secret,
        timestampSeconds: nowSec,
      });

      const res1 = await webhookSvc.handleRawWebhook({
        rawBody: failBody,
        signatureHeader: validSig,
        nowSeconds: nowSec,
      });
      assert.equal(res1.duplicate, false);
      assert.equal(res1.updatedPaymentStatus, "FAILED");
      assert.equal(res1.releasedWarehouseSlices, 1);

      // MSI allocation released cleanly back to available
      assert.equal((await inv.getSlot("WH-EAST", "SKU-WH-1"))?.quantityAllocated, 0);
      const pgOrd = await pg.query<{ payment_status: string }>(
        `SELECT payment_status FROM orders WHERE id = $1`,
        ["ord_chk_wh_1"]
      );
      assert.equal(pgOrd.rows[0]?.payment_status, "FAILED");

      // Replay with same event ID deduplicates atomically
      const resDup = await webhookSvc.handleRawWebhook({
        rawBody: failBody,
        signatureHeader: validSig,
        nowSeconds: nowSec,
      });
      assert.equal(resDup.duplicate, true);
      assert.equal(resDup.releasedWarehouseSlices, 0);

      // Fresh service reads processed webhook audit records directly from PG
      const freshWebhookSvc = new PgStripeWebhookService({
        pool: pg,
        endpointSecrets: [secret],
        inventoryService: new PgMsiInventoryService(pg),
        outboxService: new PgTransactionalOutboxService(pg),
      });
      const processed = await freshWebhookSvc.listProcessedEvents();
      assert.equal(processed.length, 1);
      assert.equal(processed[0]?.eventId, "evt_pg_fail_1");
      assert.equal(processed[0]?.amountMinorUnits, 6_000n);
    } finally {
      await pg.close();
    }
  });

  it("persists B2B hierarchy, Net-30 credit pools, 72h PO reservations, supervisor approval LIFO sagas, and TTL reaping in PG", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      const wfStore = new PgWorkflowStateStore(pg);
      const inv = new PgMsiInventoryService(pg);
      const outbox = new PgTransactionalOutboxService(pg);
      await inv.upsertExternalSlots([
        {
          warehouseId: "WH-EAST",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "SKU-B2B-PG",
          quantityOnHand: 20,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]);

      const b2b = new PgB2bOrganizationService({
        pool: pg,
        inventoryService: inv,
        outboxService: outbox,
        workflowStateStore: wfStore,
      });
      await b2b.seedDefaultEnterpriseHierarchy();

      // 1. Auto-approved PO persists PG order + PO + deducts creditUsed (5u @ $210 - 5% = 99_750c)
      const autoPo = await b2b.submitPurchaseOrder({
        idempotencyKey: "idem_pg_b2b_auto",
        input: {
          poId: "po_pg_auto_1",
          poNumber: "PO-PG-1001",
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
                lineId: "L-B2B-1",
                variantId: "SKU-B2B-PG",
                quantity: 5,
                baseUnitPrice: 24_000n,
                tierPrices: [{ minQuantity: 5, unitAmount: 21_000n }],
                taxRateBps: 825,
              },
            ],
          },
        },
      });
      assert.equal(autoPo.po.status, "APPROVED_AUTO");
      assert.equal(autoPo.order?.orderId, "ord_po_pg_auto_1");
      assert.equal((await inv.getSlot("WH-EAST", "SKU-B2B-PG"))?.quantityAllocated, 5);
      assert.equal((await b2b.getCompany("comp-kronos-b2b"))?.creditUsed, 899_750n);

      // 2. Pending approval PO (exceeds Elena's $2,500 limit): $3,000 - 5% = $2,850 (285_000c)
      const baseNow = Date.parse("2026-11-16T15:00:00.000Z");
      const pendPo = await b2b.submitPurchaseOrder({
        idempotencyKey: "idem_pg_b2b_pend",
        input: {
          poId: "po_pg_pend_2",
          poNumber: "PO-PG-1002",
          companyId: "comp-kronos-b2b",
          costCenterId: "cc-hw-lab",
          buyerId: "buyer-elena",
          channelSlug: "us-b2b",
          nowMs: baseNow,
          cart: {
            currencyCode: "USD",
            taxMode: "TAX_EXCLUSIVE",
            shippingBaseAmount: 0n,
            shippingTaxRateBps: 825,
            lines: [
              {
                lineId: "L-B2B-2",
                variantId: "SKU-B2B-PG",
                quantity: 10,
                baseUnitPrice: 30_000n,
                taxRateBps: 825,
              },
            ],
          },
        },
      });
      assert.equal(pendPo.po.status, "PENDING_APPROVAL");
      assert.equal((await inv.getSlot("WH-EAST", "SKU-B2B-PG"))?.quantityReserved, 10);
      assert.equal((await b2b.getCompany("comp-kronos-b2b"))?.creditReserved, 285_000n);

      // 3. Supervisor approval commit fault triggers LIFO compensation keeping reservation & creditReserved intact
      const faultApprove = await b2b.decidePendingPurchaseOrder({
        idempotencyKey: "idem_pg_b2b_fault",
        poId: "po_pg_pend_2",
        approverId: "approver-marcus",
        decision: "APPROVE",
        simulateCommitFault: true,
      });
      assert.equal(faultApprove.workflowStatus, "COMPENSATED");
      assert.deepEqual(faultApprove.compensatedSteps, [
        "settle-po-reserved-credit-to-used",
        "convert-po-reservation-to-allocation",
      ]);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-B2B-PG"))?.quantityReserved, 10);
      assert.equal((await b2b.getCompany("comp-kronos-b2b"))?.creditReserved, 285_000n);

      // 4. Clean supervisor approval from a fresh PgB2bOrganizationService instance
      const b2bFresh = new PgB2bOrganizationService({
        pool: pg,
        inventoryService: new PgMsiInventoryService(pg),
        outboxService: new PgTransactionalOutboxService(pg),
        workflowStateStore: wfStore,
      });
      const okApprove = await b2bFresh.decidePendingPurchaseOrder({
        idempotencyKey: "idem_pg_b2b_ok",
        poId: "po_pg_pend_2",
        approverId: "approver-marcus",
        decision: "APPROVE",
      });
      assert.equal(okApprove.po.status, "APPROVED_BY_SUPERVISOR");
      assert.equal(okApprove.order?.orderId, "ord_po_pg_pend_2");
      assert.equal((await inv.getSlot("WH-EAST", "SKU-B2B-PG"))?.quantityReserved, 0);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-B2B-PG"))?.quantityAllocated, 15);
      assert.equal((await b2bFresh.getCompany("comp-kronos-b2b"))?.creditUsed, 1_184_750n);

      // 5. Expired PO + PgReservationTtlReaperService transitions PO to EXPIRED_TTL and persists reservation_reaper_audit
      await b2bFresh.submitPurchaseOrder({
        idempotencyKey: "idem_pg_b2b_exp",
        input: {
          poId: "po_pg_exp_3",
          poNumber: "PO-PG-1003",
          companyId: "comp-kronos-b2b",
          costCenterId: "cc-hw-lab",
          buyerId: "buyer-elena",
          channelSlug: "us-b2b",
          ttlSecondsOverride: 60,
          nowMs: baseNow - 180_000,
          cart: {
            currencyCode: "USD",
            taxMode: "TAX_EXCLUSIVE",
            shippingBaseAmount: 0n,
            shippingTaxRateBps: 825,
            lines: [
              {
                lineId: "L-B2B-EXP",
                variantId: "SKU-B2B-PG",
                quantity: 4,
                baseUnitPrice: 75_000n,
                taxRateBps: 825,
              },
            ],
          },
        },
      });
      assert.equal((await inv.getSlot("WH-EAST", "SKU-B2B-PG"))?.quantityReserved, 4);

      const reaper = new PgReservationTtlReaperService({
        pool: pg,
        inventoryService: inv,
        b2bService: b2bFresh,
        outboxService: outbox,
      });
      const sweep = await reaper.reapExpired(baseNow);
      assert.equal(sweep.stockReap.reapedReservationCount, 1);
      assert.equal(sweep.stockReap.totalUnitsReleased, 4);
      assert.equal(sweep.expiredPos[0]?.status, "EXPIRED_TTL");
      assert.equal((await b2bFresh.getCompany("comp-kronos-b2b"))?.creditReserved, 0n);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-B2B-PG"))?.quantityReserved, 0);

      // Fresh reaper reads reservation_reaper_audit directly from PG
      const freshReaper = new PgReservationTtlReaperService({
        pool: pg,
        inventoryService: inv,
      });
      const history = await freshReaper.listAuditHistory();
      assert.equal(history.length, 1);
      assert.equal(history[0]?.reapedReservationsCount, 1);
      assert.equal(history[0]?.totalUnitsReleased, 4);
      assert.equal(history[0]?.releasedCreditMinorUnits, 285_000n);
    } finally {
      await pg.close();
    }
  });

  it("orchestrates fulfillment dispatch and pre-fulfillment order cancellation directly in PostgreSQL 17 with LIFO compensation", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      const wfStore = new PgWorkflowStateStore(pg);
      const inv = new PgMsiInventoryService(pg);
      const outbox = new PgTransactionalOutboxService(pg);

      await inv.upsertExternalSlots([
        {
          warehouseId: "WH-EAST",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "SKU-FULFILL-1",
          quantityOnHand: 15,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]);

      let paymentVoidCalls = 0;
      const paymentGateway: PaymentGatewayStrategy = {
        async capture(p) {
          return {
            transactionId: `pi_${p.checkoutId}`,
            provider: "stripe",
            capturedAmount: p.amount,
          };
        },
        async voidOrRefund() {
          paymentVoidCalls += 1;
        },
      };

      const checkoutWf = buildCompleteCheckoutWorkflow({
        inventoryService: inv,
        outboxService: outbox,
        pgPool: pg,
        paymentGateway,
      });

      // 1. Checkout Order A (3 units)
      const resA = await checkoutWf.execute(
        {
          checkoutId: "chk_order_a",
          channelSlug: "us-retail",
          stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
          paymentToken: "tok_visa_a",
          cart: {
            currencyCode: "USD",
            taxMode: "TAX_EXCLUSIVE",
            shippingBaseAmount: 0n,
            shippingTaxRateBps: 0,
            lines: [
              {
                lineId: "LA1",
                variantId: "SKU-FULFILL-1",
                quantity: 3,
                baseUnitPrice: 5_000n,
                taxRateBps: 0,
              },
            ],
          },
        },
        { idempotencyKey: "idem_order_a_checkout", store: wfStore }
      );
      assert.equal(resA.status, "COMPLETED");
      const orderAId = resA.output!.orderId;
      assert.equal((await inv.getSlot("WH-EAST", "SKU-FULFILL-1"))?.quantityAllocated, 3);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-FULFILL-1"))?.quantityOnHand, 15);

      // 2. Pre-fulfillment Cancellation of Order A
      const cancelWf = buildCancelOrderWorkflow({
        inventoryService: inv,
        paymentGateway,
        outboxService: outbox,
        pgPool: pg,
      });

      const cancelRes = await cancelWf.execute(
        {
          orderId: orderAId,
          reason: "Customer requested pre-dispatch cancellation",
        },
        { idempotencyKey: "idem_order_a_cancel", store: wfStore }
      );
      assert.equal(cancelRes.status, "COMPLETED");
      assert.equal(cancelRes.output?.status, "CANCELLED");
      assert.equal(cancelRes.output?.releasedStockUnits, 3);
      assert.equal(paymentVoidCalls, 1);

      // Stock is released back to available pool
      assert.equal((await inv.getSlot("WH-EAST", "SKU-FULFILL-1"))?.quantityAllocated, 0);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-FULFILL-1"))?.quantityOnHand, 15);

      // Order status updated in PG
      const orderARow = await pg.query<{ fulfillment_status: string; payment_status: string; cancel_reason: string }>(
        "SELECT fulfillment_status, payment_status, cancel_reason FROM orders WHERE id = $1",
        [orderAId]
      );
      assert.equal(orderARow.rows[0]?.fulfillment_status, "CANCELLED");
      assert.equal(orderARow.rows[0]?.payment_status, "VOIDED");
      assert.equal(orderARow.rows[0]?.cancel_reason, "Customer requested pre-dispatch cancellation");

      // Repeated cancellation is rejected
      const repeatCancelRes = await cancelWf.execute(
        { orderId: orderAId },
        { idempotencyKey: "idem_order_a_repeat_cancel", store: wfStore }
      );
      assert.equal(repeatCancelRes.status, "COMPENSATED");
      assert.match(repeatCancelRes.error?.message ?? "", /already cancelled/);

      // Fulfilling cancelled order is rejected
      const fulfillWf = buildFulfillmentDispatchWorkflow({
        inventoryService: inv,
        outboxService: outbox,
        pgPool: pg,
      });
      const rejectedFulfillRes = await fulfillWf.execute(
        { orderId: orderAId },
        { idempotencyKey: "idem_order_a_fulfill_rejected", store: wfStore }
      );
      assert.equal(rejectedFulfillRes.status, "COMPENSATED");
      assert.match(rejectedFulfillRes.error?.message ?? "", /Cannot fulfill cancelled order/);

      // 3. Checkout Order B (4 units)
      const resB = await checkoutWf.execute(
        {
          checkoutId: "chk_order_b",
          channelSlug: "us-retail",
          stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
          paymentToken: "tok_visa_b",
          cart: {
            currencyCode: "USD",
            taxMode: "TAX_EXCLUSIVE",
            shippingBaseAmount: 0n,
            shippingTaxRateBps: 0,
            lines: [
              {
                lineId: "LB1",
                variantId: "SKU-FULFILL-1",
                quantity: 4,
                baseUnitPrice: 5_000n,
                taxRateBps: 0,
              },
            ],
          },
        },
        { idempotencyKey: "idem_order_b_checkout", store: wfStore }
      );
      assert.equal(resB.status, "COMPLETED");
      const orderBId = resB.output!.orderId;
      assert.equal((await inv.getSlot("WH-EAST", "SKU-FULFILL-1"))?.quantityAllocated, 4);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-FULFILL-1"))?.quantityOnHand, 15);

      // 4. Test LIFO compensation on simulated fulfillment fault
      const faultFulfillRes = await fulfillWf.execute(
        {
          orderId: orderBId,
          simulateFulfillmentFault: true,
        },
        { idempotencyKey: "idem_order_b_fault_fulfill", store: wfStore }
      );
      assert.equal(faultFulfillRes.status, "COMPENSATED");
      assert.deepEqual(faultFulfillRes.compensatedSteps, ["deduct-msi-stock"]);
      // Allocated and on-hand stock restored on failure
      assert.equal((await inv.getSlot("WH-EAST", "SKU-FULFILL-1"))?.quantityAllocated, 4);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-FULFILL-1"))?.quantityOnHand, 15);

      // 5. Successful Fulfillment Dispatch
      const fulfillRes = await fulfillWf.execute(
        {
          orderId: orderBId,
          carrier: "DHL Express",
          trackingNumber: "TRACK-DHLE-2026",
          createdBy: "ops@super-ecommerce.com",
        },
        { idempotencyKey: "idem_order_b_ok_fulfill", store: wfStore }
      );
      assert.equal(fulfillRes.status, "COMPLETED");
      assert.equal(fulfillRes.output?.status, "FULFILLED");
      assert.equal(fulfillRes.output?.carrier, "DHL Express");
      assert.equal(fulfillRes.output?.trackingNumber, "TRACK-DHLE-2026");

      // Physical stock deducted from MSI warehouse
      assert.equal((await inv.getSlot("WH-EAST", "SKU-FULFILL-1"))?.quantityAllocated, 0);
      assert.equal((await inv.getSlot("WH-EAST", "SKU-FULFILL-1"))?.quantityOnHand, 11); // 15 - 4 = 11

      // Database tables verified
      const orderBRow = await pg.query<{ fulfillment_status: string }>(
        "SELECT fulfillment_status FROM orders WHERE id = $1",
        [orderBId]
      );
      assert.equal(orderBRow.rows[0]?.fulfillment_status, "FULFILLED");

      const fulfillRows = await pg.query<{ fulfillment_id: string; tracking_number: string }>(
        "SELECT fulfillment_id, tracking_number FROM order_fulfillments WHERE order_id = $1",
        [orderBId]
      );
      assert.equal(fulfillRows.rows.length, 1);
      assert.equal(fulfillRows.rows[0]?.tracking_number, "TRACK-DHLE-2026");

      const lineRows = await pg.query<{ quantity: string | number }>(
        "SELECT quantity FROM order_fulfillment_lines WHERE order_id = $1",
        [orderBId]
      );
      assert.equal(lineRows.rows.length, 1);
      assert.equal(Number(lineRows.rows[0]?.quantity), 4);

      // Attempting to cancel already fulfilled order is rejected
      const alreadyFulfilledCancelRes = await cancelWf.execute(
        { orderId: orderBId },
        { idempotencyKey: "idem_order_b_cancel_after_fulfill", store: wfStore }
      );
      assert.equal(alreadyFulfilledCancelRes.status, "COMPENSATED");
      assert.match(
        alreadyFulfilledCancelRes.error?.message ?? "",
        /Cannot cancel already fulfilled order/
      );

      // Transactional outbox events verified
      const outboxEvents = await outbox.listPending();
      const eventTypes = outboxEvents.map((e) => e.eventType);
      assert.equal(eventTypes.includes("order.cancelled.v1"), true);
      assert.equal(eventTypes.includes("inventory.stock_released.v1"), true);
      assert.equal(eventTypes.includes("fulfillment.dispatched.v1"), true);
      assert.equal(eventTypes.includes("fulfillment.3pl_dispatch_manifest"), true);
    } finally {
      await pg.close();
    }
  });

  it("manages customers and append-only store credit ledger in PostgreSQL with overdraft prevention, row locking, and dynamic RBAC roles with immutable audit logs", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);

    try {
      // 1. Customers Service & Store Credit Ledger
      const customersService = new PgCustomersService(pg);

      const cust1 = await customersService.createCustomer({
        customerId: "cust_ada_01",
        email: "ada.lovelace@example.com",
        fullName: "Ada Lovelace",
        defaultChannelSlug: "us-retail",
        currencyCode: "USD",
        note: "VIP account",
      });
      assert.equal(cust1.customerId, "cust_ada_01");
      assert.equal(cust1.email, "ada.lovelace@example.com");
      assert.equal(cust1.storeCreditBalance, 0n);

      // Verify retrieval by ID and by email
      const fetchedById = await customersService.getCustomer("cust_ada_01");
      assert.equal(fetchedById?.email, "ada.lovelace@example.com");
      const fetchedByEmail = await customersService.getCustomerByEmail("ada.lovelace@example.com");
      assert.equal(fetchedByEmail?.customerId, "cust_ada_01");

      // Duplicate email is rejected by unique constraint
      await assert.rejects(
        () => customersService.createCustomer({
          email: "ada.lovelace@example.com",
          fullName: "Ada Duplicate",
        }),
        /unique/i
      );

      // Add store credit: +$50.00 (5000 minor units)
      const creditEntry1 = await customersService.addStoreCredit({
        customerId: "cust_ada_01",
        amount: 5000n,
        reason: "PROMOTIONAL_CREDIT",
        referenceType: "MARKETING_CAMPAIGN",
        referenceId: "camp_spring_2026",
      });
      assert.equal(creditEntry1.deltaAmount, 5000n);
      assert.equal(creditEntry1.balanceAfter, 5000n);
      assert.equal(await customersService.getBalance("cust_ada_01"), 5000n);

      // Deduct store credit for checkout: -$20.00 (2000 minor units)
      const deductRes = await customersService.deduct("cust_ada_01", 2000n, "order_chk_999");
      assert.equal(deductRes.balanceAfter, 3000n);
      assert.equal(await customersService.getBalance("cust_ada_01"), 3000n);

      // Overdraft rejection: attempt -$40.00 with only $30.00 available
      await assert.rejects(
        () => customersService.deduct("cust_ada_01", 4000n),
        /Insufficient store credit balance/
      );

      // Balance unchanged after failed overdraft
      assert.equal(await customersService.getBalance("cust_ada_01"), 3000n);

      // Restore store credit on compensation: +$20.00
      await customersService.restore("cust_ada_01", deductRes.ledgerTxId, 2000n);
      assert.equal(await customersService.getBalance("cust_ada_01"), 5000n);

      // Direct SQL check confirms append-only ledger rows
      const ledgerRows = await pg.query<{ delta_amount: string; balance_after: string; reason: string }>(
        "SELECT delta_amount, balance_after, reason FROM store_credit_ledger WHERE customer_id = $1 ORDER BY created_at ASC",
        ["cust_ada_01"]
      );
      assert.equal(ledgerRows.rows.length, 3);
      assert.equal(BigInt(ledgerRows.rows[0]!.delta_amount), 5000n);
      assert.equal(BigInt(ledgerRows.rows[0]!.balance_after), 5000n);
      assert.equal(BigInt(ledgerRows.rows[1]!.delta_amount), -2000n);
      assert.equal(BigInt(ledgerRows.rows[1]!.balance_after), 3000n);
      assert.equal(BigInt(ledgerRows.rows[2]!.delta_amount), 2000n);
      assert.equal(BigInt(ledgerRows.rows[2]!.balance_after), 5000n);

      // 2. Dynamic RBAC Service & Audit Logs
      const rbacService = new PgAdminAuthRbacService(pg);
      await rbacService.seedInitialRolesAndUsers();

      // System roles and users seeded in PostgreSQL
      const initialRoles = await rbacService.listRoles();
      assert.equal(initialRoles.length >= 3, true);
      assert.equal(initialRoles.some((r) => r.roleSlug === "SUPER_ADMIN"), true);

      const initialUsers = await rbacService.listUsers();
      assert.equal(initialUsers.length >= 3, true);
      assert.equal(initialUsers.some((u) => u.email === "admin@kronos.io"), true);

      // Successful password authentication with constant-time check
      const authSuccess = await rbacService.authenticateWithPassword("admin@kronos.io", "Kronos!Admin2026");
      assert.equal(authSuccess.ok, true);
      assert.equal(authSuccess.principal?.role, "SUPER_ADMIN");
      assert.equal(authSuccess.audit.decision, "ALLOW");
      assert.equal(authSuccess.audit.httpStatus, 200);
      assert.equal(Boolean(authSuccess.sessionToken), true);

      // Failed password authentication
      const authFail = await rbacService.authenticateWithPassword("admin@kronos.io", "WrongPassword");
      assert.equal(authFail.ok, false);
      assert.equal(authFail.audit.decision, "DENY_401");
      assert.equal(authFail.audit.httpStatus, 401);

      // Authorization with SUPER_ADMIN on privileged endpoint
      const superAuth = await rbacService.authorizeAction({
        token: authSuccess.sessionToken,
        requiredPermission: "configurator:deploy_dag",
        actionLabel: "Deploy Configurator DAG",
      });
      assert.equal(superAuth.allowed, true);
      assert.equal(superAuth.httpStatus, 200);

      // FINANCE_AUDITOR login and 403 Forbidden check
      const auditLogin = await rbacService.authenticateWithPassword("audit@kronos.io", "Kronos!Audit2026");
      assert.equal(auditLogin.ok, true);
      const auditorAuth = await rbacService.authorizeAction({
        token: auditLogin.sessionToken,
        requiredPermission: "configurator:deploy_dag",
        actionLabel: "Deploy Configurator DAG",
      });
      assert.equal(auditorAuth.allowed, false);
      assert.equal(auditorAuth.httpStatus, 403);

      // Dynamic custom role creation in PostgreSQL
      const supportRole = await rbacService.createOrUpdateRole({
        roleSlug: "SUPPORT_SPECIALIST",
        displayName: "Customer Support Specialist",
        description: "Diagnose price waterfalls and customer orders",
        permissions: ["mcp:diagnose"],
      });
      assert.equal(supportRole.roleSlug, "SUPPORT_SPECIALIST");

      // Dynamic admin user creation
      const supportUser = await rbacService.createAdminUser({
        adminId: "adm_support_01",
        email: "support@kronos.io",
        displayName: "Grace Hopper",
        roleSlug: "SUPPORT_SPECIALIST",
        passwordPlain: "Support!Pass2026",
      });
      assert.equal(supportUser.roleSlug, "SUPPORT_SPECIALIST");

      // Support user login
      const supportLogin = await rbacService.authenticateWithPassword("support@kronos.io", "Support!Pass2026");
      assert.equal(supportLogin.ok, true);

      // Allowed for granted permission
      const permAllowed = await rbacService.authorizeAction({
        token: supportLogin.sessionToken,
        requiredPermission: "mcp:diagnose",
        actionLabel: "Diagnose Waterfall",
      });
      assert.equal(permAllowed.allowed, true);

      // Blocked for non-granted permission
      const permBlocked = await rbacService.authorizeAction({
        token: supportLogin.sessionToken,
        requiredPermission: "chaos:inject_faults",
        actionLabel: "Inject Chaos Fault",
      });
      assert.equal(permBlocked.allowed, false);
      assert.equal(permBlocked.httpStatus, 403);

      // Dynamically grant chaos:inject_faults to SUPPORT_SPECIALIST in PostgreSQL
      await rbacService.createOrUpdateRole({
        roleSlug: "SUPPORT_SPECIALIST",
        displayName: "Customer Support Specialist",
        description: "Diagnose waterfalls and inject recovery drills",
        permissions: ["mcp:diagnose", "chaos:inject_faults"],
      });

      // Existing session token now immediately authorizes without re-login!
      const permNowAllowed = await rbacService.authorizeAction({
        token: supportLogin.sessionToken,
        requiredPermission: "chaos:inject_faults",
        actionLabel: "Inject Chaos Fault",
      });
      assert.equal(permNowAllowed.allowed, true);
      assert.equal(permNowAllowed.httpStatus, 200);

      // Verify immutable audit logs in PostgreSQL table
      const auditLogs = await rbacService.listAuditLogs(20);
      assert.equal(auditLogs.length >= 6, true);
      const authActions = auditLogs.map((a) => a.action.toUpperCase());
      assert.equal(authActions.some((a) => a.includes("LOGIN (SUCCESS)")), true);
      assert.equal(authActions.some((a) => a.includes("LOGIN (FAILED)")), true);
      assert.equal(authActions.some((a) => a.includes("INJECT CHAOS FAULT")), true);
    } finally {
      await pg.close();
    }
  });

  it("enforces 16-shard slotted flash-sale stock concurrency, HOT availability updates, normalized order_lines analytics, and balanced Double-Entry Subledger", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      // 1. 16-Shard Flash-Sale Inventory: 35 concurrent buyers competing for 20 units -> exact 20 succeed, 15 fail, 0 oversold
      const slotted = new PgSlottedInventoryService(pg, { shardCount: 16 });
      await slotted.seedShardedStock({
        warehouseId: "WH-FLASH",
        variantId: "SKU-LIMITED-DROP",
        totalQuantity: 20,
      });

      const outcomes = await Promise.allSettled(
        Array.from({ length: 35 }, (_, idx) =>
          slotted.claimFlashSaleStock({
            lineId: `flash-line-${idx}`,
            warehouseId: "WH-FLASH",
            variantId: "SKU-LIMITED-DROP",
            quantity: 1,
          })
        )
      );

      const succeeded = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");
      assert.equal(succeeded.length, 20);
      assert.equal(rejected.length, 15);

      const postDropBalances = await slotted.getTotalBalances("WH-FLASH", "SKU-LIMITED-DROP");
      assert.equal(postDropBalances.totalAvailable, 0);
      assert.equal(postDropBalances.totalAllocated, 20);

      // Hot/Cold CQRS split update
      await slotted.upsertHotAvailability({
        channelSlug: "us-retail",
        productId: "prod-drop-1",
        isInStock: false,
        totalAvailableQty: 0,
      });
      const hotSnap = await slotted.getHotAvailability("us-retail", "prod-drop-1");
      assert.equal(hotSnap?.isInStock, false);
      assert.equal(hotSnap?.totalAvailableQty, 0);

      // 2. Checkout + Partial RMA with Restocking Fee -> Normalized order_lines + Balanced Double-Entry Subledger
      const inv = new PgMsiInventoryService(pg);
      await inv.upsertExternalSlots([
        {
          warehouseId: "WH-EAST",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "SKU-TI-KB",
          quantityOnHand: 10,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]);
      const outbox = new PgTransactionalOutboxService(pg);
      const wfStore = new PgWorkflowStateStore(pg);
      const custSvc = new PgCustomersService(pg);
      await custSvc.createCustomer({
        customerId: "cust-ledger-1",
        email: "ledger@kronos.io",
        fullName: "Ledger Buyer",
      });
      await custSvc.addStoreCredit({
        customerId: "cust-ledger-1",
        amount: 5_000n,
        reason: "Initial credit",
      });

      const gateway: PaymentGatewayStrategy = {
        async capture({ checkoutId, amount }) {
          return { transactionId: `pi_${checkoutId}`, provider: "stripe", capturedAmount: amount };
        },
        async voidOrRefund() {},
      };

      const checkoutWf = buildCompleteCheckoutWorkflow({
        inventoryService: inv,
        paymentGateway: gateway,
        outboxService: outbox,
        storeCreditLedger: custSvc,
        pgPool: pg,
      });
      const rmaWf = buildProcessReturnRefundWorkflow({
        inventoryService: inv,
        paymentGateway: gateway,
        outboxService: outbox,
        storeCreditLedger: custSvc,
        pgPool: pg,
      });

      const chkRes = await checkoutWf.execute(
        {
          checkoutId: "chk-ledger-01",
          channelSlug: "us-retail",
          customerId: "cust-ledger-1",
          stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
          storeCreditToRedeem: 2_000n,
          paymentToken: "tok_stripe_live",
          cart: {
            currencyCode: "USD",
            taxMode: "TAX_EXCLUSIVE",
            shippingBaseAmount: 1_000n,
            shippingTaxRateBps: 1_000, // 10%
            lines: [
              {
                lineId: "L-KB",
                variantId: "SKU-TI-KB",
                quantity: 2,
                baseUnitPrice: 10_000n, // $200.00 subtotal + $20 tax = $220; + $11 shipping = $231.00 (23_100)
                taxRateBps: 1_000,
              },
            ],
          },
        },
        { idempotencyKey: "idem-chk-ledger-01", store: wfStore }
      );
      assert.equal(chkRes.status, "COMPLETED");

      // Return 1 of 2 keyboards with a 10% restocking fee (1000 bps)
      const rmaRes = await rmaWf.execute(
        {
          rmaId: "rma-ledger-01",
          orderId: "ord_chk-ledger-01",
          linesToReturn: [{ lineId: "L-KB", quantity: 1, restockingFeeBps: 1_000 }],
        },
        { idempotencyKey: "idem-rma-ledger-01", store: wfStore }
      );
      assert.equal(rmaRes.status, "COMPLETED");

      // Verify normalized order_lines analytics
      const ordersRepo = new PgOrdersRepository(pg);
      const skuStats = await ordersRepo.getSkuRevenueAnalytics({ channelSlug: "us-retail" });
      assert.equal(skuStats.length, 1);
      assert.equal(skuStats[0]?.variantId, "SKU-TI-KB");
      assert.equal(skuStats[0]?.unitsSold, 2);
      assert.equal(skuStats[0]?.totalNetAmount, 20_000n);
      assert.equal(skuStats[0]?.totalTaxAmount, 2_000n);
      assert.equal(skuStats[0]?.totalGrossAmount, 22_000n);

      // Verify Double-Entry Subledger Trial Balance is 100% balanced (Debits === Credits)
      const subledger = new PgDoubleEntryLedgerService(pg);
      const trialBalance = await subledger.getTrialBalance("USD");
      assert.equal(trialBalance.isBalanced, true);
      assert.ok(trialBalance.grandTotalDebits > 0n);
      assert.equal(trialBalance.grandTotalDebits, trialBalance.grandTotalCredits);

      // Unbalanced manual posting must be rejected by UnbalancedJournalError
      await assert.rejects(
        () =>
          subledger.recordJournalEntry({
            idempotencyKey: "bad-journal-1",
            referenceType: "MANUAL_ADJUSTMENT",
            referenceId: "adj-1",
            channelSlug: "us-retail",
            currencyCode: "USD",
            postings: [
              { accountCode: "CASH_GATEWAY_CLEARING", direction: "DEBIT", amount: 500n },
              { accountCode: "MERCHANT_SALES_REVENUE", direction: "CREDIT", amount: 499n },
            ],
          }),
        UnbalancedJournalError
      );
    } finally {
      await pg.close();
    }
  });

  it("executes C-end customer auth, persistent cart guest-to-member merge, Stripe PaymentIntent 3DS/REST state machine, and OMS pre-fulfillment Order Editing", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      const custCart = new PgCustomerAuthAndCartService(pg);

      // 1. Register member & seed 2 keyboards in member cart ($390 base, $340 at qty >= 5)
      const reg = await custCart.registerCustomer({
        email: "claire@kronos.io",
        passwordPlain: "Claire!Shopper2026",
        fullName: "Claire Mercer",
        defaultChannelSlug: "us-retail",
        currencyCode: "USD",
      });
      assert.equal(custCart.verifyCustomerSessionToken(reg.sessionToken).valid, true);

      const addr1 = await custCart.saveAddress({
        customerId: reg.customer.customerId,
        label: "Home",
        recipientName: "Claire Mercer",
        line1: "400 Market St",
        city: "San Francisco",
        postalCode: "94105",
        countryCode: "US",
        isDefaultShipping: true,
      });
      assert.equal(addr1.isDefaultShipping, true);

      const memberCart = await custCart.createOrGetActiveCart({
        channelSlug: "us-retail",
        currencyCode: "USD",
        customerId: reg.customer.customerId,
      });
      await custCart.upsertCartLine({
        cartId: memberCart.cartId,
        variantId: "VAR-KB-75",
        sku: "KR-KB75-TI",
        title: "Kronos Field 75",
        quantity: 2,
        baseUnitPrice: 39_000n,
        tierPrices: [{ minQuantity: 5, unitAmount: 34_000n }],
      });

      // 2. Anonymous visitor creates guest cart with 3 keyboards + $15 voucher
      const guestCart = await custCart.createOrGetActiveCart({
        channelSlug: "us-retail",
        currencyCode: "USD",
        guestToken: "guest_sess_abc123",
      });
      await custCart.upsertCartLine({
        cartId: guestCart.cartId,
        variantId: "VAR-KB-75",
        sku: "KR-KB75-TI",
        title: "Kronos Field 75",
        quantity: 3,
        baseUnitPrice: 39_000n,
        tierPrices: [{ minQuantity: 5, unitAmount: 34_000n }],
      });
      await custCart.applyCartVoucher({
        cartId: guestCart.cartId,
        voucherCode: "SAVE15",
        discount: {
          discountId: "vouch-save15",
          name: "$15 Welcome Voucher",
          kind: "ORDER_VOUCHER",
          value: { type: "FIXED", amount: 1_500n },
        },
      });

      // 3. Login with guestCartId -> atomic merge yields 5 units @ $340 ($1,700) - $15 voucher = $1,685 (168_500n)!
      const loginRes = await custCart.authenticateCustomer({
        email: "claire@kronos.io",
        passwordPlain: "Claire!Shopper2026",
        guestCartId: guestCart.cartId,
      });
      assert.equal(loginRes.ok, true);
      assert.equal(loginRes.mergedCart?.lines[0]?.quantity, 5);
      assert.equal(loginRes.mergedCart?.pricing.lines[0]?.effectiveBaseUnitPrice, 34_000n);
      assert.equal(loginRes.mergedCart?.pricing.totalGrossAmount, 168_500n);
      const oldGuestAfter = await custCart.getHydratedCart(guestCart.cartId);
      assert.equal(oldGuestAfter?.status, "MERGED");

      // 4. Stripe Live REST Mode verification (verifying Bearer auth, Idempotency-Key, form body)
      const stripeRestCalls: { url: string; idemKey: string | null; body: string }[] = [];
      const liveModePiService = new PgStripePaymentIntentService({
        pool: pg,
        stripeSecretKey: "sk_test_mock_key_2026",
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          const u = String(url);
          const headers = new Headers(init?.headers);
          stripeRestCalls.push({
            url: u,
            idemKey: headers.get("idempotency-key"),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              id: "pi_live_rest_001",
              client_secret: "pi_live_rest_001_secret_xyz",
              status: "succeeded",
              amount: 168500,
              amount_capturable: 0,
              amount_received: 168500,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }) as typeof fetch,
      });

      const livePi = await liveModePiService.createPaymentIntent({
        idempotencyKey: "idem-stripe-live-1",
        checkoutId: "chk-live-1",
        channelSlug: "us-retail",
        currencyCode: "USD",
        amount: 168_500n,
        paymentMethodToken: "pm_card_visa",
        confirmImmediately: true,
      });
      assert.equal(livePi.providerMode, "STRIPE_LIVE_API");
      assert.equal(livePi.paymentIntentId, "pi_live_rest_001");
      assert.equal(stripeRestCalls.length, 1);
      assert.equal(stripeRestCalls[0]?.idemKey, "idem-stripe-live-1");
      assert.match(stripeRestCalls[0]?.body ?? "", /amount=168500/);

      // 5. Stripe 3DS + Two-Phase Manual Capture -> Checkout -> OMS Pre-Fulfillment Order Editing
      const localStripe = new PgStripePaymentIntentService({ pool: pg });
      const pi3ds = await localStripe.createPaymentIntent({
        idempotencyKey: "idem-3ds-1",
        checkoutId: "chk-oms-edit-1",
        channelSlug: "us-retail",
        currencyCode: "USD",
        amount: 22_000n, // 2 units @ $100 + 10% tax = $220.00
        captureMethod: "manual",
        paymentMethodToken: "pm_card_3ds_required",
        confirmImmediately: true,
      });
      assert.equal(pi3ds.status, "requires_action");
      assert.ok(pi3ds.nextActionRedirectUrl);

      const after3ds = await localStripe.complete3dsChallenge(pi3ds.paymentIntentId);
      assert.equal(after3ds.status, "requires_capture");
      assert.equal(after3ds.amountCapturable, 22_000n);

      const inv = new PgMsiInventoryService(pg);
      await inv.upsertExternalSlots([
        {
          warehouseId: "WH-EAST",
          priorityRank: 1,
          linkedToChannel: true,
          supportsShippingZone: true,
          variantId: "VAR-DAC",
          quantityOnHand: 10,
          quantityReserved: 0,
          quantityAllocated: 0,
        },
      ]);
      const outbox = new PgTransactionalOutboxService(pg);
      const wfStore = new PgWorkflowStateStore(pg);
      const stripeStrategy = localStripe.asPaymentGatewayStrategy("us-retail");

      const checkoutWf = buildCompleteCheckoutWorkflow({
        inventoryService: inv,
        paymentGateway: stripeStrategy,
        outboxService: outbox,
        pgPool: pg,
      });

      const chkRes = await checkoutWf.execute(
        {
          checkoutId: "chk-oms-edit-1",
          channelSlug: "us-retail",
          customerId: reg.customer.customerId,
          stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
          paymentToken: pi3ds.paymentIntentId, // Captures the pre-authorized 3DS PaymentIntent!
          cart: {
            currencyCode: "USD",
            taxMode: "TAX_EXCLUSIVE",
            shippingBaseAmount: 0n,
            shippingTaxRateBps: 0,
            lines: [
              {
                lineId: "L-DAC",
                variantId: "VAR-DAC",
                quantity: 2,
                baseUnitPrice: 10_000n,
                taxRateBps: 1_000,
              },
            ],
          },
        },
        { idempotencyKey: "idem-chk-oms-1", store: wfStore }
      );
      assert.equal(chkRes.status, "COMPLETED");

      // OMS Edit #1: Increase quantity from 2 -> 4 (+2 units => +$220.00 incremental capture + +2 MSI stock)
      const editWf = buildEditOrderWorkflow({
        pgPool: pg,
        inventoryService: inv,
        paymentGateway: stripeStrategy,
        outboxService: outbox,
      });

      const editUp = await editWf.execute(
        {
          editId: "edit-up-1",
          orderId: "ord_chk-oms-edit-1",
          editedBy: "ops@kronos.io",
          reason: "Customer requested 2 additional units",
          lineMutations: [{ lineId: "L-DAC", variantId: "VAR-DAC", quantity: 4 }],
          paymentTokenForIncrementalCapture: "pm_card_visa_saved",
        },
        { idempotencyKey: "idem-edit-up-1", store: wfStore }
      );
      assert.equal(editUp.status, "COMPLETED");
      assert.equal(editUp.output?.settlementKind, "INCREMENTAL_CAPTURE");
      assert.equal(editUp.output?.deltaGrossAmount, 22_000n);
      assert.equal(editUp.output?.revisedGrossAmount, 44_000n);
      assert.equal((await inv.getSlot("WH-EAST", "VAR-DAC"))?.quantityAllocated, 4);

      // OMS Edit #2: Decrease quantity from 4 -> 1 (-3 units => -$330.00 partial refund, -3 MSI stock released!)
      // Wait: original pi3ds captured $220.00, so let's decrease from 4 -> 3 (-1 unit => -$110.00 partial refund on original PI!)
      const editDown = await editWf.execute(
        {
          editId: "edit-down-2",
          orderId: "ord_chk-oms-edit-1",
          editedBy: "ops@kronos.io",
          reason: "Customer reduced 1 unit before shipment",
          lineMutations: [{ lineId: "L-DAC", variantId: "VAR-DAC", quantity: 3 }],
        },
        { idempotencyKey: "idem-edit-down-2", store: wfStore }
      );
      assert.equal(editDown.status, "COMPLETED");
      assert.equal(editDown.output?.settlementKind, "PARTIAL_REFUND");
      assert.equal(editDown.output?.deltaGrossAmount, -11_000n);
      assert.equal(editDown.output?.revisedGrossAmount, 33_000n);
      assert.equal((await inv.getSlot("WH-EAST", "VAR-DAC"))?.quantityAllocated, 3);

      // Verify Double-Entry Subledger remains 100% balanced after Order + Incremental Edit + Partial Refund Edit!
      const subledger = new PgDoubleEntryLedgerService(pg);
      const tb = await subledger.getTrialBalance("USD");
      assert.equal(tb.isBalanced, true);
      assert.equal(tb.grandTotalDebits, tb.grandTotalCredits);
    } finally {
      await pg.close();
    }
  });
});
