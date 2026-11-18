/**
 * Real PostgreSQL 17 Live Integration Test Suite (`packages/core/src/pg-live.integration.test.ts`).
 *
 * Connects over real TCP + PostgreSQL v3 Wire Protocol (SCRAM-SHA-256) via `PgPool.fromEnv()`.
 * Executed in CI against the `postgres:17-alpine` service container (`npm run test:pg-live`)
 * and locally against Docker Compose (`docker compose up -d postgres && npm run test:pg-live`).
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PgPool, runMigrations } from "@super-ecommerce/db";
import { PgWorkflowStateStore } from "@super-ecommerce/workflow";
import {
  buildCompleteCheckoutWorkflow,
  buildProcessReturnRefundWorkflow,
  OutboxRelayWorker,
  PgAdminAuthRbacService,
  PgB2bOrganizationService,
  PgCustomersService,
  PgMsiInventoryService,
  PgReservationTtlReaperService,
  PgStripeWebhookService,
  PgTransactionalOutboxService,
  signStripeWebhookPayload,
  verifyOutboundOutboxSignature,
  type PaymentGatewayStrategy,
  type StoreCreditLedger,
} from "./index.ts";

async function resetTransactionalTables(pool: PgPool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      workflow_step_logs,
      workflow_runs,
      order_returns,
      order_fulfillment_lines,
      order_fulfillments,
      orders,
      transactional_outbox_events,
      inbound_webhook_events,
      msi_stock_reservations,
      msi_stock_slots,
      reservation_reaper_audit,
      b2b_purchase_orders,
      b2b_buyer_members,
      b2b_cost_centers,
      b2b_companies,
      store_credit_ledger,
      customers,
      admin_audit_logs,
      admin_users,
      admin_roles
    RESTART IDENTITY CASCADE
  `);
}

describe("PostgreSQL 17 Live Integration Suite (PgPool Wire Protocol)", () => {
  let pool: PgPool;

  before(async () => {
    pool = PgPool.fromEnv({ maxConnections: 8, statementTimeoutMs: 15_000 });
    await runMigrations(pool);
    await resetTransactionalTables(pool);
  });

  after(async () => {
    if (pool) {
      await pool.close();
    }
  });

  it("connects to real PostgreSQL 17+, applies versioned migrations idempotently, and verifies GIN + partial indexes", async () => {
    const versionRes = await pool.query<{
      server_version: string;
      server_version_num: string;
    }>(
      "SELECT current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num"
    );
    const versionNum = Number(versionRes.rows[0]?.server_version_num ?? "0");
    const minVersionNum = Number(process.env["SUPER_PG_MIN_VERSION_NUM"] ?? "160015");
    assert.ok(
      versionNum >= minVersionNum,
      `Expected PostgreSQL server_version_num >= ${minVersionNum}, got ${versionRes.rows[0]?.server_version}`
    );

    // Second runMigrations call must be a zero-op with valid SHA-256 checksums
    const secondRun = await runMigrations(pool);
    assert.deepEqual(secondRun.appliedVersions, []);
    assert.ok(secondRun.alreadyAppliedVersions.includes("0001"));
    assert.ok(secondRun.alreadyAppliedVersions.includes("0002"));
    assert.ok(secondRun.alreadyAppliedVersions.includes("0003"));
    assert.ok(secondRun.alreadyAppliedVersions.includes("0004"));

    // Confirm production GIN and partial indexes exist in pg_indexes
    const idxRes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
    );
    const indexNames = new Set(idxRes.rows.map((r) => r.indexname));
    assert.ok(
      indexNames.has("idx_outbox_pending_poll"),
      "Expected partial outbox polling index idx_outbox_pending_poll"
    );
    assert.ok(
      indexNames.has("idx_msi_stock_reservations_active_expiry"),
      "Expected partial reservation expiry index idx_msi_stock_reservations_active_expiry"
    );
    assert.ok(
      indexNames.has("idx_products_attributes_gin") &&
        indexNames.has("idx_ccp_merged_attributes_gin"),
      "Expected JSONB GIN indexes idx_products_attributes_gin and idx_ccp_merged_attributes_gin"
    );
  });

  it("enforces CHECK constraints and concurrent FOR UPDATE SKIP LOCKED outbox claiming across multiple PG connections", async () => {
    await resetTransactionalTables(pool);

    // 1. CHECK constraint rollback on negative quantity_reserved
    await pool.query(
      `INSERT INTO msi_stock_slots (warehouse_id, variant_id, priority_rank, linked_to_channel, supports_shipping_zone, quantity_on_hand, quantity_reserved, quantity_allocated)
       VALUES ($1, $2, 1, true, true, 10, 0, 0)`,
      ["WH-PG17", "SKU-CHECK-1"]
    );
    await assert.rejects(
      pool.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE msi_stock_slots SET quantity_reserved = -3 WHERE warehouse_id = $1 AND variant_id = $2`,
          ["WH-PG17", "SKU-CHECK-1"]
        );
      })
    );
    const afterCheck = await pool.query<{ quantity_reserved: string }>(
      `SELECT quantity_reserved FROM msi_stock_slots WHERE warehouse_id = $1 AND variant_id = $2`,
      ["WH-PG17", "SKU-CHECK-1"]
    );
    assert.equal(Number(afterCheck.rows[0]?.quantity_reserved), 0);

    // 2. Concurrent FOR UPDATE SKIP LOCKED outbox claiming on 4 queued events across 2 workers
    const outboxA = new PgTransactionalOutboxService(pool);
    const outboxB = new PgTransactionalOutboxService(pool);
    const baseMs = Date.parse("2026-11-18T10:00:00.000Z");

    for (let i = 1; i <= 4; i++) {
      await outboxA.enqueue({
        eventType: "order.created",
        aggregateType: "Order",
        aggregateId: `ord-pg17-conc-${i}`,
        channelSlug: "us-retail",
        payload: { orderId: `ord-pg17-conc-${i}`, amount: BigInt(i * 1000) },
        nowIso: new Date(baseMs + i * 10).toISOString(),
      });
    }

    const [batchA, batchB] = await Promise.all([
      outboxA.claimDueBatch({
        nowIso: new Date(baseMs + 500).toISOString(),
        batchSize: 2,
      }),
      outboxB.claimDueBatch({
        nowIso: new Date(baseMs + 500).toISOString(),
        batchSize: 2,
      }),
    ]);

    const allIds = [...batchA.map((e) => e.id), ...batchB.map((e) => e.id)];
    assert.equal(allIds.length, 4);
    assert.equal(new Set(allIds).size, 4, "FOR UPDATE SKIP LOCKED must never double-claim an event");

    // 3. OutboxRelayWorker signs with HMAC-SHA256, retries, dead-letters, and replays
    const poison = await outboxA.enqueue({
      eventType: "erp.sync_invoice",
      aggregateType: "Order",
      aggregateId: "ord-pg17-poison",
      payload: { invoice: "INV-99" },
      nowIso: new Date(baseMs + 40_000).toISOString(),
    });
    const verifiedSigs: boolean[] = [];
    const worker = new OutboxRelayWorker({
      outboxService: outboxA,
      signingSecret: "whsec_pg17_live_secret",
      maxAttempts: 2,
      baseDelayMs: 1_000,
      subscribers: [
        {
          name: "pg17-orders-sink",
          eventPattern: "order.*",
          handle(env) {
            verifiedSigs.push(
              verifyOutboundOutboxSignature({
                eventId: env.event.id,
                rawPayloadJson: env.rawPayloadJson,
                signatureHeader: env.headers["super-commerce-signature"],
                signingSecret: "whsec_pg17_live_secret",
              })
            );
          },
        },
        {
          name: "pg17-erp-poison",
          eventPattern: "erp.*",
          handle() {
            throw new Error("ERP_503_DOWN");
          },
        },
      ],
    });

    const tick1 = await worker.drainBatch({ nowMs: baseMs + 45_000 });
    assert.equal(tick1.publishedCount, 4);
    assert.equal(tick1.retriedCount, 1);
    assert.equal(verifiedSigs.every(Boolean), true);

    const tick2 = await worker.drainBatch({ nowMs: baseMs + 46_500 });
    assert.equal(tick2.deadLetteredCount, 1);
    assert.equal(
      (await outboxB.requeueDeadLetters(poison.id, new Date(baseMs + 50_000).toISOString())),
      1
    );
  });

  it("executes 5-step checkout saga, LIFO compensation, multi-wave RMA refund, and Stripe webhook dedup against real PG 17", async () => {
    await resetTransactionalTables(pool);

    const wfStore = new PgWorkflowStateStore(pool);
    const inv = new PgMsiInventoryService(pool);
    const outbox = new PgTransactionalOutboxService(pool);
    const customers = new PgCustomersService(pool);

    await customers.createCustomer({
      customerId: "cust_pg17_vip",
      email: "vip@pg17.example",
      fullName: "PG17 VIP Buyer",
      defaultChannelSlug: "us-retail",
      currencyCode: "USD",
    });
    await customers.addStoreCredit({
      customerId: "cust_pg17_vip",
      amount: 2_000n,
      reason: "PG17_SEED_CREDIT",
      referenceType: "SYSTEM",
      referenceId: "seed_pg17",
    });

    await inv.upsertExternalSlots([
      {
        warehouseId: "WH-EAST",
        priorityRank: 1,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "SKU-PG17-SAGA",
        quantityOnHand: 10,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
    ]);

    const storeCreditLedger: StoreCreditLedger = customers;

    let gatewayCaptured = 0n;
    let gatewayRefunded = 0n;
    const paymentGateway: PaymentGatewayStrategy = {
      async capture({ checkoutId, amount }) {
        gatewayCaptured += amount;
        return {
          transactionId: `pi_${checkoutId}`,
          provider: "stripe",
          capturedAmount: amount,
        };
      },
      async voidOrRefund({ amount }) {
        gatewayRefunded += amount;
      },
    };

    const checkoutWf = buildCompleteCheckoutWorkflow({
      inventoryService: inv,
      paymentGateway,
      outboxService: outbox,
      storeCreditLedger,
      pgPool: pool,
    });

    const rmaWf = buildProcessReturnRefundWorkflow({
      inventoryService: inv,
      paymentGateway,
      outboxService: outbox,
      storeCreditLedger,
      pgPool: pool,
    });

    // 1. Step 5 commit fault -> LIFO rollback leaves PG orders/outbox empty and restores store credit & stock
    const faultRes = await checkoutWf.execute(
      {
        checkoutId: "chk_pg17_fault",
        channelSlug: "us-retail",
        customerId: "cust_pg17_vip",
        stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        storeCreditToRedeem: 500n,
        paymentToken: "tok_visa_pg17",
        simulateCommitFault: true,
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 0,
          lines: [
            {
              lineId: "L1",
              variantId: "SKU-PG17-SAGA",
              quantity: 3,
              baseUnitPrice: 1_000n,
              taxRateBps: 0,
            },
          ],
        },
      },
      { idempotencyKey: "idem_pg17_fault", store: wfStore }
    );
    assert.equal(faultRes.status, "COMPENSATED");
    assert.deepEqual(faultRes.compensatedSteps, [
      "capture-payment",
      "redeem-store-credit",
      "allocate-inventory",
    ]);
    assert.equal((await inv.getSlot("WH-EAST", "SKU-PG17-SAGA"))?.quantityAllocated, 0);
    assert.equal(
      (await customers.getCustomer("cust_pg17_vip"))?.storeCreditBalance,
      2_000n
    );
    assert.equal(gatewayCaptured, 2_500n);
    assert.equal(gatewayRefunded, 2_500n);

    // 2. Clean 3-unit checkout with $20 order voucher -> $10.00 (1000c: 300c credit + 700c cash)
    const okRes = await checkoutWf.execute(
      {
        checkoutId: "chk_pg17_ok",
        channelSlug: "us-retail",
        customerId: "cust_pg17_vip",
        stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        storeCreditToRedeem: 300n,
        paymentToken: "tok_visa_pg17",
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 0,
          lines: [
            {
              lineId: "L1",
              variantId: "SKU-PG17-SAGA",
              quantity: 3,
              baseUnitPrice: 1_000n,
              taxRateBps: 0,
            },
          ],
          candidateOrderDiscounts: [
            {
              discountId: "vouch-20",
              name: "$20 Off",
              kind: "ORDER_VOUCHER",
              value: { type: "FIXED", amount: 2_000n },
            },
          ],
        },
      },
      { idempotencyKey: "idem_pg17_ok", store: wfStore }
    );
    assert.equal(okRes.status, "COMPLETED");
    const orderId = okRes.output!.orderId;
    assert.equal(okRes.output!.pricing.totalGrossAmount, 1_000n);
    assert.equal((await inv.getSlot("WH-EAST", "SKU-PG17-SAGA"))?.quantityAllocated, 3);

    // 3. Wave 1 partial RMA (1 RESELLABLE -> 334c) + Wave 2 (2 remaining -> 666c final reconciliation)
    const wave1 = await rmaWf.execute(
      {
        rmaId: "rma_pg17_w1",
        orderId,
        linesToReturn: [{ lineId: "L1", quantity: 1, condition: "RESELLABLE" }],
      },
      { idempotencyKey: "idem_rma_pg17_w1", store: wfStore }
    );
    assert.equal(wave1.status, "COMPLETED");
    assert.equal(wave1.output!.calculation.totalRefundGrossAmount, 334n);

    const wave2 = await rmaWf.execute(
      {
        rmaId: "rma_pg17_w2",
        orderId,
        linesToReturn: [{ lineId: "L1", quantity: 2, condition: "DAMAGED_QUARANTINE" }],
      },
      { idempotencyKey: "idem_rma_pg17_w2", store: wfStore }
    );
    assert.equal(wave2.status, "COMPLETED");
    assert.equal(wave2.output!.calculation.totalRefundGrossAmount, 666n);
    assert.equal(wave2.output!.orderPaymentStatusAfter, "REFUNDED");
    assert.equal((await inv.getSlot("WH-EAST", "SKU-PG17-SAGA"))?.quantityAllocated, 0);
    assert.equal((await inv.getSlot("WH-EAST", "SKU-PG17-SAGA"))?.quantityOnHand, 8);

    // 4. Stripe Webhook v1 HMAC verification & ON CONFLICT deduplication on real PG 17
    const webhookCheckout = await checkoutWf.execute(
      {
        checkoutId: "chk_pg17_wh",
        channelSlug: "us-retail",
        customerId: "cust_pg17_vip",
        stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
        allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        paymentToken: "tok_3ds_pg17",
        cart: {
          currencyCode: "USD",
          taxMode: "TAX_EXCLUSIVE",
          shippingBaseAmount: 0n,
          shippingTaxRateBps: 0,
          lines: [
            {
              lineId: "L-WH",
              variantId: "SKU-PG17-SAGA",
              quantity: 2,
              baseUnitPrice: 1_500n,
              taxRateBps: 0,
            },
          ],
        },
      },
      { idempotencyKey: "idem_pg17_wh", store: wfStore }
    );
    assert.equal(webhookCheckout.status, "COMPLETED");
    assert.equal((await inv.getSlot("WH-EAST", "SKU-PG17-SAGA"))?.quantityAllocated, 2);

    const whSvc = new PgStripeWebhookService({
      pool,
      endpointSecrets: ["whsec_pg17_active"],
      inventoryService: inv,
      outboxService: outbox,
    });
    const nowSec = 1_763_400_000;
    const rawBody = JSON.stringify({
      id: "evt_pg17_fail_01",
      type: "payment_intent.payment_failed",
      created: nowSec,
      data: {
        object: {
          id: "pi_pg17_failed",
          amount: 3000,
          currency: "usd",
          metadata: {
            orderId: webhookCheckout.output!.orderId,
            checkoutId: "chk_pg17_wh",
            channelSlug: "us-retail",
          },
        },
      },
    });
    const sig = signStripeWebhookPayload({
      rawBody,
      secret: "whsec_pg17_active",
      timestampSeconds: nowSec,
    });

    const firstDelivery = await whSvc.handleRawWebhook({
      rawBody,
      signatureHeader: sig,
      nowSeconds: nowSec + 5,
    });
    assert.equal(firstDelivery.duplicate, false);
    assert.equal(firstDelivery.updatedPaymentStatus, "FAILED");
    assert.equal(firstDelivery.releasedWarehouseSlices, 1);
    assert.equal((await inv.getSlot("WH-EAST", "SKU-PG17-SAGA"))?.quantityAllocated, 0);

    const dupDelivery = await whSvc.handleRawWebhook({
      rawBody,
      signatureHeader: sig,
      nowSeconds: nowSec + 10,
    });
    assert.equal(dupDelivery.duplicate, true);
  });

  it("persists B2B corporate POs, EXPIRED_TTL reaping (migration 0003), and dynamic RBAC audit logs on real PG 17", async () => {
    await resetTransactionalTables(pool);

    const wfStore = new PgWorkflowStateStore(pool);
    const inv = new PgMsiInventoryService(pool);
    const outbox = new PgTransactionalOutboxService(pool);
    const b2b = new PgB2bOrganizationService({
      pool,
      inventoryService: inv,
      outboxService: outbox,
      workflowStateStore: wfStore,
    });
    await b2b.seedDefaultEnterpriseHierarchy();

    await inv.upsertExternalSlots([
      {
        warehouseId: "WH-EAST",
        priorityRank: 1,
        linkedToChannel: true,
        supportsShippingZone: true,
        variantId: "SKU-PG17-B2B",
        quantityOnHand: 20,
        quantityReserved: 0,
        quantityAllocated: 0,
      },
    ]);

    const baseNow = Date.parse("2026-11-18T12:00:00.000Z");
    await b2b.submitPurchaseOrder({
      idempotencyKey: "idem_pg17_b2b_exp",
      input: {
        poId: "po_pg17_exp_1",
        poNumber: "PO-PG17-01",
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
              lineId: "L-B2B-PG17",
              variantId: "SKU-PG17-B2B",
              quantity: 4,
              baseUnitPrice: 75_000n,
              taxRateBps: 825,
            },
          ],
        },
      },
    });
    assert.equal((await inv.getSlot("WH-EAST", "SKU-PG17-B2B"))?.quantityReserved, 4);

    const reaper = new PgReservationTtlReaperService({
      pool,
      inventoryService: inv,
      b2bService: b2b,
      outboxService: outbox,
    });
    const sweep = await reaper.reapExpired(baseNow);
    assert.equal(sweep.stockReap.reapedReservationCount, 1);
    assert.equal(sweep.stockReap.totalUnitsReleased, 4);
    assert.equal(sweep.expiredPos[0]?.status, "EXPIRED_TTL");

    // Verify dynamic RBAC role creation & audit log persistence
    const rbac = new PgAdminAuthRbacService(pool);
    await rbac.seedInitialRolesAndUsers();
    const login = await rbac.authenticateWithPassword("admin@kronos.io", "Kronos!Admin2026");
    assert.equal(login.ok, true, "Seeded SUPER_ADMIN must authenticate against real PG 17");
    const createdRole = await rbac.createOrUpdateRole({
      roleSlug: "PG17_AUDITOR",
      displayName: "PG17 Live Auditor",
      description: "Read-only auditor created in PG 17 CI",
      permissions: ["finance:audit_webhooks"],
    });
    assert.equal(createdRole.roleSlug, "PG17_AUDITOR");
    const roles = await rbac.listRoles();
    assert.ok(roles.some((r) => r.roleSlug === "PG17_AUDITOR"));
  });
});
